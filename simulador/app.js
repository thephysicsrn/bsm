// Simulador local do protótipo ESP32 + GPS NEO-6M + GSM SIM800L

const PRESETS = {
  natal: { lat: -5.794480, lng: -35.211000, sats: 8, alt: 32.4, fix: true, powered: true, wired: true },
  saopaulo: { lat: -23.550520, lng: -46.633308, sats: 6, alt: 760.0, fix: true, powered: true, wired: true },
  nofix: { lat: -5.794480, lng: -35.211000, sats: 0, alt: 0, fix: false, powered: true, wired: true },
  undervoltage: { lat: 0, lng: 0, sats: 0, alt: 0, fix: false, powered: false, wired: true },
  disconnected: { lat: 0, lng: 0, sats: 0, alt: 0, fix: false, powered: true, wired: false },
};

const state = {
  mode: "full", // "full" | "gpsTest"
  pressed: false,
  pressStartMs: 0,
  alertaEnviado: false,
  sendingSms: false,
  smsCount: 0,
  holdSafetyMs: 3000,
  gps: {
    charsProcessed: 0,
    passedChecksum: 0,
    failedChecksum: 0,
    satellites: 8,
    locationValid: false,
    lat: -5.794480,
    lng: -35.211000,
    alt: 32.4,
    lastFixAt: 0,
    lastNmea: "",
  },
};

const el = {
  tabBtnBench: document.getElementById("tabBtnBench"),
  tabBtnRaspberry: document.getElementById("tabBtnRaspberry"),
  tabBench: document.getElementById("tabBench"),
  tabRaspberry: document.getElementById("tabRaspberry"),
  rpiTabBadge: document.getElementById("rpiTabBadge"),
  btnModeFull: document.getElementById("btnModeFull"),
  btnModeGpsTest: document.getElementById("btnModeGpsTest"),
  btnResetBoard: document.getElementById("btnResetBoard"),
  espStateBadge: document.getElementById("espStateBadge"),
  panicButton: document.getElementById("panicButton"),
  panicSublabel: document.getElementById("panicSublabel"),
  buttonPinState: document.getElementById("buttonPinState"),
  holdProgressFill: document.getElementById("holdProgressFill"),
  holdTimerText: document.getElementById("holdTimerText"),
  holdHintText: document.getElementById("holdHintText"),
  motorBox: document.getElementById("motorBox"),
  motorStatus: document.getElementById("motorStatus"),
  rpiBridgeBadge: document.getElementById("rpiBridgeBadge"),
  rpiBridgeDetail: document.getElementById("rpiBridgeDetail"),
  gpsScenario: document.getElementById("gpsScenario"),
  gpsPins: document.getElementById("gpsPins"),
  gpsLatInput: document.getElementById("gpsLatInput"),
  gpsLngInput: document.getElementById("gpsLngInput"),
  gpsPowerLed: document.getElementById("gpsPowerLed"),
  gpsFixLed: document.getElementById("gpsFixLed"),
  mBytes: document.getElementById("mBytes"),
  mValid: document.getElementById("mValid"),
  mSats: document.getElementById("mSats"),
  mFix: document.getElementById("mFix"),
  nmeaPreview: document.getElementById("nmeaPreview"),
  gsmScenario: document.getElementById("gsmScenario"),
  gsmNetLed: document.getElementById("gsmNetLed"),
  emergencyNumber: document.getElementById("emergencyNumber"),
  victimId: document.getElementById("victimId"),
  gsmAtLog: document.getElementById("gsmAtLog"),
  serialConsole: document.getElementById("serialConsole"),
  btnClearSerial: document.getElementById("btnClearSerial"),
  phoneTarget: document.getElementById("phoneTarget"),
  smsCountBadge: document.getElementById("smsCountBadge"),
  smsList: document.getElementById("smsList"),

  // Elementos da Aba do Raspberry Pi
  rpiHeroCard: document.getElementById("rpiHeroCard"),
  rpiHeroIcon: document.getElementById("rpiHeroIcon"),
  rpiConfirmationPill: document.getElementById("rpiConfirmationPill"),
  rpiLastHeartbeat: document.getElementById("rpiLastHeartbeat"),
  rpiConfirmationTitle: document.getElementById("rpiConfirmationTitle"),
  rpiConfirmationDesc: document.getElementById("rpiConfirmationDesc"),
  rpiDevHost: document.getElementById("rpiDevHost"),
  rpiDevIp: document.getElementById("rpiDevIp"),
  rpiDevPin: document.getElementById("rpiDevPin"),
  rpiDownloadCode: document.getElementById("rpiDownloadCode"),
  btnCopyDownload: document.getElementById("btnCopyDownload"),
  rpiCommandCode: document.getElementById("rpiCommandCode"),
  btnCopyCommand: document.getElementById("btnCopyCommand"),
  btnSimulateRpiConnect: document.getElementById("btnSimulateRpiConnect"),
  btnSimulateRpiClick: document.getElementById("btnSimulateRpiClick"),
  btnSimulateRpiHold: document.getElementById("btnSimulateRpiHold"),
  rpiSignalIndicator: document.getElementById("rpiSignalIndicator"),
  rpiLiveBox: document.getElementById("rpiLiveBox"),
  rpiLiveState: document.getElementById("rpiLiveState"),
  rpiLiveSub: document.getElementById("rpiLiveSub"),
  btnClearRpiHistory: document.getElementById("btnClearRpiHistory"),
  rpiHistoryBody: document.getElementById("rpiHistoryBody"),
};

