// Pega aquí la URL del despliegue de Apps Script que termina en /exec.
const API_URL = "https://script.google.com/macros/s/AKfycbyKeU7uiFLngk4tjYhwbYVJaH_j4GAu_E5m-2wXLRZwRpAJsv94VplIaEMD-7VuGV_f/exec";

const CACHE_PREFIX = "control-recreos:";
const SETTINGS_KEY = `${CACHE_PREFIX}settings-v2`;
const TONE_VOLUME_KEY = `${CACHE_PREFIX}tone-volume`;
const DEFAULT_SETTINGS = { redThreshold: 75, yellowGap: 15 };
// El nivel del micrófono se mide en decibelios (escala logarítmica, como el oído).
// -60 dBFS (casi silencio) = 0 %  ·  -10 dBFS (muy fuerte) = 100 %
const MIN_DB = -60;
const MAX_DB = -10;

const elements = {
  groupSelect: document.querySelector("#groupSelect"),
  groupStatus: document.querySelector("#groupStatus"),
  retryButton: document.querySelector("#retryButton"),
  workspace: document.querySelector("#workspace"),
  cloudStatus: document.querySelector("#cloudStatus"),
  trafficLight: document.querySelector("#trafficLight"),
  lights: [...document.querySelectorAll(".light")],
  levelText: document.querySelector("#levelText"),
  volumeBar: document.querySelector("#volumeBar"),
  meterTrack: document.querySelector(".meter-track"),
  yellowMarker: document.querySelector("#yellowMarker"),
  redMarker: document.querySelector("#redMarker"),
  noiseLabel: document.querySelector("#noiseLabel"),
  micButton: document.querySelector("#micButton"),
  stopMicButton: document.querySelector("#stopMicButton"),
  micState: document.querySelector("#micState"),
  micMessage: document.querySelector("#micMessage"),
  redThreshold: document.querySelector("#redThreshold"),
  redThresholdValue: document.querySelector("#redThresholdValue"),
  yellowGap: document.querySelector("#yellowGap"),
  yellowGapValue: document.querySelector("#yellowGapValue"),
  manualMessage: document.querySelector("#manualMessage"),
  subtractButton: document.querySelector("#subtractButton"),
  selectedGroupLabel: document.querySelector("#selectedGroupLabel"),
  timer: document.querySelector("#timer"),
  recessMessage: document.querySelector("#recessMessage"),
  startRecessButton: document.querySelector("#startRecessButton"),
  pauseRecessButton: document.querySelector("#pauseRecessButton"),
  carryButton: document.querySelector("#carryButton"),
  wakeLockNote: document.querySelector("#wakeLockNote")
};

let groups = [];
let selectedGroup = "";
let seconds = 0;
let settings = loadSettings();
let audioContext = null;
let toneMasterGain = null;
let activeToneOscillators = new Set();
let activeToneInterval = 0;
let activeToneTimeout = 0;
let toneRequestId = 0;
let toneVolume = loadToneVolume();
let mediaStream = null;
let analyser = null;
let audioSource = null;
let sampleBuffer = null;
let microphoneActive = false;
let currentNoiseState = "green";
let lastNoiseAt = 0;
let noiseRemainderMs = 0;
let latestLevel = 0;
let manualOverrideUntil = 0;
let lastMicSavedAt = 0;
let manualMessageTimeout = 0;
let recessRunning = false;
let recessEndAt = 0;
let lastRecessSavedAt = 0;
let intervalId = 0;
let saveTimeout = 0;
let saveInProgress = false;
let saveQueued = false;
let groupLoadVersion = 0;
let wakeLock = null;
let wakeLockRequestVersion = 0;

function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* El modo local sigue disponible en memoria. */ }
}

function loadToneVolume() {
  const savedValue = safeLocalStorageGet(TONE_VOLUME_KEY);
  if (savedValue === null) return 1;
  const stored = Number(savedValue);
  return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 1;
}

