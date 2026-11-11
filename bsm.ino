#include <HardwareSerial.h>
#include <TinyGPS++.h>

// ==========================================
// 1. CONFIGURAÇÃO DOS PINOS E DADOS
// ==========================================
#define PINO_BOTAO 32
#define PINO_MOTOR 13

// Pinos do GPS NEO-6M (Usará a UART2)
#define GPS_RX 4
#define GPS_TX 5

// Pinos do GSM SIM800L (Usará a UART1)
#define GSM_RX 26
#define GSM_TX 27

#define NUMERO_EMERGENCIA "+5584999283827"
#define ID_VITIMA "Maria da Penha"

// ==========================================
// 2. OBJETOS GLOBAIS
// ==========================================
TinyGPSPlus gps;

// Instanciação explícita para evitar erros de versão do núcleo ESP32
HardwareSerial SerialGPS(2);
HardwareSerial SerialGSM(1);

int ultimoEstadoBotao = HIGH;
unsigned long ultimoDebounce = 0;
const unsigned long tempoDebounce = 50;
bool botaoPressionado = false;

int gpsRxAtual = GPS_RX;
int gpsTxAtual = GPS_TX;
unsigned long gpsBaudAtual = 9600;
String ultimosDadosGPS = "";

void exibirInfoGPS();
bool testarCombinacaoGPS(int rxPin, int txPin, unsigned long baud);
void diagnosticarGPS();

// ==========================================
// 3. INICIALIZAÇÃO
// ==========================================
void setup() {
  Serial.begin(115200);

  SerialGPS.begin(gpsBaudAtual, SERIAL_8N1, gpsRxAtual, gpsTxAtual);
  SerialGSM.begin(9600, SERIAL_8N1, GSM_RX, GSM_TX);

  pinMode(PINO_BOTAO, INPUT_PULLUP);
  pinMode(PINO_MOTOR, OUTPUT);
  digitalWrite(PINO_MOTOR, LOW);

  Serial.println("\n====================================");
  Serial.println("MODO TESTE GPS INICIADO");
  Serial.println("Pressione o botao (GPIO 32) para ler o GPS.");
  Serial.println("====================================\n");
}

// ==========================================
// 4. LOOP PRINCIPAL
// ==========================================
void loop() {
  // Mantém o GPS atualizado em segundo plano
  while (SerialGPS.available() > 0) {
    char c = (char)SerialGPS.read();
    gps.encode(c);
    ultimosDadosGPS += (c >= 32 && c <= 126) ? c : '.';
    if (ultimosDadosGPS.length() > 100) {
      ultimosDadosGPS.remove(0, ultimosDadosGPS.length() - 100);
    }
  }

  // Leitura do Botão com debounce (dispara 1 vez a cada clique)
  int leitura = digitalRead(PINO_BOTAO);

  if (leitura != ultimoEstadoBotao) {
    ultimoDebounce = millis();
    ultimoEstadoBotao = leitura;
  }

  if ((millis() - ultimoDebounce) >= tempoDebounce) {
    if (leitura == LOW && !botaoPressionado) {
      botaoPressionado = true;
      exibirInfoGPS();
    } else if (leitura == HIGH) {
      botaoPressionado = false;
    }
  }
}

// ==========================================
// 5. DIAGNÓSTICO AUTOMÁTICO DE PINOS/BAUD
// ==========================================
bool testarCombinacaoGPS(int rxPin, int txPin, unsigned long baud) {
  SerialGPS.end();
  SerialGPS.begin(baud, SERIAL_8N1, rxPin, txPin);
  while (SerialGPS.available() > 0) {
    SerialGPS.read();
  }

  String amostra = "";
  int totalBytes = 0;
  unsigned long inicio = millis();

  while (millis() - inicio < 1200) {
    while (SerialGPS.available() > 0) {
      char c = (char)SerialGPS.read();
      totalBytes++;
      gps.encode(c);
      if (amostra.length() < 80) {
        amostra += (c >= 32 && c <= 126) ? c : '.';
      }
    }
  }

  if (totalBytes > 0) {
    Serial.print(" -> Detectado em RX=");
    Serial.print(rxPin);
    Serial.print(", TX=");
    Serial.print(txPin);
    Serial.print(" @ ");
    Serial.print(baud);
    Serial.print(" baud (");
    Serial.print(totalBytes);
    Serial.println(" bytes)");
    Serial.print("    Amostra: ");
    Serial.println(amostra);

    if (gps.passedChecksum() > 0 || amostra.indexOf("$G") >= 0) {
      gpsRxAtual = rxPin;
      gpsTxAtual = txPin;
      gpsBaudAtual = baud;
      return true;
    }
  }

  return false;
}