function logSerial(line = "") {
  el.serialConsole.textContent += line + "\n";
  el.serialConsole.scrollTop = el.serialConsole.scrollHeight;
}

function formatTimeUtc(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.00`;
}

function formatDateUtc(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getUTCDate())}${pad(date.getUTCMonth() + 1)}${String(date.getUTCFullYear()).slice(-2)}`;
}

function toNmeaCoord(decimal, isLat) {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const degStr = String(deg).padStart(isLat ? 2 : 3, "0");
  const minStr = min.toFixed(4).padStart(7, "0");
  const hemi = isLat ? (decimal >= 0 ? "N" : "S") : (decimal >= 0 ? "E" : "W");
  return `${degStr}${minStr},${hemi}`;
}

function withNmeaChecksum(body) {
  let cs = 0;
  for (let i = 0; i < body.length; i++) {
    cs ^= body.charCodeAt(i);
  }
  return `$${body}*${cs.toString(16).toUpperCase().padStart(2, "0")}`;
}

function buildNmeaBurst(preset) {
  const now = new Date();
  const timeStr = formatTimeUtc(now);
  const dateStr = formatDateUtc(now);

  if (!preset.fix) {
    const rmc = withNmeaChecksum(`GPRMC,${timeStr},V,,,,,,,${dateStr},,,N`);
    const gga = withNmeaChecksum(`GPGGA,${timeStr},,,,,0,00,99.99,,,,,,`);
    return [rmc, gga];
  }

  const lat = Number(el.gpsLatInput.value) || preset.lat;
  const lng = Number(el.gpsLngInput.value) || preset.lng;
  const latPart = toNmeaCoord(lat, true);
  const lngPart = toNmeaCoord(lng, false);
  const rmc = withNmeaChecksum(`GPRMC,${timeStr},A,${latPart},${lngPart},0.00,0.00,${dateStr},,,A`);
  const gga = withNmeaChecksum(
    `GPGGA,${timeStr},${latPart},${lngPart},1,${String(preset.sats).padStart(2, "0")},1.1,${preset.alt.toFixed(1)},M,0.0,M,,`
  );
  return [rmc, gga];
}

function currentPreset() {
  return PRESETS[el.gpsScenario.value] || PRESETS.natal;
}