function loadSettings() {
  try {
    const stored = JSON.parse(safeLocalStorageGet(SETTINGS_KEY) || "null");
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function cacheKey(group) {
  return `${CACHE_PREFIX}group:${encodeURIComponent(group)}`;
}

function readCachedGroup(group) {
  try {
    const value = JSON.parse(safeLocalStorageGet(cacheKey(group)) || "null");
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function writeCachedGroup(group, value) {
  safeLocalStorageSet(cacheKey(group), JSON.stringify(Math.max(0, Math.floor(value))));
}

function localGroups() {
  const found = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(`${CACHE_PREFIX}group:`)) {
        found.push(decodeURIComponent(key.slice(`${CACHE_PREFIX}group:`.length)));
      }
    }
  } catch { /* El acceso a localStorage puede estar deshabilitado. */ }
  return [...new Set(found)].sort((first, second) => first.localeCompare(second, "es"));
}

function apiUrl(action, values = {}) {
  if (!API_URL || API_URL.includes("PEGA_AQUI")) throw new Error("Falta configurar la URL del Web App en app.js.");
  const url = new URL(API_URL);
  url.searchParams.set("accion", action);
  Object.entries(values).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url;
}

async function requestApi(action, values = {}) {
  const response = await fetch(apiUrl(action, values), { method: "GET", cache: "no-store" });
  if (!response.ok) throw new Error(`El servidor respondió con estado ${response.status}.`);
  const result = await response.json();
  if (result?.status === "error") throw new Error(result.mensaje || "Apps Script no pudo completar la operación.");
  return result;
}

function setCloudStatus(message, state = "") {
  elements.cloudStatus.textContent = message;
  elements.cloudStatus.dataset.state = state;
}

function setLight(state, speak = false) {
  const changed = currentNoiseState !== state;
  if (changed) detenerTono();
  currentNoiseState = state;
  elements.trafficLight.dataset.state = state;
  elements.trafficLight.setAttribute("aria-label", `Semáforo ${state === "green" ? "verde: nivel de ruido bajo" : state === "yellow" ? "amarillo: nivel de ruido medio" : "rojo: nivel de ruido alto"}`);
  elements.lights.forEach((light) => light.classList.toggle("active", light.classList.contains(`light-${state}`)));
  elements.noiseLabel.textContent = state === "green" ? "Ruido bajo" : state === "yellow" ? "Ruido medio" : "Ruido alto";
  elements.micState.textContent = microphoneActive ? "Micrófono activo" : "Modo manual";
  if (changed && speak && !recessRunning && state === "yellow") iniciarTono("warning");
  if (changed && speak && !recessRunning && state === "red") iniciarTono("danger");
}

function updateMeter(level) {
  latestLevel = Math.max(0, Math.min(100, level));
  elements.levelText.textContent = `${Math.round(latestLevel)}%`;
  elements.volumeBar.style.width = `${latestLevel}%`;
  elements.meterTrack.setAttribute("aria-valuenow", String(Math.round(latestLevel)));
  const red = Number(elements.redThreshold.value);
  const yellow = Math.max(0, red - Number(elements.yellowGap.value));
  elements.redMarker.style.left = `${red}%`;
  elements.yellowMarker.style.left = `${yellow}%`;
  elements.redThresholdValue.value = `${red}%`;
  elements.redThresholdValue.textContent = `${red}%`;
  elements.yellowGapValue.value = `${Number(elements.yellowGap.value)}%`;
  elements.yellowGapValue.textContent = `${Number(elements.yellowGap.value)}%`;
}

function classifyNoise() {
  const red = Number(elements.redThreshold.value);
  const yellow = Math.max(0, red - Number(elements.yellowGap.value));
  const state = latestLevel >= red ? "red" : latestLevel >= yellow ? "yellow" : "green";
  setLight(state, true);
}

async function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Este navegador no es compatible con Web Audio.");
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

async function playTone(type) {
  try {
    const context = await ensureAudioContext();
    const presets = {
      warning: { wave: "sine", frequency: 600, duration: 0.3, volume: 0.12 },
      danger: { wave: "sawtooth", frequency: 150, duration: 0.5, volume: 0.22 },
      success: { wave: "triangle", frequency: 800, duration: 1.5, volume: 0.18 }
    };
    const preset = presets[type];
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = preset.wave;
    oscillator.frequency.setValueAtTime(preset.frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(preset.volume, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + preset.duration + 0.03);
  } catch { /* El control visual y temporizador no dependen del sonido. */ }
}

function detenerTono() {
  toneRequestId += 1;
  const hadActiveTone = Boolean(activeToneInterval || activeToneTimeout || activeToneOscillators.size);
  window.clearInterval(activeToneInterval);
  activeToneInterval = 0;
  window.clearTimeout(activeToneTimeout);
  activeToneTimeout = 0;
  activeToneOscillators.forEach(({ oscillator, gain }) => {
    try { oscillator.stop(); } catch { /* El oscilador pudo haberse detenido ya. */ }
    try { oscillator.disconnect(); } catch { /* Ya estaba desconectado. */ }
    try { gain.disconnect(); } catch { /* Ya estaba desconectado. */ }
  });
  activeToneOscillators.clear();
  return hadActiveTone;
}

async function iniciarTono(tipo) {
  detenerTono();
  const requestId = toneRequestId;
  const expectedState = tipo === "warning" ? "yellow" : "red";
  if (tipo !== "warning" && tipo !== "danger") return;
  if (recessRunning || document.hidden || currentNoiseState !== expectedState) return;

  const preset = tipo === "warning"
    ? { wave: "sine", frequency: 300, volume: 0.12, duration: 0.25, interval: 1000 }
    : { wave: "square", frequency: 800, volume: 0.2, duration: 0.15, interval: 400 };
  activeToneTimeout = window.setTimeout(() => {
    if (requestId === toneRequestId) detenerTono();
  }, 10000);

  try {
    const context = await ensureAudioContext();
    if (requestId !== toneRequestId || recessRunning || document.hidden || currentNoiseState !== expectedState) return;

    if (!toneMasterGain) {
      toneMasterGain = context.createGain();
      toneMasterGain.gain.setValueAtTime(toneVolume, context.currentTime);
      toneMasterGain.connect(context.destination);
    }

    const playBeep = () => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = preset.wave;
      oscillator.frequency.setValueAtTime(preset.frequency, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(preset.volume, now + 0.01);
      gain.gain.setValueAtTime(preset.volume, now + preset.duration - 0.02);
      gain.gain.linearRampToValueAtTime(0, now + preset.duration);
      oscillator.connect(gain);
      gain.connect(toneMasterGain);
      const activeOscillator = { oscillator, gain };
      activeToneOscillators.add(activeOscillator);
      oscillator.addEventListener("ended", () => {
        activeToneOscillators.delete(activeOscillator);
        try { oscillator.disconnect(); } catch { /* Ya estaba desconectado. */ }
        try { gain.disconnect(); } catch { /* Ya estaba desconectado. */ }
      }, { once: true });
      oscillator.start(now);
      oscillator.stop(now + preset.duration);
    };

    playBeep();
    activeToneInterval = window.setInterval(() => {
      if (requestId === toneRequestId && !recessRunning && !document.hidden && currentNoiseState === expectedState) {
        playBeep();
      }
    }, preset.interval);
  } catch {
    if (requestId === toneRequestId) detenerTono();
  }
}

function createToneVolumeControl() {
  const settingsPanel = document.querySelector(".settings");
  if (!settingsPanel) return;

  const row = document.createElement("div");
  row.className = "setting-row";
  const label = document.createElement("label");
  const slider = document.createElement("input");
  const output = document.createElement("output");
  slider.id = "toneVolume";
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.value = String(Math.round(toneVolume * 100));
  slider.setAttribute("aria-label", "Volumen de los tonos del semáforo");
  label.htmlFor = slider.id;
  label.append("Volumen de tonos", output);
  output.htmlFor = slider.id;
  output.textContent = `${slider.value}%`;
  row.append(label, slider);
  settingsPanel.append(row);

  slider.addEventListener("input", () => {
    toneVolume = Number(slider.value) / 100;
    output.textContent = `${slider.value}%`;
    safeLocalStorageSet(TONE_VOLUME_KEY, String(toneVolume));
    if (toneMasterGain && audioContext) {
      const now = audioContext.currentTime;
      toneMasterGain.gain.cancelScheduledValues(now);
      toneMasterGain.gain.setValueAtTime(toneMasterGain.gain.value, now);
      toneMasterGain.gain.linearRampToValueAtTime(toneVolume, now + 0.05);
    }
  });
}

function persistCurrentSeconds() {
  if (selectedGroup) writeCachedGroup(selectedGroup, seconds);
}

function updateTimer() {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  const display = `${minutes}:${remainder}`;
  elements.timer.textContent = display;
  elements.timer.setAttribute("aria-label", `${Math.floor(seconds / 60)} minutos y ${remainder} segundos acumulados`);
  elements.startRecessButton.disabled = seconds <= 0;
}

function updateRecessControls() {
  elements.startRecessButton.textContent = recessRunning ? "▶️ Reanudar (Ya están callados)" : "▶️ Iniciar Descuento";
  elements.pauseRecessButton.hidden = !recessRunning;
  elements.carryButton.hidden = seconds <= 0;
  elements.groupSelect.disabled = recessRunning || groups.length === 0;
}

function setRecessMessage(text, alert = false) {
  elements.recessMessage.textContent = text;
  elements.recessMessage.classList.toggle("is-alert", alert);
}

function setSeconds(value, save = true) {
  seconds = Math.max(0, Math.floor(value));
  updateTimer();
  updateRecessControls();
  persistCurrentSeconds();
  if (save && selectedGroup) scheduleCloudSave();
}

function showManualNotice(message) {
  elements.manualMessage.textContent = message;
  elements.manualMessage.hidden = false;
  window.clearTimeout(manualMessageTimeout);
  manualMessageTimeout = window.setTimeout(() => {
    elements.manualMessage.hidden = true;
    if (microphoneActive && !recessRunning) {
      manualOverrideUntil = 0;
      classifyNoise();
    } else if (!recessRunning) {
      setLight("green");
    }
  }, 4000);
}

function addManualTime(amount) {
  if (!selectedGroup || recessRunning) return;
  setSeconds(seconds + amount);
  setLight("red"); // solo visual: el ajuste manual no hace sonar ningún pitido
  manualOverrideUntil = Date.now() + 4000;
  showManualNotice(`¡Se han sumado ${amount} segundos por ruido!`);
}

function subtractManualTime() {
  if (!selectedGroup || recessRunning) return;
  const before = seconds;
  setSeconds(Math.max(0, seconds - 10));
  const removed = before - seconds;
  showManualNotice(`Se restaron ${removed} ${removed === 1 ? "segundo" : "segundos"}.`);
}

function scheduleCloudSave(delay = 800) {
  if (!selectedGroup) return;
  window.clearTimeout(saveTimeout);
  saveTimeout = window.setTimeout(() => guardarEnNube(), delay);
}

async function guardarEnNube() {
  if (!selectedGroup) return;
  const groupToSave = selectedGroup;
  const valueToSave = seconds;
  writeCachedGroup(groupToSave, valueToSave);
  if (!navigator.onLine) {
    setCloudStatus("☁️ Sin conexión; guardado local, se reintentará", "error");
    return;
  }
  if (saveInProgress) {
    saveQueued = true;
    return;
  }
  saveInProgress = true;
  setCloudStatus("☁️ Guardando en la nube...", "saving");
  try {
    const result = await requestApi("guardar", { grupo: groupToSave, segundos: valueToSave });
    if (result?.status !== "ok") throw new Error("La hoja no confirmó el guardado.");
    if (groupToSave === selectedGroup && valueToSave === seconds) setCloudStatus("☁️ Guardado en la nube", "saved");
  } catch (error) {
    setCloudStatus(`☁️ No se pudo guardar: ${error.message} Se reintentará.`, "error");
    window.clearTimeout(saveTimeout);
    saveTimeout = window.setTimeout(() => guardarEnNube(), 5000);
  } finally {
    saveInProgress = false;
    if (saveQueued) {
      saveQueued = false;
      scheduleCloudSave(250);
    }
  }
}

function renderGroups(list, selected = "") {
  elements.groupSelect.replaceChildren();
  const prompt = document.createElement("option");
  prompt.value = "";
  prompt.textContent = list.length ? "Selecciona un grupo..." : "No hay grupos";
  elements.groupSelect.append(prompt);
  list.forEach((group) => {
    const option = document.createElement("option");
    option.value = group;
    option.textContent = group;
    elements.groupSelect.append(option);
  });
  elements.groupSelect.disabled = list.length === 0;
  if (selected && list.includes(selected)) elements.groupSelect.value = selected;
}

async function loadGroups() {
  elements.retryButton.hidden = true;
  elements.groupStatus.textContent = "Conectando con la hoja de cálculo...";
  elements.groupSelect.disabled = true;
  elements.groupSelect.replaceChildren(new Option("Cargando grupos...", ""));
  try {
    const result = await requestApi("obtener");
    if (!Array.isArray(result)) throw new Error("La respuesta de la hoja no tiene el formato esperado.");
    groups = result.filter((item) => item && typeof item.grupo === "string" && item.grupo.trim())
      .map((item) => ({ grupo: item.grupo.trim(), segundos: Math.max(0, Math.floor(Number(item.segundos) || 0)) }));
    groups.forEach((item) => writeCachedGroup(item.grupo, item.segundos));
    renderGroups(groups.map((item) => item.grupo));
    if (groups.length) {
      elements.groupStatus.textContent = "Elige un grupo para cargar su tiempo actualizado.";
      setCloudStatus("☁️ Conectado a la hoja", "saved");
    } else {
      elements.groupStatus.textContent = "La hoja no tiene grupos. Añade grupos en la hoja de cálculo y vuelve a intentar.";
      setCloudStatus("☁️ Hoja conectada", "saved");
    }
  } catch (error) {
    const cached = localGroups();
    groups = cached.map((grupo) => ({ grupo, segundos: readCachedGroup(grupo) || 0 }));
    renderGroups(cached);
    elements.groupStatus.textContent = `No se pudieron cargar los grupos desde la nube (${error.message}). Comprueba la conexión o la URL y reintenta.${cached.length ? " Puedes continuar con los grupos guardados en este dispositivo." : ""}`;
    elements.retryButton.hidden = false;
    setCloudStatus("☁️ Sin conexión", "error");
  }
}

async function selectGroup(group) {
  groupLoadVersion += 1;
  const requestVersion = groupLoadVersion;
  detenerTono();
  if (selectedGroup && group !== selectedGroup) {
    window.clearTimeout(saveTimeout);
    await guardarEnNube(); // no perder cambios pendientes del grupo anterior
  }
  if (microphoneActive) await stopMicrophone(true);
  if (requestVersion !== groupLoadVersion) return;
  selectedGroup = group;
  elements.workspace.hidden = !group;
  elements.manualMessage.hidden = true;
  elements.micMessage.hidden = true;
  if (!group) {
    seconds = 0;
    updateTimer();
    setLight("green");
    return;
  }
  recessRunning = false;
  setLight("green");
  elements.selectedGroupLabel.textContent = group;
  elements.groupStatus.textContent = `Cargando el tiempo actualizado de ${group}...`;
  seconds = readCachedGroup(group) || 0;
  updateTimer();
  updateRecessControls();
  try {
    const fresh = await requestApi("obtener");
    if (requestVersion !== groupLoadVersion) return;
    if (!Array.isArray(fresh)) throw new Error("Formato de respuesta inesperado.");
    const match = fresh.find((item) => String(item.grupo).trim() === group);
    seconds = match ? Math.max(0, Math.floor(Number(match.segundos) || 0)) : 0;
    writeCachedGroup(group, seconds);
    setCloudStatus("☁️ Datos actualizados", "saved");
    elements.groupStatus.textContent = `Tiempo cargado para ${group}.`;
  } catch (error) {
    if (requestVersion !== groupLoadVersion) return;
    setCloudStatus("☁️ Usando datos locales", "error");
    elements.groupStatus.textContent = `No se pudieron actualizar los datos (${error.message}); se usará la copia local de este dispositivo.`;
  }
  updateTimer();
  updateRecessControls();
}

async function startMicrophone() {
  if (!selectedGroup || recessRunning || microphoneActive) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showMicPermissionHelp("Este navegador no ofrece acceso al micrófono. Usa la aplicación desde HTTPS en una versión actualizada del navegador.");
    return;
  }
  elements.micButton.disabled = true;
  try {
    const context = await ensureAudioContext();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    audioSource = context.createMediaStreamSource(mediaStream);
    audioSource.connect(analyser);
    sampleBuffer = new Float32Array(analyser.fftSize);
    microphoneActive = true;
    lastNoiseAt = Date.now();
    lastMicSavedAt = lastNoiseAt;
    noiseRemainderMs = 0;
    elements.micButton.hidden = true;
    elements.stopMicButton.hidden = false;
    elements.micMessage.hidden = true;
    elements.micState.textContent = "Micrófono activo";
    elements.groupStatus.textContent = "Micrófono activo; el castigo se acumula al detectar ruido alto.";
    refreshWakeLock();
  } catch (error) {
    await stopMicrophone(false);
    const explanation = error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
      ? "Permiso denegado. En la barra de direcciones, pulsa el candado, permite el micrófono y vuelve a iniciar. Si ya estaba bloqueado, restablece el permiso allí y recarga la página."
      : error.name === "NotFoundError" || error.name === "DevicesNotFoundError"
        ? "No se encontró un micrófono. Conecta uno y revisa que el sistema operativo permita al navegador usarlo."
        : `No se pudo iniciar el micrófono: ${error.message || "comprueba los permisos y vuelve a intentarlo"}.`;
    showMicPermissionHelp(explanation);
  } finally {
    elements.micButton.disabled = false;
  }
}

function showMicPermissionHelp(message) {
  elements.micMessage.textContent = `${message} La app permanece disponible en modo manual.`;
  elements.micMessage.hidden = false;
  elements.micState.textContent = "Modo manual";
}

async function stopMicrophone(save = true) {
  detenerTono();
  const wasActive = microphoneActive;
  microphoneActive = false;
  if (audioSource) {
    try { audioSource.disconnect(); } catch { /* Ya estaba desconectado. */ }
  }
  audioSource = null;
  analyser = null;
  sampleBuffer = null;
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  elements.micButton.hidden = false;
  elements.stopMicButton.hidden = true;
  elements.micState.textContent = "Modo manual";
  updateMeter(0);
  if (!recessRunning) setLight("green");
  if (wasActive && save && selectedGroup) await guardarEnNube();
  refreshWakeLock();
}

function sampleMicrophone() {
  if (!microphoneActive || !analyser || !sampleBuffer) return;
  analyser.getFloatTimeDomainData(sampleBuffer);
  let sumSquares = 0;
  for (let index = 0; index < sampleBuffer.length; index += 1) sumSquares += sampleBuffer[index] * sampleBuffer[index];
  const rms = Math.sqrt(sumSquares / sampleBuffer.length);
  const db = 20 * Math.log10(Math.max(rms, 0.00001));
  const rawLevel = Math.max(0, Math.min(100, ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100));
  // Sube al instante y baja despacio: así un pico de ruido dura lo suficiente
  // para que lo vea la comprobación de cada segundo.
  const smoothed = rawLevel > latestLevel ? rawLevel : latestLevel * 0.8 + rawLevel * 0.2;
  updateMeter(smoothed);
}

function tick() {
  const now = Date.now();
  sampleMicrophone();

  if (recessRunning) {
    seconds = Math.max(0, Math.ceil((recessEndAt - now) / 1000));
    updateTimer();
    if (now - lastRecessSavedAt >= 10000) {
      lastRecessSavedAt = now;
      scheduleCloudSave(0);
    }
    if (seconds <= 0) completeRecess();
  }

  if (microphoneActive && !recessRunning) {
    if (now - lastNoiseAt >= 1000) {
      const elapsed = now - lastNoiseAt + noiseRemainderMs;
      const wholeSeconds = Math.floor(elapsed / 1000);
      noiseRemainderMs = elapsed % 1000;
      lastNoiseAt = now;
      if (now >= manualOverrideUntil) classifyNoise();
      if (currentNoiseState === "red" && now >= manualOverrideUntil) {
        setSeconds(seconds + wholeSeconds, false);
        if (now - lastMicSavedAt >= 10000) {
          lastMicSavedAt = now;
          scheduleCloudSave(0);
        }
      }
    }
  } else {
    lastNoiseAt = now;
    noiseRemainderMs = 0;
  }
}

async function startOrResumeRecess() {
  if (!selectedGroup || seconds <= 0 || recessRunning) return;
  await stopMicrophone(true);
  recessRunning = true;
  recessEndAt = Date.now() + seconds * 1000;
  lastRecessSavedAt = Date.now();
  setLight("red");
  setRecessMessage("Descuento en curso.");
  updateRecessControls();
  scheduleCloudSave(0);
  refreshWakeLock();
}

function pauseRecess() {
  if (!recessRunning) return;
  detenerTono();
  seconds = Math.max(0, Math.ceil((recessEndAt - Date.now()) / 1000));
  if (seconds <= 0) {
    completeRecess();
    return;
  }
  recessRunning = false;
  updateTimer();
  updateRecessControls();
  setLight("red");
  setRecessMessage("Descuento pausado: el grupo está hablando.");
  playTone("danger");
  scheduleCloudSave(0);
  refreshWakeLock();
}

function completeRecess() {
  if (!recessRunning) return;
  detenerTono();
  recessRunning = false;
  seconds = 0;
  persistCurrentSeconds();
  updateTimer();
  updateRecessControls();
  setLight("green");
  playTone("success");
  setRecessMessage("¡TIEMPO CUMPLIDO! Pueden salir al recreo.", true);
  scheduleCloudSave(0);
  refreshWakeLock();
}

async function carryTimeToTomorrow() {
  if (!selectedGroup || seconds <= 0) return;
  const remaining = recessRunning ? Math.max(0, Math.ceil((recessEndAt - Date.now()) / 1000)) : seconds;
  if (remaining <= 0) {
    completeRecess();
    return;
  }
  const accepted = window.confirm(`Se conservarán ${formatSeconds(remaining)} como tiempo pendiente para mañana. ¿Continuar?`);
  if (!accepted) return;
  detenerTono();
  recessRunning = false;
  seconds = remaining;
  updateTimer();
  updateRecessControls();
  setLight("green");
  refreshWakeLock();
  await guardarEnNube();
  setRecessMessage(`Tiempo restante conservado para mañana: ${formatSeconds(seconds)}.`);
  updateRecessControls();
}

function formatSeconds(value) {
  return `${Math.floor(value / 60)}:${(value % 60).toString().padStart(2, "0")}`;
}

async function refreshWakeLock() {
  const requestVersion = ++wakeLockRequestVersion;
  const needed = microphoneActive || recessRunning;
  if (!needed) {
    if (wakeLock) {
      try { await wakeLock.release(); } catch { /* El bloqueo pudo liberarse al cambiar de pestaña. */ }
      wakeLock = null;
    }
    elements.wakeLockNote.textContent = "";
    return;
  }
  if (!("wakeLock" in navigator)) {
    elements.wakeLockNote.textContent = "Este navegador no admite Wake Lock; mantén la pantalla activa durante el uso.";
    return;
  }
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (requestVersion !== wakeLockRequestVersion || !(microphoneActive || recessRunning)) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    elements.wakeLockNote.textContent = "Pantalla activa durante el micrófono o el descuento.";
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    }, { once: true });
  } catch {
    elements.wakeLockNote.textContent = "No se pudo mantener la pantalla activa; evita bloquear el dispositivo.";
  }
}

