# BSM — Botão de Segurança da Mulher (ESP32 + GPS NEO-6M + GSM SIM800L + Raspberry Pi)

Protótipo de dispositivo IoT vestível de proteção e emergência para vítimas de violência doméstica (Medida Protetiva / Lei Maria da Penha), acompanhado de um **simulador interativo de bancada em tempo real** e integração com botão externo no **Raspberry Pi**.

---

## 📋 Sumário
- [Visão Geral](#-visão-geral)
- [Mapeamento de Pinos e Hardware](#-mapeamento-de-pinos-e-hardware)
- [Arquitetura do Projeto](#-arquitetura-do-projeto)
- [Como Executar o Simulador Local](#-como-executar-o-simulador-local)
- [Como Conectar o Botão no Raspberry Pi](#-como-conectar-o-botão-no-raspberry-pi)
- [Como Gravar no ESP32 Físico](#-como-gravar-no-esp32-físico)
- [Fluxo de Emergência e Comandos AT](#-fluxo-de-emergência-e-comandos-at)

---

## 🛡️ Visão Geral

O sistema tem como objetivo prover socorro imediato, silencioso e confiável:
1. A usuária segura o **botão de pânico por 3 segundos** (filtro de segurança anti-falso-positivo).
2. O sistema realiza a leitura imediata das coordenadas geográficas via satélites (**GPS NEO-6M**).
3. O módulo de telefonia celular (**GSM SIM800L**) formula e envia uma mensagem de texto (SMS) de socorro com a identificação da vítima e o link exato do **Google Maps** para o número de emergência pré-configurado.
4. O **motor de vibração táctil (vibracall)** vibra por 1000ms confirmando silenciosamente à vítima que o pedido de socorro foi despachado com sucesso.

---

## 📌 Mapeamento de Pinos e Hardware

### 1. ESP32 (Firmware `bsm.ino`)
| Periférico | Pino no ESP32 | Tipo / Modo | Descrição |
| :--- | :--- | :--- | :--- |
| **Botão de Pânico** | `GPIO 32` | `INPUT_PULLUP` | Acionamento ativo em nível lógico `LOW` (retenção de 3s) |
| **Motor Vibracall** | `GPIO 13` | `OUTPUT` | Pulso de confirmação táctil de 1000ms |
| **GPS NEO-6M RX** | `GPIO 4` | UART2 (HardwareSerial) | Comunica com o TX do GPS @ 9600 baud |
| **GPS NEO-6M TX** | `GPIO 5` | UART2 (HardwareSerial) | Comunica com o RX do GPS @ 9600 baud |
| **GSM SIM800L RX** | `GPIO 26` | UART1 (HardwareSerial) | Comunica com o TX do SIM800L @ 9600 baud |
| **GSM SIM800L TX** | `GPIO 27` | UART1 (HardwareSerial) | Comunica com o RX do SIM800L @ 9600 baud |

> **Aviso de Alimentação:** O módulo GPS NEO-6M possui regulador de tensão onboard e deve ser alimentado no pino **VIN (5V)** do ESP32 para garantir recepção de satélites sem quedas de tensão.

### 2. Raspberry Pi (Cliente Remoto do Botão)
| Terminal do Botão | Pino no Raspberry Pi | Mapeamento no Sistema |
| :--- | :--- | :--- |
| **Terminal 1** | **Pino Físico 32** (BOARD 32 / BCM GPIO 12) | Mapeado diretamente para o `GPIO 32` do ESP32 |
| **Terminal 2** | **Pino Físico 34** (GND) ou Pino 30 (GND) | Terra comum de referência |

---

## 🏗️ Arquitetura do Projeto

```
bsm/
├── bsm.ino                  # Código-fonte principal em C++ para a placa ESP32
├── server.py                # Servidor backend Python (HTTP + Server-Sent Events)
├── raspberry_botao.py       # Script cliente para o botão no Raspberry Pi
├── simulador/               # Bancada virtual completa de testes
│   ├── index.html           # Interface visual do simulador (Abas Bancada + Raspberry)
│   ├── styles.css           # Estilos e animações (LEDs, motor vibratório, dark theme)
│   ├── app.js               # Gerador NMEA com checksum real, AT parser e lógica do ESP32
│   ├── server.py            # Módulo servidor HTTP e ponte REST/SSE
│   └── raspberry_botao.py   # Cópia servida automaticamente via download HTTP
└── raspberry/
    └── raspberry_botao.py   # Versão isolada para transferência manual
```

---

## 💻 Como Executar o Simulador Local

O simulador emula todo o comportamento físico no navegador, incluindo satélites, sentenças NMEA, comandos AT do modem SIM800L, vibração na tela e celular receptor de SMS.

1. **Inicie o servidor no computador:**
   ```bash
   python3 server.py
   ```
2. **Abra o navegador no endereço:**
   ```
   http://127.0.0.1:8765/index.html
   ```

A interface conta com duas abas principais:
- **🎛️ Bancada do Protótipo (ESP32):** Controle do botão de pânico, cenários de GPS (Natal/RN, SP, sem fix, subalimentação), monitor serial em 115200 baud e celular virtual que recebe o SMS.
- **🍓 Conectar Raspberry Pi:** Painel com handshake confirmado, heartbeat ativo, histórico de eventos `DOWN`/`UP` em tempo real e botões de teste instantâneo.

---

## 🍓 Como Conectar o Botão no Raspberry Pi

### Passo 1: Baixar e Executar Direto no Raspberry Pi
No terminal do seu Raspberry Pi, execute um único comando para baixar o script via rede local e já inicializar o monitoramento:

```bash
curl -O http://<IP_DO_SEU_MAC>:8765/raspberry_botao.py && python3 raspberry_botao.py --server http://<IP_DO_SEU_MAC>:8765 --pin 32
```

### Passo 2: Teste Interativo sem Hardware
Caso queira testar a integração do Raspberry Pi diretamente pelo teclado:
```bash
python3 raspberry_botao.py --server http://<IP_DO_SEU_MAC>:8765 --pin 32 --interactive
```
- Pressione `<ENTER>` para segurar por 3.2s e disparar o alerta completo.
- Digite `g` + `<ENTER>` para simular leitura pontual de GPS.

---

## ⚡ Como Gravar no ESP32 Físico

Requisitos:
- Arduino IDE ou `arduino-cli`
- Núcleo ESP32 instalado (`esp32:esp32`)
- Biblioteca **TinyGPSPlus** (v1.0.3 ou superior)

Comando via `arduino-cli`:
```bash
arduino-cli compile --fqbn esp32:esp32:esp32 bsm.ino
arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:esp32 bsm.ino
```

---

## 📩 Fluxo de Emergência e Comandos AT

Quando o botão no GPIO 32 é retido por 3 segundos:
1. `TinyGPSPlus` extrai Latitude e Longitude válidas da UART2 (`RX=4`, `TX=5`).
2. O firmware envia os comandos AT na UART1 (`RX=26`, `TX=27`):
   ```
   AT+CMGF=1
   AT+CMGS="+5584999283827"
   ALERTA MEDIDA PROTETIVA: Vitima ID Maria da Penha acionou botao de panico. Localizacao: https://maps.google.com/?q=-5.794480,-35.211000
   [0x1A / Ctrl+Z]
   ```
3. O pino `GPIO 13` é acionado em nível alto (`HIGH`) por 1000ms para confirmação táctil.

---

## 👤 Autor
Desenvolvido por **Mateus Zeca** ([@thephysicsrn](https://github.com/thephysicsrn)).
Licença MIT.