function tickGps() {
  const preset = currentPreset();

  el.gpsPowerLed.classList.toggle("on", preset.powered);

  if (!preset.powered || !preset.wired) {
    state.gps.locationValid = false;
    state.gps.satellites = 0;
    el.gpsFixLed.classList.remove("on");
    el.nmeaPreview.textContent = !preset.powered
      ? "(Sem dados — modulo GPS desligado por subalimentacao 3,3V)"
      : "(Sem dados — fio TX/RX desconectado)";
    el.espStateBadge.textContent = !preset.powered ? "Aviso • GPS 3,3V" : "Ligado • USB 5V";
    el.espStateBadge.className = !preset.powered ? "status-pill warn" : "status-pill ok";
    updateGpsMetrics();
    return;
  }

  el.espStateBadge.textContent = "Ligado • USB 5V";
  el.espStateBadge.className = "status-pill ok";

  const sentences = buildNmeaBurst(preset);
  const payload = sentences.join("\r\n") + "\r\n";
  state.gps.charsProcessed += payload.length;
  state.gps.passedChecksum += sentences.length;
  state.gps.lastNmea = sentences[1];
  state.gps.satellites = preset.sats;

  if (preset.fix) {
    state.gps.lat = Number(el.gpsLatInput.value) || preset.lat;
    state.gps.lng = Number(el.gpsLngInput.value) || preset.lng;
    state.gps.alt = preset.alt;
    state.gps.locationValid = true;
    state.gps.lastFixAt = Date.now();
    el.gpsFixLed.classList.add("on");
    setTimeout(() => el.gpsFixLed.classList.remove("on"), 250);
  } else {
    state.gps.locationValid = false;
    el.gpsFixLed.classList.remove("on");
  }

  el.nmeaPreview.textContent = sentences[0];
  updateGpsMetrics();
}

function updateGpsMetrics() {
  el.mBytes.textContent = String(state.gps.charsProcessed);
  el.mValid.textContent = String(state.gps.passedChecksum);
  el.mSats.textContent = state.gps.satellites > 0 ? String(state.gps.satellites) : "0";
  el.mFix.textContent = state.gps.locationValid ? "Válido" : "Sem fix";
  el.mFix.style.color = state.gps.locationValid ? "var(--green)" : "var(--amber)";
}

