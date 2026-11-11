"""Cliente do Botão Físico no Raspberry Pi para o Simulador ESP32 no Mac.

Este script conecta o botão externo do Raspberry Pi ao simulador:
  1. Realiza handshake com o servidor no Mac (exibe tela de confirmação no terminal e no frontend)
  2. Mantém heartbeat ativo para indicar que o Raspberry está online
  3. Monitora o botão físico (ou modo --test) e envia eventos de pressionar/soltar

Ligação física recomendada:
  - Botão no Pino Físico 32 (BOARD 32 / BCM GPIO 12)
  - Outro terminal do botão no Pino Físico 34 ou 30 (GND)

Uso no Raspberry Pi:
  python3 raspberry_botao.py --server http://<IP_DO_MAC>:8765 --pin 32
  python3 raspberry_botao.py --server http://<IP_DO_MAC>:8765 --interactive
  python3 raspberry_botao.py --server http://<IP_DO_MAC>:8765 --test
"""

from __future__ import annotations

import argparse
import json
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

STOP_EVENT = threading.Event()


def get_local_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except OSError:
        return "127.0.0.1"


def post_json(url: str, payload: dict[str, object], timeout: float = 3.0) -> dict[str, object] | None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.URLError as exc:
        print(f"[ERRO DE REDE] Falha ao comunicar com {url}: {exc}")
        return None
    except json.JSONDecodeError:
        return None


def realizar_handshake(server_url: str, pin: int) -> bool:
    endpoint = server_url.rstrip("/") + "/api/raspberry/connect"
    payload = {
        "hostname": socket.gethostname(),
        "ip": get_local_ip(),
        "pin": pin,
        "model": "Raspberry Pi",
        "clientTimestamp": time.time(),
    }

    print(f"\nConectando ao simulador no Mac ({endpoint})...")
    res = post_json(endpoint, payload, timeout=4.0)
    if not res or not res.get("ok"):
        print("[FALHA] Nao foi possivel conectar ao simulador no Mac.")
        print("Verifique se o Mac e o Raspberry Pi estao na mesma rede Wi-Fi/cabo")
        print(f"e se o servidor esta rodando no Mac em: {server_url}\n")
        return False

    dev = res.get("device", {})
    print("\n" + "=" * 65)
    print("  [✓] CONFIRMAÇÃO: RASPBERRY PI CONECTADO AO SIMULADOR COM SUCESSO!")
    print(f"  • Servidor no Mac:    {server_url}")
    print(f"  • Dispositivo:        {dev.get('hostname')} ({dev.get('ip')})")
    print(f"  • Pino GPIO do Botão: BCM {pin}")
    print("  • Status da Ponte:    ONLINE (Confirmado na tela do frontend)")
    print("=" * 65)
    print("Pressione o botão físico para enviar o sinal para o simulador.")
    print("Pressione Ctrl+C para encerrar a conexão.\n")
    return True


def iniciar_heartbeat(server_url: str) -> None:
    endpoint = server_url.rstrip("/") + "/api/raspberry/ping"

    def worker():
        while not STOP_EVENT.is_set():
            time.sleep(8.0)
            if STOP_EVENT.is_set():
                break
            post_json(endpoint, {"timestamp": time.time()}, timeout=2.5)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()


def enviar_evento_botao(server_url: str, pressed: bool, pin: int) -> None:
    endpoint = server_url.rstrip("/") + "/api/button"
    estado_str = "PRESSIONADO (LOW)" if pressed else "SOLTO (HIGH)"
    payload = {
        "pressed": pressed,
        "action": "down" if pressed else "up",
        "source": f"Raspberry Pi ({socket.gethostname()})",
        "pin": pin,
        "timestamp": time.time(),
    }

    hora = time.strftime("%H:%M:%S")
    res = post_json(endpoint, payload, timeout=2.5)
    if res and res.get("ok"):
        ack = res.get("ack", "RECEBIDO")
        print(f"[{hora}] [✓ MAC CONFIRMOU - {ack}] Botao {estado_str} no GPIO {pin} -> ESP32 GPIO 32")
    else:
        print(f"[{hora}] [!] Tentativa de envio {estado_str} nao confirmada pelo Mac.")


def resolve_pin_config(pin: int) -> tuple[str, int, int]:
    """Resolve a identificação do pino físico ou lógico no Raspberry Pi.
    
    No Raspberry Pi (conector de 40 pinos):
    - Se o usuário conectar na porta física 32 (Pino 32):
      corresponde ao BCM GPIO 12 (ao lado do pino 34 GND).
    - Para pinos <= 27: é o número BCM direto.
    """
    if pin == 32:
        return "board32", 12, 32
    return "bcm", pin, pin


def rodar_com_gpiozero(server_url: str, pin: int) -> None:
    from gpiozero import Button  # type: ignore

    modo, gz_pin, _ = resolve_pin_config(pin)
    if modo == "board32":
        print("Configurando botao no Pino Fisico 32 (GPIO BCM 12) do Raspberry Pi (gpiozero)...")
    else:
        print(f"Escutando eventos de hardware no GPIO BCM {pin} (gpiozero)...")

    botao = Button(gz_pin, pull_up=True, bounce_time=0.05)
    botao.when_pressed = lambda: enviar_evento_botao(server_url, True, pin)
    botao.when_released = lambda: enviar_evento_botao(server_url, False, pin)

    print(f"Pronto! Pressione o botao no pino {pin} para disparar no simulador.")
    signal.pause()