void diagnosticarGPS() {
  const int gpios[] = {4, 5, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 33, 14, 15, 12, 2};
  const int totalGpios = sizeof(gpios) / sizeof(gpios[0]);
  const unsigned long bauds[] = {9600, 38400, 115200, 4800};

  Serial.println("Varrendo pinos seguros do ESP32 por atividade UART (1.5s)...");
  SerialGPS.end();

  int ultimoEstado[17];
  int transicoes[17];
  for (int i = 0; i < totalGpios; i++) {
    pinMode(gpios[i], INPUT_PULLUP);
    ultimoEstado[i] = digitalRead(gpios[i]);
    transicoes[i] = 0;
  }

  unsigned long inicio = millis();
  while (millis() - inicio < 1500) {
    for (int i = 0; i < totalGpios; i++) {
      int atual = digitalRead(gpios[i]);
      if (atual != ultimoEstado[i]) {
        transicoes[i]++;
        ultimoEstado[i] = atual;
      }
    }
  }

  bool achouAtividade = false;
  for (int i = 0; i < totalGpios; i++) {
    if (transicoes[i] >= 5) {
      achouAtividade = true;
      Serial.print(" -> Atividade detectada no GPIO ");
      Serial.print(gpios[i]);
      Serial.print(" (");
      Serial.print(transicoes[i]);
      Serial.println(" transicoes). Testando UART...");

      for (int b = 0; b < 4; b++) {
        if (testarCombinacaoGPS(gpios[i], -1, bauds[b])) {
          Serial.println("GPS encontrado e ativado automaticamente!");
          return;
        }
      }
    }
  }

  if (!achouAtividade) {
    Serial.println("Nenhuma atividade de sinal detectada em nenhum GPIO seguro do ESP32.");
    Serial.println("Isso indica modulo GPS sem alimentacao, LED apagado ou fio TX partido/solto.");
  } else {
    Serial.println("Houve atividade, mas nenhuma frase NMEA valida foi decodificada.");
  }

  SerialGPS.end();
  SerialGPS.begin(gpsBaudAtual, SERIAL_8N1, gpsRxAtual, gpsTxAtual);
}

// ==========================================
// 6. FUNÇÃO DE LEITURA E EXIBIÇÃO DO GPS
// ==========================================
void exibirInfoGPS() {
  Serial.println("\n------------------------------------");
  Serial.println("[!] BOTAO PRESSIONADO - LENDO GPS");
  Serial.print("Config atual -> RX=");
  Serial.print(gpsRxAtual);
  Serial.print(" TX=");
  Serial.print(gpsTxAtual);
  Serial.print(" @ ");
  Serial.print(gpsBaudAtual);
  Serial.println(" baud");

  Serial.print("Bytes NMEA recebidos: ");
  Serial.print(gps.charsProcessed());
  Serial.print(" | Frases validas: ");
  Serial.print(gps.passedChecksum());
  Serial.print(" | Falhas checksum: ");
  Serial.println(gps.failedChecksum());

  if (ultimosDadosGPS.length() > 0) {
    Serial.print("Ultimos bytes recebidos: ");
    Serial.println(ultimosDadosGPS);
  }

  if (gps.passedChecksum() == 0) {
    diagnosticarGPS();
  }

  Serial.print("Satelites: ");
  if (gps.satellites.isValid()) {
    Serial.println(gps.satellites.value());
  } else {
    Serial.println("Indisponivel");
  }

  if (gps.location.isValid()) {
    String latitude = String(gps.location.lat(), 6);
    String longitude = String(gps.location.lng(), 6);

    Serial.print("Latitude:  ");
    Serial.println(latitude);
    Serial.print("Longitude: ");
    Serial.println(longitude);
    Serial.print("Idade da leitura (ms): ");
    Serial.println(gps.location.age());
    Serial.println("Google Maps: https://maps.google.com/?q=" + latitude + "," +
                   longitude);
  } else {
    Serial.println("Localizacao: Sem sinal de satelite (sem fix no momento).");
  }

  if (gps.altitude.isValid()) {
    Serial.print("Altitude (m): ");
    Serial.println(gps.altitude.meters(), 1);
  }

  if (gps.date.isValid() && gps.time.isValid()) {
    char dataHora[32];
    snprintf(dataHora, sizeof(dataHora), "%02d/%02d/%04d %02d:%02d:%02d UTC",
             gps.date.day(), gps.date.month(), gps.date.year(), gps.time.hour(),
             gps.time.minute(), gps.time.second());
             Serial.print("Data/Hora GPS: ");
    Serial.println(dataHora);
  }

  Serial.println("------------------------------------\n");
}