function setMotorActive(active) {
  el.motorBox.classList.toggle("vibrating", active);
  el.motorStatus.textContent = active ? "HIGH (VIBRANDO 1000ms)" : "LOW (Parado)";
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSmsCard(numero, mensagem, delivered) {
  const empty = el.smsList.querySelector(".sms-empty");
  if (empty) empty.remove();

  state.smsCount += 1;
  el.smsCountBadge.textContent = `${state.smsCount} SMS`;

  const card = document.createElement("div");
  card.className = "sms-bubble";
  if (!delivered) {
    card.style.background = "#2a1619";
    card.style.borderColor = "#8c2d33";
  }

  const now = new Date().toLocaleTimeString("pt-BR");
  const escaped = escapeHtml(mensagem).replace(
    /(https:\/\/maps\.google\.com\/\?q=[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  card.innerHTML = `
    <div class="sms-meta">
      <span>${delivered ? `Recebido em ${escapeHtml(numero)}` : "Falha no envio (SIM800L offline)"}</span>
      <span>${now}</span>
    </div>
    <div class="sms-body">${escaped}</div>
  `;
  el.smsList.prepend(card);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enviarAlertaSMS() {
  if (state.sendingSms) return;
  state.sendingSms = true;

  let latitude = "Sem_Sinal";
  let longitude = "Sem_Sinal";

  if (state.gps.locationValid) {
    latitude = state.gps.lat.toFixed(6);
    longitude = state.gps.lng.toFixed(6);
    logSerial("GPS: Coordenadas obtidas com sucesso.");
  } else {
    logSerial("GPS: Sem sinal de satelite no momento.");
  }

  const victim = el.victimId.value.trim() || "Maria da Penha";
  const numero = el.emergencyNumber.value.trim() || "+5584999283827";

  let mensagem = `ALERTA MEDIDA PROTETIVA: Vitima ID ${victim} acionou botao de panico. `;
  if (latitude !== "Sem_Sinal") {
    mensagem += `Localizacao: https://maps.google.com/?q=${latitude},${longitude}`;
  } else {
    mensagem += "Localizacao: (Ultima celula da operadora / Sem sinal GPS).";
  }

  logSerial(`Mensagem formulada: ${mensagem}`);
  logSerial("Enviando SMS via SIM800L...");

  const gsmOnline = el.gsmScenario.value === "online";
  el.gsmAtLog.textContent = "";
  const appendAt = (txt) => {
    el.gsmAtLog.textContent += txt + "\n";
    el.gsmAtLog.scrollTop = el.gsmAtLog.scrollHeight;
  };

  appendAt("> AT+CMGF=1");
  await delay(250);
  appendAt(gsmOnline ? "< OK" : "< ERROR (NO SIM)");

  appendAt(`> AT+CMGS="${numero}"`);
  await delay(250);
  appendAt(gsmOnline ? "< >" : "< ERROR");

  appendAt(`> ${mensagem}`);
  await delay(250);
  appendAt("> [Ctrl+Z / 0x1A]");
  await delay(400);
  appendAt(gsmOnline ? `< +CMGS: ${state.smsCount + 1}\n< OK` : "< +CMS ERROR: 310 (SIM not inserted)");

  logSerial("Comando de envio de SMS concluido.\n");
  renderSmsCard(numero, mensagem, gsmOnline);

  logSerial("Feedback Tátil: VIBRANDO.");
  setMotorActive(true);
  await delay(1000);
  setMotorActive(false);

  state.sendingSms = false;
}

function exibirInfoGPS() {
  const [rx, tx] = el.gpsPins.value.split(",");
  const preset = currentPreset();
  const ageMs = state.gps.locationValid ? Date.now() - state.gps.lastFixAt : 0;

  logSerial("\n------------------------------------");
  logSerial("[!] BOTAO PRESSIONADO - LENDO GPS");
  logSerial(`Config atual -> RX=${rx} TX=${tx} @ 9600 baud`);
  logSerial(
    `Bytes NMEA recebidos: ${state.gps.charsProcessed} | Frases validas: ${state.gps.passedChecksum} | Falhas checksum: ${state.gps.failedChecksum}`
  );

  if (state.gps.charsProcessed < 10) {
    logSerial("AVISO: Nenhum dado vindo do modulo GPS.");
    logSerial(
      !preset.powered
        ? "Diagnostico: Modulo em 3,3V insuficiente — alimente VCC em 5V/VIN."
        : "Diagnostico: Verifique fios RX/TX e GND comum."
    );
  }

  logSerial(`Satelites: ${state.gps.satellites > 0 ? state.gps.satellites : "Indisponivel"}`);

  if (state.gps.locationValid) {
    const lat = state.gps.lat.toFixed(6);
    const lng = state.gps.lng.toFixed(6);
    logSerial(`Latitude:  ${lat}`);
    logSerial(`Longitude: ${lng}`);
    logSerial(`Idade da leitura (ms): ${ageMs}`);
    logSerial(`Google Maps: https://maps.google.com/?q=${lat},${lng}`);
    logSerial(`Altitude (m): ${state.gps.alt.toFixed(1)}`);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    logSerial(
      `Data/Hora GPS: ${pad(now.getUTCDate())}/${pad(now.getUTCMonth() + 1)}/${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`
    );
  } else {
    logSerial("Localizacao: Sem sinal de satelite (sem fix no momento).");
  }
  logSerial("------------------------------------\n");
}

function bootEsp32() {
  state.pressed = false;
  state.pressStartMs = 0;
  state.alertaEnviado = false;
  state.gps.charsProcessed = 0;
  state.gps.passedChecksum = 0;
  state.gps.failedChecksum = 0;
  setMotorActive(false);
  updateHoldUi(0);
  updateGpsMetrics();

  el.serialConsole.textContent = "";
  logSerial("rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)");
  logSerial("====================================");
  if (state.mode === "full") {
    logSerial("SISTEMA DE PROTECAO INICIADO");
    logSerial("Aguardando conexao com satelites...");
  } else {
    logSerial("MODO TESTE GPS INICIADO");
    logSerial("Pressione o botao (GPIO 32) para ler o GPS.");
  }
  logSerial("====================================\n");
}

function updateHoldUi(elapsedMs) {
  if (state.mode === "gpsTest") {
    el.holdProgressFill.style.width = state.pressed ? "100%" : "0%";
    el.holdTimerText.textContent = "Disparo imediato";
    el.holdHintText.textContent = "Clique simples lê o GPS na hora";
    return;
  }

  const pct = Math.min(100, (elapsedMs / state.holdSafetyMs) * 100);
  el.holdProgressFill.style.width = `${pct.toFixed(1)}%`;
  el.holdTimerText.textContent = `${(Math.min(elapsedMs, state.holdSafetyMs) / 1000).toFixed(1)}s / 3.0s`;
  el.holdHintText.textContent = state.alertaEnviado
    ? "Alerta disparado! Solte o botão."
    : "Solte antes de 3s para cancelar";
}

function handlePressStart(e, sourceLabel = "Pressionado") {
  if (e && e.cancelable) e.preventDefault();
  if (state.pressed) return;

  state.pressed = true;
  state.pressStartMs = performance.now();
  el.panicButton.classList.add("pressed");
  el.buttonPinState.textContent = `LOW (${sourceLabel})`;

  if (state.mode === "gpsTest") {
    updateHoldUi(0);
    exibirInfoGPS();
  }
}

function handlePressEnd() {
  if (!state.pressed) return;
  const elapsed = performance.now() - state.pressStartMs;
  state.pressed = false;
  state.pressStartMs = 0;
  state.alertaEnviado = false;
  el.panicButton.classList.remove("pressed");
  el.buttonPinState.textContent = "HIGH (Solto)";
  updateHoldUi(0);

  if (state.mode === "full" && elapsed > 40 && elapsed < state.holdSafetyMs) {
    logSerial(
      `\n[AVISO] Botão liberado em ${(elapsed / 1000).toFixed(1)}s (antes de 3.0s).`
    );
    logSerial("-> Para evitar disparos acidentais, SEGURE O BOTÃO POR 3 SEGUNDOS completos!");
    logSerial("-> Dica: Mude para 'Modo Teste GPS (1 clique)' no topo se quiser disparo imediato com 1 toque.\n");
  }
}

function loopTick() {
  if (state.pressed && state.mode === "full") {
    const elapsed = performance.now() - state.pressStartMs;
    updateHoldUi(elapsed);
    if (elapsed >= state.holdSafetyMs && !state.alertaEnviado) {
      state.alertaEnviado = true;
      logSerial("\n[!] GATILHO ACIONADO! PROCESSANDO ALERTA...");
      enviarAlertaSMS();
    }
  }
  requestAnimationFrame(loopTick);
}

function setMode(mode) {
  state.mode = mode;
  el.btnModeFull.classList.toggle("active", mode === "full");
  el.btnModeGpsTest.classList.toggle("active", mode === "gpsTest");
  el.panicSublabel.textContent =
    mode === "full" ? "Segure por 3.0s (ou barra de espaço)" : "Clique simples (ou barra de espaço)";
  bootEsp32();
}

// Eventos de UI
el.btnModeFull.addEventListener("click", () => setMode("full"));
el.btnModeGpsTest.addEventListener("click", () => setMode("gpsTest"));
el.btnResetBoard.addEventListener("click", bootEsp32);
el.btnClearSerial.addEventListener("click", () => {
  el.serialConsole.textContent = "";
});

el.panicButton.addEventListener("pointerdown", handlePressStart);
window.addEventListener("pointerup", handlePressEnd);
window.addEventListener("pointercancel", handlePressEnd);

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    handlePressStart();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    handlePressEnd();
  }
});

el.gpsScenario.addEventListener("change", () => {
  const preset = currentPreset();
  if (preset.fix) {
    el.gpsLatInput.value = preset.lat.toFixed(6);
    el.gpsLngInput.value = preset.lng.toFixed(6);
  }
  tickGps();
});

el.emergencyNumber.addEventListener("input", () => {
  el.phoneTarget.textContent = el.emergencyNumber.value || "+5584999283827";
});

el.gsmScenario.addEventListener("change", () => {
  el.gsmNetLed.classList.toggle("on", el.gsmScenario.value === "online");
});

// ==========================================
// CONTROLE DE ABAS (Bancada vs Raspberry Pi)
// ==========================================
function switchTab(tabId) {
  const isBench = tabId === "tabBench";
  el.tabBtnBench.classList.toggle("active", isBench);
  el.tabBtnBench.setAttribute("aria-selected", isBench ? "true" : "false");
  el.tabBtnRaspberry.classList.toggle("active", !isBench);
  el.tabBtnRaspberry.setAttribute("aria-selected", !isBench ? "true" : "false");

  el.tabBench.classList.toggle("active", isBench);
  el.tabRaspberry.classList.toggle("active", !isBench);
}

if (el.tabBtnBench && el.tabBtnRaspberry) {
  el.tabBtnBench.addEventListener("click", () => switchTab("tabBench"));
  el.tabBtnRaspberry.addEventListener("click", () => switchTab("tabRaspberry"));
}

// ==========================================
// TELA DE CONFIRMAÇÃO DO RASPBERRY PI
// ==========================================
let connectedDevice = null;
let lastHeartbeatTime = 0;

function renderRpiConfirmation(device) {
  connectedDevice = device;
  const isConn = Boolean(device);

  if (isConn) {
    el.rpiTabBadge.textContent = "Conectado";
    el.rpiTabBadge.className = "tab-pill ok";

    el.rpiHeroCard.classList.add("connected");
    el.rpiHeroIcon.textContent = "✓";
    el.rpiConfirmationPill.textContent = "Raspberry Pi Conectado";
    el.rpiConfirmationPill.className = "status-pill ok";

    el.rpiConfirmationTitle.textContent = `Raspberry Pi "${device.hostname || "raspberrypi"}" Confirmado!`;
    el.rpiConfirmationDesc.textContent =
      "O handshake com o Raspberry Pi foi confirmado. Quando o botão físico for pressionado, o sinal será recebido e acionará o GPIO 32 na simulação.";

    el.rpiDevHost.textContent = device.hostname || "raspberrypi";
    el.rpiDevIp.textContent = device.ip || "Conectado";
    el.rpiDevPin.textContent =
      device.pin == 32
        ? "Pino 32 (Físico 32 / BCM 12)"
        : `GPIO BCM ${device.pin != null ? device.pin : 32}`;

    lastHeartbeatTime = Date.now();
    el.rpiLastHeartbeat.textContent = "Heartbeat ativo";
    el.rpiLastHeartbeat.style.color = "var(--green)";

    el.rpiBridgeBadge.textContent = "RPI Conectado";
    el.rpiBridgeBadge.className = "status-pill ok";
    el.rpiBridgeDetail.textContent = `Raspberry Pi (${device.hostname}) ativo via Pino ${device.pin || 32} -> ESP32 GPIO 32.`;
  } else {
    el.rpiTabBadge.textContent = "Aguardando";
    el.rpiTabBadge.className = "tab-pill warn";

    el.rpiHeroCard.classList.remove("connected");
    el.rpiHeroIcon.textContent = "⏳";
    el.rpiConfirmationPill.textContent = "Aguardando Conexão";
    el.rpiConfirmationPill.className = "status-pill warn";

    el.rpiConfirmationTitle.textContent = "Aguardando o Raspberry Pi conectar...";
    el.rpiConfirmationDesc.textContent =
      "Execute o script no seu Raspberry Pi para estabelecer a comunicação bidirecional e ativar o botão externo.";

    el.rpiDevHost.textContent = "—";
    el.rpiDevIp.textContent = "—";
    el.rpiDevPin.textContent = "Pino 32 (Físico 32 / BCM 12)";
    el.rpiLastHeartbeat.textContent = "Sem sinal";
    el.rpiLastHeartbeat.style.color = "var(--muted)";

    el.rpiBridgeBadge.textContent = "Aguardando";
    el.rpiBridgeBadge.className = "status-pill warn";
    el.rpiBridgeDetail.textContent = "Aguardando sinal externo do Raspberry Pi...";
  }
}

function appendRpiHistoryRow(evt) {
  if (!el.rpiHistoryBody) return;
  const emptyRow = el.rpiHistoryBody.querySelector(".empty-row");
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement("tr");
  const hora = new Date(evt.timestamp ? evt.timestamp * 1000 : Date.now()).toLocaleTimeString("pt-BR");
  const isDown = evt.pressed || evt.action === "down" || evt.action === "click";
  const actionLabel = evt.action ? evt.action.toUpperCase() : (isDown ? "DOWN" : "UP");
  const estadoLabel = isDown ? "LOW (Pressionado)" : "HIGH (Solto)";
  const badgeClass = isDown ? "badge-down" : "badge-up";

  tr.innerHTML = `
    <td>${hora}</td>
    <td><span class="${badgeClass}">${actionLabel}</span></td>
    <td>${estadoLabel}</td>
    <td>${escapeHtml(evt.source || "Raspberry Pi")} (Pino ${evt.pin != null ? evt.pin : 17})</td>
    <td><span class="badge-ack">HTTP 200 • CONFIRMADO</span></td>
  `;

  el.rpiHistoryBody.prepend(tr);

  // Mantém no máximo 30 linhas
  while (el.rpiHistoryBody.children.length > 30) {
    el.rpiHistoryBody.lastElementChild.remove();
  }
}

function flashRpiLiveBox(action, source, pin) {
  if (!el.rpiLiveBox) return;
  const isDown = action === "down" || action === "click";
  el.rpiLiveBox.classList.toggle("active-pulse", isDown);
  el.rpiSignalIndicator.textContent = `Botão: ${isDown ? "LOW (Pressionado)" : "HIGH (Solto)"}`;
  el.rpiSignalIndicator.style.color = isDown ? "var(--amber)" : "var(--green)";

  el.rpiLiveState.textContent = isDown ? "LOW — BOTÃO PRESSIONADO" : "HIGH — BOTÃO SOLTO";
  const hora = new Date().toLocaleTimeString("pt-BR");
  el.rpiLiveSub.textContent = `Último sinal às ${hora} via ${source || "Raspberry Pi"} (GPIO ${pin != null ? pin : 17})`;
}

async function sendLocalButtonEvent(action, pressed) {
  const endpoint =
    window.location.protocol === "file:"
      ? "http://127.0.0.1:8765/api/button"
      : "/api/button";

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        pressed,
        source: "Simulador (Teste RPi)",
        pin: 32,
      }),
    });
  } catch (err) {
    console.error("Falha ao enviar evento de teste:", err);
  }
}