def rodar_com_rpi_gpio(server_url: str, pin: int) -> None:
    import RPi.GPIO as GPIO  # type: ignore

    modo, _, rpi_pin = resolve_pin_config(pin)
    if modo == "board32":
        print("Configurando botao no Pino Fisico 32 (modo BOARD) do Raspberry Pi (RPi.GPIO)...")
        GPIO.setmode(GPIO.BOARD)
        pino_alvo = 32
    else:
        print(f"Escutando eventos de hardware no GPIO BCM {pin} (RPi.GPIO)...")
        GPIO.setmode(GPIO.BCM)
        pino_alvo = pin

    GPIO.setup(pino_alvo, GPIO.IN, pull_up_down=GPIO.PUD_UP)
    ultimo_estado = GPIO.input(pino_alvo)
    print(f"Pronto! Pressione o botao no pino {pin} para disparar no simulador.")

    try:
        while not STOP_EVENT.is_set():
            atual = GPIO.input(pino_alvo)
            if atual != ultimo_estado:
                time.sleep(0.05)  # debounce
                confirmado = GPIO.input(pino_alvo)
                if confirmado != ultimo_estado:
                    ultimo_estado = confirmado
                    enviar_evento_botao(server_url, confirmado == GPIO.LOW, pin)
            time.sleep(0.01)
    finally:
        GPIO.cleanup(pino_alvo)


def rodar_modo_interativo(server_url: str, pin: int) -> None:
    print("\n" + "=" * 60)
    print("  MODO INTERATIVO (SEM HARDWARE / VIA TECLADO)")
    print("  • Pressione [ENTER]:      Segurar botão por 3.2s e DISPARAR ALERTA")
    print("  • Digite 'g' + [ENTER]:   Clique rápido (Leitura de GPS apenas)")
    print("  • Digite 'q' ou Ctrl+C:   Sair e desconectar")
    print("=" * 60 + "\n")
    try:
        while not STOP_EVENT.is_set():
            cmd = input("Pressione [ENTER] para disparar alerta ('g'=GPS, 'q'=Sair) > ").strip().lower()
            if cmd == "q":
                break
            elif cmd == "g":
                print("-> Enviando clique rapido de GPS...")
                endpoint = server_url.rstrip("/") + "/api/button"
                post_json(
                    endpoint,
                    {
                        "action": "click",
                        "pressed": True,
                        "source": f"Raspberry Pi ({socket.gethostname()})",
                        "pin": pin,
                        "timestamp": time.time(),
                    },
                )
                print("-> Clique rapido confirmado pelo simulador!\n")
            else:
                print("-> Pressionando botao por 3.2s (Disparando Alarme de Panico no Mac)...")
                enviar_evento_botao(server_url, True, pin)
                time.sleep(3.2)
                enviar_evento_botao(server_url, False, pin)
                print("-> Botao liberado! Alerta completo enviado com sucesso!\n")
                        "pin": pin,
                        "timestamp": time.time(),
                    },
                )
                print("-> Clique rapido confirmado pelo simulador!\n")
    except (EOFError, KeyboardInterrupt):
        pass


def rodar_teste_simulado(server_url: str, pin: int) -> None:
    print("\n[MODO TESTE] Simulando acionamento do botao fisico pelo Raspberry Pi...")
    time.sleep(1.0)
    print("-> Pressionando botao por 3.2 segundos (alerta de panico completo)...")
    enviar_evento_botao(server_url, True, pin)
    time.sleep(3.2)
    enviar_evento_botao(server_url, False, pin)
    print("-> Botao liberado. Teste concluido com sucesso!")


def main() -> None:
    parser = argparse.ArgumentParser(description="Cliente do botao Raspberry Pi com handshake de confirmacao")
    parser.add_argument("--server", required=True, help="URL do simulador no Mac, ex: http://172.30.230.186:8765")
    parser.add_argument(
        "--pin",
        type=int,
        default=32,
        help="Pino do botao (padrao: 32 - Pino fisico 32 / BCM 12 no Raspberry -> GPIO 32 no ESP32)",
    )
    parser.add_argument("--test", action="store_true", help="Executa teste simulado de 3.2s sem hardware")
    parser.add_argument("--interactive", action="store_true", help="Modo interativo pelo teclado")
    args = parser.parse_args()

    server_url = args.server.rstrip("/")

    # 1. Handshake inicial com tela de confirmação
    if not realizar_handshake(server_url, args.pin):
        sys.exit(1)

    # 2. Inicia heartbeat em background
    iniciar_heartbeat(server_url)

    # 3. Execução
    try:
        if args.test:
            rodar_teste_simulado(server_url, args.pin)
            print("\nAguardando 5 segundos antes de encerrar...")
            time.sleep(5.0)
            return

        if args.interactive:
            rodar_modo_interativo(server_url, args.pin)
            return

        try:
            rodar_com_gpiozero(server_url, args.pin)
        except ImportError:
            try:
                rodar_com_rpi_gpio(server_url, args.pin)
            except ImportError:
                print("\n[AVISO] Nenhuma biblioteca de GPIO de hardware (gpiozero/RPi.GPIO) encontrada.")
                print("Iniciando automaticamente o modo interativo via teclado...")
                rodar_modo_interativo(server_url, args.pin)
    except KeyboardInterrupt:
        print("\nEncerrando conexao com o simulador...")
    finally:
        STOP_EVENT.set()
        post_json(server_url + "/api/raspberry/disconnect", {}, timeout=1.5)
        print("Desconectado do simulador.")


if __name__ == "__main__":
    main()