elements.retryButton.addEventListener("click", loadGroups);
elements.groupSelect.addEventListener("change", (event) => selectGroup(event.target.value));
elements.micButton.addEventListener("click", startMicrophone);
elements.stopMicButton.addEventListener("click", () => stopMicrophone(true));
elements.startRecessButton.addEventListener("click", startOrResumeRecess);
elements.pauseRecessButton.addEventListener("click", pauseRecess);
elements.carryButton.addEventListener("click", carryTimeToTomorrow);
elements.subtractButton.addEventListener("click", subtractManualTime);
document.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => addManualTime(Number(button.dataset.add))));

function saveSettings() {
  settings = { redThreshold: Number(elements.redThreshold.value), yellowGap: Number(elements.yellowGap.value) };
  safeLocalStorageSet(SETTINGS_KEY, JSON.stringify(settings));
  updateMeter(latestLevel);
  if (microphoneActive && Date.now() >= manualOverrideUntil) classifyNoise();
}

elements.redThreshold.min = "10";
elements.redThreshold.max = "100";
elements.redThreshold.value = String(settings.redThreshold);
elements.yellowGap.value = String(settings.yellowGap);
elements.redThreshold.addEventListener("input", saveSettings);
elements.yellowGap.addEventListener("input", saveSettings);
window.addEventListener("online", () => {
  if (selectedGroup) scheduleCloudSave(0);
  else loadGroups();
});
window.addEventListener("offline", () => setCloudStatus("☁️ Sin conexión; los cambios se guardan en este dispositivo", "error"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") detenerTono();
  if (document.visibilityState === "visible") refreshWakeLock();
});
window.addEventListener("pagehide", () => {
  // Si recargas justo después de sumar tiempo, el guardado con retraso aún no se ha enviado.
  if (!selectedGroup || !navigator.onLine) return;
  try {
    fetch(apiUrl("guardar", { grupo: selectedGroup, segundos: seconds }), { keepalive: true }).catch(() => {});
  } catch { /* Sin URL configurada: no hay nada que enviar. */ }
});
window.addEventListener("beforeunload", () => {
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
});

updateMeter(0);
updateTimer();
updateRecessControls();
createToneVolumeControl();
setLight("green");
intervalId = window.setInterval(tick, 200);
loadGroups();