// Botões de Teste da Aba do Raspberry Pi
if (el.btnSimulateRpiConnect) {
  el.btnSimulateRpiConnect.addEventListener("click", async () => {
    const endpoint =
      window.location.protocol === "file:"
        ? "http://127.0.0.1:8765/api/raspberry/connect"
        : "/api/raspberry/connect";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "raspberrypi-mateus",
          ip: "172.30.230.186",
          pin: 32,
          model: "Raspberry Pi 4 Model B (Ativo)",
          clientTimestamp: Date.now() / 1000,
        }),
      });
      const data = await res.json();
      if (data && data.device) {
        renderRpiConfirmation(data.device);
      }
    } catch (err) {
      console.error("Falha ao conectar Raspberry Pi:", err);
    }
  });
}

if (el.btnSimulateRpiClick) {
  el.btnSimulateRpiClick.addEventListener("click", () => {
    sendLocalButtonEvent("click", true);
  });
}

if (el.btnSimulateRpiHold) {
  el.btnSimulateRpiHold.addEventListener("click", async () => {
    el.btnSimulateRpiHold.disabled = true;
    el.btnSimulateRpiHold.textContent = "⏳ Segurando por 3.2s...";
    await sendLocalButtonEvent("down", true);
    await delay(3200);
    await sendLocalButtonEvent("up", false);
    el.btnSimulateRpiHold.textContent = "🚨 Simular Segurar 3.2s (Alerta de Pânico)";
    el.btnSimulateRpiHold.disabled = false;
  });
}

