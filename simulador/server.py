"""Servidor HTTP + SSE local para o simulador do protótipo ESP32 com entrada externa do Raspberry Pi."""

from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import socket
import sys
import threading
import time
import webbrowser

CLIENTS_LOCK = threading.Lock()
SSE_CLIENTS: set[queue.Queue[str]] = set()

STATE_LOCK = threading.Lock()
LAST_EVENT: dict[str, object] = {
    "pressed": False,
    "source": "none",
    "timestamp": None,
}
EVENT_HISTORY: list[dict[str, object]] = []

DEVICE_LOCK = threading.Lock()
ACTIVE_DEVICE: dict[str, object] | None = None


def get_lan_ips() -> list[str]:
    ips: list[str] = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127."):
            ips.append(ip)
    except OSError:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return ips


def broadcast_event(payload: dict[str, object]) -> int:
    message = f"data: {json.dumps(payload)}\n\n"
    dead: list[queue.Queue[str]] = []
    with CLIENTS_LOCK:
        for client_queue in SSE_CLIENTS:
            try:
                client_queue.put_nowait(message)
            except queue.Full:
                dead.append(client_queue)
        for client_queue in dead:
            SSE_CLIENTS.discard(client_queue)
        return len(SSE_CLIENTS)


class SimulatorHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        if args and str(args[0]).startswith("GET /api/events"):
            return
        super().log_message(format, *args)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, status: int, data: dict[str, object]) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/status":
            with CLIENTS_LOCK:
                clients = len(SSE_CLIENTS)
            with STATE_LOCK:
                last = dict(LAST_EVENT)
            with DEVICE_LOCK:
                device = dict(ACTIVE_DEVICE) if ACTIVE_DEVICE else None
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "clients": clients,
                    "lastEvent": last,
                    "device": device,
                    "lanIps": get_lan_ips(),
                },
            )
            return

        if self.path == "/api/raspberry/status":
            with DEVICE_LOCK:
                device = dict(ACTIVE_DEVICE) if ACTIVE_DEVICE else None
            with STATE_LOCK:
                history = list(EVENT_HISTORY[-30:])
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "connected": device is not None,
                    "device": device,
                    "history": history,
                    "lanIps": get_lan_ips(),
                },
            )
            return

        if self.path == "/api/events":
            client_queue: queue.Queue[str] = queue.Queue(maxsize=64)
            with CLIENTS_LOCK:
                SSE_CLIENTS.add(client_queue)

            self.send_response(HTTPStatus.OK)
            self.send_cors_headers()
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            try:
                with DEVICE_LOCK:
                    device = dict(ACTIVE_DEVICE) if ACTIVE_DEVICE else None
                hello = {
                    "type": "connected",
                    "timestamp": time.time(),
                    "device": device,
                }
                self.wfile.write(f"data: {json.dumps(hello)}\n\n".encode("utf-8"))
                self.wfile.flush()

                while True:
                    try:
                        msg = client_queue.get(timeout=15)
                        self.wfile.write(msg.encode("utf-8"))
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                with CLIENTS_LOCK:
                    SSE_CLIENTS.discard(client_queue)
            return

        if self.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "JSON invalido"})
            return

        if not isinstance(data, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Payload deve ser objeto JSON"})
            return

        # 1. Rota de Conexão do Raspberry Pi
        if self.path == "/api/raspberry/connect":
            client_ip = self.client_address[0]
            hostname = str(data.get("hostname", "raspberrypi"))
            pi_ip = str(data.get("ip", client_ip))
            pin = data.get("pin", 17)
            model = str(data.get("model", "Raspberry Pi"))

            with DEVICE_LOCK:
                global ACTIVE_DEVICE
                ACTIVE_DEVICE = {
                    "hostname": hostname,
                    "ip": pi_ip,
                    "pin": pin,
                    "model": model,
                    "connectedAt": time.time(),
                    "lastPing": time.time(),
                    "clientIp": client_ip,
                }
                device_snapshot = dict(ACTIVE_DEVICE)

            broadcast_event({"type": "rpi_connected", "device": device_snapshot, "timestamp": time.time()})
            print(f"[RPI CONECTADO] Hostname: {hostname} ({pi_ip}) - Botao GPIO {pin}")

            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "confirmed": True,
                    "message": "Raspberry Pi conectado com sucesso!",
                    "device": device_snapshot,
                    "serverTimestamp": time.time(),
                },
            )
            return

        # 2. Rota de Ping / Heartbeat
        if self.path == "/api/raspberry/ping":
            with DEVICE_LOCK:
                if ACTIVE_DEVICE:
                    ACTIVE_DEVICE["lastPing"] = time.time()
                    device_snapshot = dict(ACTIVE_DEVICE)
                else:
                    device_snapshot = None

            if device_snapshot:
                broadcast_event({"type": "rpi_ping", "device": device_snapshot, "timestamp": time.time()})

            self.send_json(HTTPStatus.OK, {"ok": True, "pong": True, "timestamp": time.time()})
            return

        # 3. Rota de Desconexão
        if self.path == "/api/raspberry/disconnect":
            with DEVICE_LOCK:
                ACTIVE_DEVICE = None
            broadcast_event({"type": "rpi_disconnected", "timestamp": time.time()})
            print("[RPI DESCONECTADO]")
            self.send_json(HTTPStatus.OK, {"ok": True, "disconnected": True})
            return

        # 4. Rota do Botão
        if self.path != "/api/button":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Rota nao encontrada"})
            return

        action = data.get("action")
        pressed = data.get("pressed")
        source = str(data.get("source", "Raspberry Pi"))
        pin = data.get("pin", 17)

        if action == "click":
            event: dict[str, object] = {
                "type": "button",
                "action": "click",
                "pressed": True,
                "source": source,
                "pin": pin,
                "timestamp": time.time(),
            }
        elif isinstance(pressed, bool) or action in ("down", "up"):
            is_pressed = pressed if isinstance(pressed, bool) else (action == "down")
            event = {
                "type": "button",
                "action": "down" if is_pressed else "up",
                "pressed": is_pressed,
                "source": source,
                "pin": pin,
                "timestamp": time.time(),
            }
        else:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {
                    "ok": False,
                    "error": "Informe 'pressed' (true/false) ou 'action' ('down', 'up', 'click')",
                },
            )
            return

        with STATE_LOCK:
            LAST_EVENT.update(
                {
                    "pressed": event["pressed"],
                    "action": event["action"],
                    "source": source,
                    "pin": pin,
                    "timestamp": event["timestamp"],
                }
            )
            EVENT_HISTORY.append(
                {
                    "action": event["action"],
                    "pressed": event["pressed"],
                    "source": source,
                    "pin": pin,
                    "timestamp": event["timestamp"],
                }
            )
            if len(EVENT_HISTORY) > 50:
                EVENT_HISTORY.pop(0)

        with DEVICE_LOCK:
            if ACTIVE_DEVICE:
                ACTIVE_DEVICE["lastPing"] = time.time()

        clients = broadcast_event(event)
        self.send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "ack": "CONFIRMADO_NO_MAC",
                "message": f"Sinal {event['action'].upper()} recebido e acionado na simulacao!",
                "clients": clients,
                "event": event,
            },
        )