if (el.btnClearRpiHistory) {
  el.btnClearRpiHistory.addEventListener("click", () => {
    el.rpiHistoryBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">Histórico limpo. Aguardando novos eventos...</td>
      </tr>
    `;
  });
}

if (el.btnCopyDownload) {
  el.btnCopyDownload.addEventListener("click", () => {
    const code = el.rpiDownloadCode.textContent;
    navigator.clipboard.writeText(code).then(() => {
      const orig = el.btnCopyDownload.textContent;
      el.btnCopyDownload.textContent = "Copiado!";
      setTimeout(() => (el.btnCopyDownload.textContent = orig), 2000);
    });
  });
}

if (el.btnCopyCommand) {
  el.btnCopyCommand.addEventListener("click", () => {
    const code = el.rpiCommandCode.textContent;
    navigator.clipboard.writeText(code).then(() => {
      const orig = el.btnCopyCommand.textContent;
      el.btnCopyCommand.textContent = "Copiado!";
      setTimeout(() => (el.btnCopyCommand.textContent = orig), 2000);
    });
  });
}

async function checkInitialRpiStatus() {
  const statusUrl =
    window.location.protocol === "file:"
      ? "http://127.0.0.1:8765/api/raspberry/status"
      : "/api/raspberry/status";

  try {
    const res = await fetch(statusUrl);
    if (!res.ok) return;
    const data = await res.json();
    if (data.lanIps && data.lanIps.length > 0) {
      if (el.rpiCommandCode) {
        el.rpiCommandCode.textContent = `python3 raspberry_botao.py --server http://${data.lanIps[0]}:8765 --pin 32`;
      }
      if (el.rpiDownloadCode) {
        el.rpiDownloadCode.textContent = `curl -O http://${data.lanIps[0]}:8765/raspberry_botao.py`;
      }
    }
    if (data.connected && data.device) {
      renderRpiConfirmation(data.device);
    }
    if (data.history && Array.isArray(data.history)) {
      data.history.forEach((h) => appendRpiHistoryRow(h));
    }
  } catch {
    // Servidor ainda não ativo
  }
}

function connectRaspberryBridge() {
  const eventsUrl =
    window.location.protocol === "file:"
      ? "http://127.0.0.1:8765/api/events"
      : "/api/events";

  const source = new EventSource(eventsUrl);

  source.onopen = () => {
    el.rpiBridgeBadge.textContent = "Online (SSE)";
    el.rpiBridgeBadge.className = "status-pill ok";
    checkInitialRpiStatus();
  };

  source.onerror = () => {
    el.rpiBridgeBadge.textContent = "Sem servidor";
    el.rpiBridgeBadge.className = "status-pill warn";
    el.rpiBridgeDetail.textContent = "Rode simulador/server.py para receber sinais do Raspberry Pi.";
  };

  source.onmessage = (msg) => {
    let data;
    try {
      data = JSON.parse(msg.data);
    } catch {
      return;
    }

    if (data.type === "rpi_connected") {
      renderRpiConfirmation(data.device);
      logSerial(`\n[RPi] >>> CONEXÃO CONFIRMADA: ${data.device.hostname} (${data.device.ip}) no GPIO ${data.device.pin} <<<`);
      return;
    }

    if (data.type === "rpi_ping") {
      lastHeartbeatTime = Date.now();
      if (el.rpiLastHeartbeat) {
        el.rpiLastHeartbeat.textContent = "Heartbeat ativo • agora";
      }
      return;
    }

    if (data.type === "rpi_disconnected") {
      renderRpiConfirmation(null);
      logSerial("\n[RPi] >>> RASPBERRY PI DESCONECTADO <<<");
      return;
    }

    if (data.type !== "button") return;

    const hora = new Date().toLocaleTimeString("pt-BR");
    const origin = data.pin != null ? `${data.source} GPIO ${data.pin}` : data.source;
    el.rpiBridgeDetail.textContent = `Último evento (${hora}): ${data.action} via ${origin}`;

    // Atualiza aba do Raspberry Pi
    appendRpiHistoryRow(data);
    flashRpiLiveBox(data.action, data.source, data.pin);

    // Aciona lógica do ESP32
    if (data.action === "click") {
      logSerial(`[RPi] Clique externo recebido (${origin})`);
      if (state.mode === "full") {
        logSerial(`[RPi] Acionando botão por 3.2s para validação do alerta completo...`);
        handlePressStart(null, origin);
        setTimeout(handlePressEnd, 3200);
      } else {
        handlePressStart(null, origin);
        setTimeout(handlePressEnd, 150);
      }
    } else if (data.pressed) {
      logSerial(`[RPi] Botão externo pressionado -> LOW (${origin})`);
      handlePressStart(null, origin);
    } else {
      logSerial(`[RPi] Botão externo solto -> HIGH (${origin})`);
      handlePressEnd();
    }
  };
}

// Inicialização
el.gsmNetLed.classList.add("on");
bootEsp32();
tickGps();
connectRaspberryBridge();
checkInitialRpiStatus();
setInterval(tickGps, 1000);
setInterval(() => {
  if (el.gsmScenario.value === "online") {
    el.gsmNetLed.classList.toggle("on");
  } else {
    el.gsmNetLed.classList.remove("on");
  }
}, 1500);
requestAnimationFrame(loopTick);