def free_port(port: int) -> None:
    """Libera a porta se outro processo local anterior estiver segurando."""
    try:
        import os
        import subprocess

        res = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
        pids = [int(p) for p in res.stdout.strip().split() if p.isdigit()]
        my_pid = os.getpid()
        killed_any = False
        for pid in pids:
            if pid != my_pid:
                try:
                    os.kill(pid, 15)  # SIGTERM
                    killed_any = True
                except OSError:
                    pass
        if killed_any:
            time.sleep(0.6)
    except Exception:
        pass


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Servidor HTTP + SSE para o simulador ESP32")
    parser.add_argument("--port", "-p", type=int, default=8765, help="Porta TCP (padrao: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="Nao abrir o navegador automaticamente")
    parser.add_argument("--keep-existing", action="store_true", help="Nao tentar encerrar processo anterior na porta")
    args, unknown = parser.parse_known_args()

    # Se um argumento posicional de porta foi passado (ex: python server.py 8765)
    for u in unknown:
        if u.isdigit():
            args.port = int(u)
            break

    sim_dir = Path(__file__).resolve().parent
    handler = partial(SimulatorHandler, directory=str(sim_dir))

    if not args.keep_existing:
        free_port(args.port)

    server = None
    for candidate in (args.port, 0):
        try:
            server = ThreadingHTTPServer(("0.0.0.0", candidate), handler)
            break
        except OSError:
            continue

    if server is None:
        raise RuntimeError(f"Nao foi possivel iniciar o servidor HTTP local na porta {args.port}.")

    actual_port = server.server_address[1]
    local_url = f"http://127.0.0.1:{actual_port}/index.html"
    lan_ips = get_lan_ips()

    print("\n" + "=" * 65)
    print("  [✓] SERVIDOR DO SIMULADOR ESP32 ATIVO E PRONTO")
    print(f"  • Interface Web (Mac):        {local_url}")
    if lan_ips:
        for ip in lan_ips:
            print(f"  • Endpoint Raspberry Pi:      http://{ip}:{actual_port}/api/button")
            print(f"  • Handshake Raspberry Pi:     http://{ip}:{actual_port}/api/raspberry/connect")
    else:
        print(f"  • Endpoint Raspberry Pi:      http://<IP_DO_MAC>:{actual_port}/api/button")
    print("=" * 65)
    print("Pressione Ctrl+C para encerrar o servidor.\n")

    if not args.no_browser:
        webbrowser.open(local_url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSimulador encerrado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
