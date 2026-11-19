'use strict';

// ---------- settings (persisted) ----------
const LS_KEY = 'drumcoach.v1';
const CALIB_HITS = 12;

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const storedSettings = loadSettings();
// older versions had a quieter click; bump it once
if (!storedSettings.clickSound && typeof storedSettings.clickVol === 'number') {
  storedSettings.clickVol = Math.max(storedSettings.clickVol, 1.2);
}
const settings = Object.assign({
  bpm: 120,
  beatsPerBar: 4,
  subdiv: 2,          // grid hits snap to: 1 = quarter, 2 = 8th, 4 = 16th
  sensitivity: 55,
  clickVol: 1.2,      // 0..2 (shown as 0–200%)
  clickSound: 'woodblock',
  inputMode: 'mic',   // 'mic' | 'tap'
  flip: false,        // false: ahead = right
  deviceId: '',
}, storedSettings);
settings.latency = Object.assign({ mic: null, tap: null }, settings.latency || {});

const $ = (id) => document.getElementById(id);

// ---------- engine state ----------
const eng = {
  ctx: null, running: false,
  t0: 0, clickIndex: 0, nextClick: 0, timer: null,
  clickBus: null, onset: null, sink: null, mic: null, micSrc: null,
  hits: [],          // { t } latency-corrected hit times (context clock)
  calib: null,       // { startAt, offsets: [] }
  lastHitWall: 0,
  level: 0,
};

const view = {
  phase: 0, phaseShown: 0, consistency: 0,
  tempo: null, tempoShown: null,
};

// ---------- small maths helpers ----------
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const beatLen = () => 60 / settings.bpm;
const subLen = () => beatLen() / settings.subdiv;

// offset of t from the nearest grid point, in (-sub/2, sub/2]; negative = early
function wrapOffset(t, sub) {
  const d = (t - eng.t0) / sub;
  return (d - Math.round(d)) * sub;
}
function wrapDiff(d, sub) { return d - Math.round(d / sub) * sub; }

// circular mean, so hits around ±half a grid step don't cancel out
function circMean(offsets, sub) {
  let C = 0, S = 0;
  for (const o of offsets) {
    const a = (2 * Math.PI * o) / sub;
    C += Math.cos(a); S += Math.sin(a);
  }
  const n = offsets.length || 1;
  return { mean: (Math.atan2(S, C) / (2 * Math.PI)) * sub, R: Math.hypot(C, S) / n };
}

// Theil–Sen slope: robust to the odd mis-detected hit
function robustSlope(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++)
      if (xs[j] - xs[i] > 0.05) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  return median(slopes);
}

// ---------- audio ----------
async function ensureContext() {
  if (!eng.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    eng.ctx = new Ctx({ latencyHint: 'interactive' });
    // click → volume → soft limiter → speakers.
    // The limiter lets the volume go above 100% without harsh digital clipping.
    eng.clickBus = eng.ctx.createGain();
    eng.clickBus.gain.value = settings.clickVol;
    const limiter = eng.ctx.createWaveShaper();
    limiter.curve = softClipCurve();
    limiter.oversample = '2x';
    eng.clickBus.connect(limiter).connect(eng.ctx.destination);

    const nlen = Math.round(eng.ctx.sampleRate * 0.5);
    eng.noise = eng.ctx.createBuffer(1, nlen, eng.ctx.sampleRate);
    const nd = eng.noise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    await eng.ctx.audioWorklet.addModule('onset-worklet.js');
    eng.onset = new AudioWorkletNode(eng.ctx, 'onset-detector', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    // keep the detector in the rendered graph, silently
    eng.sink = eng.ctx.createGain();
    eng.sink.gain.value = 0;
    eng.onset.connect(eng.sink).connect(eng.ctx.destination);
    eng.onset.port.onmessage = onWorkletMessage;
    sendSensitivity();
  }
  if (eng.ctx.state !== 'running') await eng.ctx.resume();
}

async function ensureMic() {
  if (eng.micSrc) return;
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  if (settings.deviceId) audio.deviceId = { exact: settings.deviceId };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    if (!settings.deviceId) throw e;
    settings.deviceId = '';
    delete audio.deviceId;
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  }
  eng.mic = stream;
  eng.micSrc = eng.ctx.createMediaStreamSource(stream);
  eng.micSrc.connect(eng.onset);
  populateDevices();
}

function stopMic() {
  if (eng.micSrc) { eng.micSrc.disconnect(); eng.micSrc = null; }
  if (eng.mic) { eng.mic.getTracks().forEach((t) => t.stop()); eng.mic = null; }
  eng.level = 0;
}

function sendSensitivity() {
  if (!eng.onset) return;
  eng.onset.port.postMessage({ floor: detectionFloor(), ratio: 5 - settings.sensitivity * 0.025 });
}
function detectionFloor() { return 0.25 * Math.pow(10, -settings.sensitivity / 35); }

// linear up to 0.6, then rounds off smoothly towards 1
function softClipCurve() {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a < 0.6 ? a : 0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

// ---- click sounds ----
// tone(): an oscillator with a sharp attack and an exponential decay
function tone(time, { type = 'sine', freq, peak, decay, dest = eng.clickBus, filter }) {
  const ctx = eng.ctx;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  let node = osc;
  if (filter) node = node.connect(filter);
  node.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + decay + 0.02);
}

// noise(): a filtered noise burst
function noise(time, { peak, decay, filterType, freq, Q = 1 }) {
  const ctx = eng.ctx;
  const src = ctx.createBufferSource();
  src.buffer = eng.noise;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = Q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  src.connect(f).connect(g).connect(eng.clickBus);
  src.start(time);
  src.stop(time + decay + 0.02);
}

// Each sound gets accent = true on beat 1 (higher and/or louder).
const CLICK_SOUNDS = {
  woodblock: {
    label: 'Woodblock',
    play(t, acc) {
      tone(t, { type: 'sine', freq: acc ? 1500 : 1100, peak: 0.95, decay: 0.045 });
      tone(t, { type: 'triangle', freq: acc ? 3000 : 2200, peak: 0.25, decay: 0.015 });
      noise(t, { peak: 0.35, decay: 0.006, filterType: 'bandpass', freq: 2500, Q: 1.5 });
    },
  },
  beep: {
    label: 'Classic beep',
    play(t, acc) {
      tone(t, { type: 'triangle', freq: acc ? 1600 : 1000, peak: 0.95, decay: 0.06 });
    },
  },
  digital: {
    label: 'Digital',
    play(t, acc) {
      const lp = eng.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5000;
      tone(t, { type: 'square', freq: acc ? 1760 : 880, peak: 0.6, decay: 0.07, filter: lp });
    },
  },
  cowbell: {
    label: 'Cowbell',
    play(t, acc) {
      const k = acc ? 1.2 : 1;
      const bp = eng.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400 * k;
      bp.Q.value = 1.2;
      const bus = eng.ctx.createGain();
      bus.connect(bp).connect(eng.clickBus);
      tone(t, { type: 'square', freq: 540 * k, peak: 0.9, decay: 0.14, dest: bus });
      tone(t, { type: 'square', freq: 800 * k, peak: 0.9, decay: 0.14, dest: bus });
    },
  },
  stick: {
    label: 'Sticks',
    play(t, acc) {
      noise(t, { peak: acc ? 3 : 2.6, decay: 0.035, filterType: 'bandpass', freq: acc ? 3800 : 3000, Q: 2.5 });
      tone(t, { type: 'sine', freq: acc ? 2200 : 1800, peak: 0.9, decay: 0.035 });
    },
  },
  hihat: {
    label: 'Hi-hat',
    play(t, acc) {
      noise(t, { peak: acc ? 1 : 0.75, decay: acc ? 0.09 : 0.045, filterType: 'highpass', freq: 7000, Q: 0.7 });
    },
  },
};

function playClick(time, accent) {
  const sound = CLICK_SOUNDS[settings.clickSound] || CLICK_SOUNDS.woodblock;
  sound.play(time, accent);
}

// play a short preview (accent + normal) so you can hear a sound/volume choice
async function previewClick() {
  try { await ensureContext(); } catch { return; }
  if (eng.running) return; // you already hear it
  const t = eng.ctx.currentTime + 0.05;
  playClick(t, true);
  playClick(t + 0.3, false);
  playClick(t + 0.6, false);
}

function scheduler() {
  const ctx = eng.ctx;
  const beat = beatLen();
  // if the tab was throttled, skip missed clicks instead of firing a burst
  if (eng.nextClick < ctx.currentTime - 0.05) {
    eng.clickIndex = Math.ceil((ctx.currentTime - eng.t0) / beat);
    eng.nextClick = eng.t0 + eng.clickIndex * beat;
  }
  while (eng.nextClick < ctx.currentTime + 0.12) {
    playClick(eng.nextClick, eng.clickIndex % settings.beatsPerBar === 0);
    eng.clickIndex++;
    eng.nextClick = eng.t0 + eng.clickIndex * beat;
  }
}

function resetGrid(t0) {
  eng.t0 = t0;
  eng.clickIndex = 0;
  eng.nextClick = t0;
  eng.hits = [];
  view.phase = view.phaseShown = 0;
  view.tempo = view.tempoShown = null;
}

// context time that is being heard right now
function heardNow() {
  const ctx = eng.ctx;
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
}

function eventToContextTime(ev) {
  const ctx = eng.ctx;
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts.performanceTime) return ts.contextTime + (ev.timeStamp - ts.performanceTime) / 1000;
  }
  return heardNow();
}

function currentLatency() {
  const L = settings.latency[settings.inputMode];
  if (typeof L === 'number') return L;
  if (settings.inputMode === 'tap') return 0.015;
  const ctx = eng.ctx;
  return (ctx.baseLatency || 0.01) + (ctx.outputLatency || 0.02) + 0.01;
}

// ---------- transport ----------
async function start() {
  try {
    await ensureContext();
    if (settings.inputMode === 'mic') await ensureMic();
  } catch (e) {
    toast(e && e.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in the browser, or switch Input to Keyboard / tap.'
      : 'Could not start audio: ' + (e && e.message ? e.message : e));
    return;
  }
  eng.running = true;
  resetGrid(eng.ctx.currentTime + 0.15);
  clearInterval(eng.timer);
  eng.timer = setInterval(scheduler, 25);
  scheduler();
  updateUI();
}

function stop() {
  eng.running = false;
  clearInterval(eng.timer);
  eng.timer = null;
  eng.calib = null;
  stopMic();
  updateUI();
}

function setBpm(v) {
  const bpm = clamp(Math.round(Number(v) || settings.bpm), 30, 300);
  settings.bpm = bpm;
  saveSettings();
  // restart the grid on the next click so the tempo changes cleanly
  if (eng.running) resetGrid(eng.nextClick);
  updateUI();
}

// ---------- hits ----------
function onWorkletMessage(e) {
  const d = e.data;
  if (d.type === 'level') eng.level = d.peak;
  else if (d.type === 'onset' && settings.inputMode === 'mic') onHit(d.time);
}

function onHit(raw) {
  if (!eng.running) return;
  if (raw < eng.t0 - beatLen() * 0.5) return;
  eng.lastHitWall = performance.now();
  if (eng.calib) { calibHit(raw); return; }

  const t = raw - currentLatency();
  eng.hits.push({ t });
  while (eng.hits.length && eng.hits[0].t < t - 6) eng.hits.shift();
  analyse();
}

function analyse() {
  const sub = subLen();
  const H = eng.hits;
  if (!H.length) return;
  const tNow = H[H.length - 1].t;

  // Phase: circular mean of the last ~6 hits, minus outliers (fills, flams)
  const recent = H.filter((h) => h.t > tNow - 3).slice(-6);
  const offs = recent.map((h) => wrapOffset(h.t, sub));
  let { mean, R } = circMean(offs, sub);
  const kept = offs.filter((o) => Math.abs(wrapDiff(o - mean, sub)) < 0.2 * sub);
  if (kept.length >= 2 && kept.length < offs.length) ({ mean, R } = circMean(kept, sub));
  view.phase = mean;
  view.consistency = R;

  // Tempo: follow the player's own grid steps over ~4 s and fit the drift
  const win = H.filter((h) => h.t > tNow - 4);
  view.tempo = null;
  if (win.length >= 6 && win[win.length - 1].t - win[0].t >= 1.5) {
    let k = Math.round((win[0].t - eng.t0) / sub);
    const xs = [win[0].t];
    const ys = [win[0].t - (eng.t0 + k * sub)];
    for (let i = 1; i < win.length; i++) {
      const steps = Math.round((win[i].t - win[i - 1].t) / sub);
      if (steps < 1) continue; // second hit in the same grid slot
      k += steps;
      xs.push(win[i].t);
      ys.push(win[i].t - (eng.t0 + k * sub));
    }
    if (xs.length >= 5) view.tempo = settings.bpm * (1 - robustSlope(xs, ys));
  }
}

// ---------- calibration ----------
function startCalibration() {
  if (eng.calib) { eng.calib = null; updateUI(); return; }
  const begin = () => {
    eng.calib = { startAt: eng.ctx.currentTime + beatLen() * 1.5, offsets: [] };
    eng.hits = [];
    updateUI();
  };
  if (eng.running) begin(); else start().then(() => { if (eng.running) begin(); });
}

function calibHit(raw) {
  if (raw < eng.calib.startAt) return;
  const beat = beatLen();
  const k = Math.round((raw - eng.t0) / beat);
  eng.calib.offsets.push(raw - (eng.t0 + k * beat));
  if (eng.calib.offsets.length >= CALIB_HITS) finishCalibration();
}

function finishCalibration() {
  const arr = eng.calib.offsets;
  eng.calib = null;
  const med = median(arr);
  const mad = median(arr.map((x) => Math.abs(x - med)));
  if (mad > 0.02) {
    toast(`Those hits were too uneven (±${Math.round(mad * 1000)} ms). Try again with steady quarter notes.`);
  } else {
    settings.latency[settings.inputMode] = med;
    saveSettings();
    toast(`Calibrated: ${Math.round(med * 1000)} ms latency removed.`);
  }
  eng.hits = [];
  updateUI();
}

// ---------- status / hint ----------
function computeStatus() {
  if (!eng.running) return { key: 'idle', text: 'Press Start' };
  if (eng.calib) {
    return { key: 'calib', text: `Calibrating: play quarter notes right on the click (${eng.calib.offsets.length}/${CALIB_HITS})` };
  }
  const since = (performance.now() - eng.lastHitWall) / 1000;
  if (!eng.hits.length || since > 2.5) {
    return { key: 'wait', text: settings.inputMode === 'mic' ? 'Listening… start playing' : 'Tap Space (or the screen) on the click' };
  }
  const sub = subLen();
  const ph = view.phase;
  const pct = view.tempo ? ((view.tempo - settings.bpm) / settings.bpm) * 100 : 0;

  if (Math.abs(ph) > 0.3 * sub || view.consistency < 0.5) {
    if (pct > 1.5) return { key: 'lost', text: 'Off the grid. You are rushing: slow down' };
    if (pct < -1.5) return { key: 'lost', text: 'Off the grid. You are dragging: push' };
    return { key: 'lost', text: 'Off the grid. Listen for the click and settle in' };
  }
  if (pct > 2) return { key: 'bad', text: 'Rushing: slow down a little' };
  if (pct < -2) return { key: 'bad', text: 'Dragging: push a little' };
  const ms = Math.abs(ph) * 1000;
  if (ms < 12) return { key: 'good', text: 'Locked in' };
  const far = ms > 35;
  return ph < 0
    ? { key: far ? 'bad' : 'warn', text: far ? 'Way ahead: lay back' : 'Ahead: lay back a little' }
    : { key: far ? 'bad' : 'warn', text: far ? 'Way behind: push' : 'Behind: push a little' };
}

// ---------- rendering ----------
const COL = {
  bg: '#0b0f14', track: '#1a2230', grid: '#2b3646', text: '#e6ebf2', dim: '#7b8696',
  good: '#34d399', warn: '#fbbf24', bad: '#f43f5e', click: '#ffffff',
};
const colorFor = (ms) => (ms < 12 ? COL.good : ms < 30 ? COL.warn : COL.bad);

function draw() {
  requestAnimationFrame(draw);
  const c = $('stage');
  const g = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const status = computeStatus();
  const hint = $('hint');
  if (hint.textContent !== status.text) hint.textContent = status.text;
  hint.dataset.state = status.key;

  const dir = settings.flip ? -1 : 1; // +1: ahead (early) drawn to the right
  const pad = Math.max(16, W * 0.05);
  const cx = W / 2;
  const half = W / 2 - pad;
  const big = clamp(W / 18, 22, 64);
  const small = clamp(W / 60, 11, 15);

  // smooth the shown values
  view.phaseShown += (view.phase - view.phaseShown) * 0.15;
  if (view.tempo != null) {
    view.tempoShown = view.tempoShown == null ? view.tempo : view.tempoShown + (view.tempo - view.tempoShown) * 0.1;
  }

  // beat lights
  const bpb = settings.beatsPerBar;
  const dotY = H * 0.1;
  const dotR = clamp(W / 70, 6, 14);
  let lit = -1, flash = 0;
  if (eng.running) {
    const pos = (heardNow() - eng.t0) / beatLen();
    if (pos >= 0) { lit = Math.floor(pos) % bpb; flash = Math.exp(-(pos - Math.floor(pos)) * 6); }
  }
  for (let i = 0; i < bpb; i++) {
    const x = cx + (i - (bpb - 1) / 2) * dotR * 3.2;
    g.beginPath();
    g.arc(x, dotY, dotR, 0, Math.PI * 2);
    g.fillStyle = COL.track;
    g.fill();
    if (i === lit) {
      g.globalAlpha = 0.25 + 0.75 * flash;
      g.fillStyle = i === 0 ? COL.warn : COL.click;
      g.fill();
      g.globalAlpha = 1;
    }
  }

  // ---- phase meter ----
  const sub = subLen();
  const range = Math.min(0.1, sub * 0.45); // seconds shown each side
  const toX = (off) => cx + dir * (-off / range) * half;
  const trackY = H * 0.46;
  const trackH = clamp(H * 0.16, 50, 130);

  // zones
  g.fillStyle = COL.track;
  g.fillRect(pad, trackY - trackH / 2, half * 2, trackH);
  const zone = (ms, color) => {
    const w = (ms / 1000 / range) * half;
    g.fillStyle = color;
    g.fillRect(cx - w, trackY - trackH / 2, w * 2, trackH);
  };
  zone(30, 'rgba(251,191,36,0.07)');
  zone(12, 'rgba(52,211,153,0.10)');

  // ticks
  g.fillStyle = COL.dim;
  g.font = `${small}px system-ui, sans-serif`;
  g.textAlign = 'center';
  for (const ms of [10, 25, 50, 75, 100]) {
    if (ms / 1000 > range) continue;
    for (const s of [-1, 1]) {
      const x = cx + s * (ms / 1000 / range) * half;
      g.fillStyle = COL.grid;
      g.fillRect(x - 0.5, trackY - trackH / 2, 1, trackH);
      g.fillStyle = COL.dim;
      g.fillText(`${ms}`, x, trackY + trackH / 2 + small * 1.4);
    }
  }

  // side labels
  g.font = `600 ${small * 1.1}px system-ui, sans-serif`;
  g.fillStyle = COL.dim;
  const rightLabel = dir > 0 ? 'AHEAD (early) ▶' : 'BEHIND (late) ▶';
  const leftLabel = dir > 0 ? '◀ BEHIND (late)' : '◀ AHEAD (early)';
  g.textAlign = 'left';
  g.fillText(leftLabel, pad, trackY - trackH / 2 - small * 0.8);
  g.textAlign = 'right';
  g.fillText(rightLabel, pad + half * 2, trackY - trackH / 2 - small * 0.8);

  // recent individual hits
  if (eng.running && !eng.calib) {
    const tNow = eng.ctx.currentTime - currentLatency();
    for (const h of eng.hits) {
      const age = tNow - h.t;
      if (age > 4) continue;
      const off = wrapOffset(h.t, sub);
      if (Math.abs(off) > range) continue;
      g.globalAlpha = clamp(1 - age / 4, 0.05, 0.9);
      g.fillStyle = COL.text;
      g.beginPath();
      g.arc(toX(off), trackY + trackH / 2 - 10, 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // the click: centre line
  g.fillStyle = COL.click;
  g.fillRect(cx - 2, trackY - trackH / 2 - 14, 4, trackH + 28);

  const active = eng.running && !eng.calib && eng.hits.length &&
    (performance.now() - eng.lastHitWall) / 1000 < 2.5;

  if (active) {
    const ph = view.phaseShown;
    const ms = Math.abs(ph) * 1000;
    const col = colorFor(ms);
    const lost = Math.abs(view.phase) > 0.3 * sub || view.consistency < 0.5;
    let x = toX(ph);
    const clipped = x < pad || x > pad + half * 2;
    x = clamp(x, pad, pad + half * 2);

    g.globalAlpha = lost ? 0.35 : 1;
    // gap between click and you
    g.fillStyle = col;
    g.globalAlpha *= 0.28;
    g.fillRect(Math.min(cx, x), trackY - trackH / 2, Math.abs(x - cx), trackH);
    g.globalAlpha = lost ? 0.35 : 1;
    // your line
    g.fillRect(x - 4, trackY - trackH / 2 - 6, 8, trackH + 12);
    if (clipped) {
      const s = x > cx ? 1 : -1;
      g.beginPath();
      g.moveTo(x + s * 18, trackY);
      g.lineTo(x + s * 4, trackY - 14);
      g.lineTo(x + s * 4, trackY + 14);
      g.fill();
    }
    g.globalAlpha = 1;

    // readout
    g.textAlign = 'center';
    g.font = `700 ${big}px system-ui, sans-serif`;
    g.fillStyle = lost ? COL.dim : col;
    const label = lost ? 'off the grid'
      : ms < 3 ? 'on the click'
      : `${Math.round(ms)} ms ${ph < 0 ? 'ahead' : 'behind'}`;
    g.fillText(label, cx, trackY - trackH / 2 - big * 0.9);
  } else {
    g.textAlign = 'center';
    g.font = `600 ${big * 0.7}px system-ui, sans-serif`;
    g.fillStyle = COL.dim;
    g.fillText(eng.running ? '—' : `${settings.bpm} BPM`, cx, trackY - trackH / 2 - big * 0.9);
  }

  // ---- tempo gauge ----
  const gy = H * 0.8;
  const gHalf = Math.min(half, 420);
  const gh = 14;
  g.fillStyle = COL.track;
  g.fillRect(cx - gHalf, gy - gh / 2, gHalf * 2, gh);
  g.fillStyle = 'rgba(52,211,153,0.18)';
  g.fillRect(cx - gHalf * 0.2, gy - gh / 2, gHalf * 0.4, gh); // ±1%
  g.fillStyle = COL.click;
  g.fillRect(cx - 1.5, gy - gh, 3, gh * 2);

  g.font = `600 ${small}px system-ui, sans-serif`;
  g.fillStyle = COL.dim;
  g.textAlign = 'left';
  g.fillText(dir > 0 ? '◀ dragging' : '◀ rushing', cx - gHalf, gy - gh - 6);
  g.textAlign = 'right';
  g.fillText(dir > 0 ? 'rushing ▶' : 'dragging ▶', cx + gHalf, gy - gh - 6);

  g.textAlign = 'center';
  g.font = `${small * 1.15}px system-ui, sans-serif`;
  if (active && view.tempoShown != null) {
    const pct = (view.tempoShown - settings.bpm) / settings.bpm;
    const nx = cx + dir * clamp(pct / 0.05, -1, 1) * gHalf;
    const col = Math.abs(pct) < 0.01 ? COL.good : Math.abs(pct) < 0.02 ? COL.warn : COL.bad;
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(nx, gy + gh / 2 + 2);
    g.lineTo(nx - 9, gy + gh / 2 + 16);
    g.lineTo(nx + 9, gy + gh / 2 + 16);
    g.fill();
    g.fillRect(nx - 2, gy - gh / 2 - 4, 4, gh + 8);
    g.fillStyle = COL.text;
    g.fillText(`Your tempo ${view.tempoShown.toFixed(1)} BPM  ·  target ${settings.bpm}`, cx, gy + gh + small * 2.4);
  } else {
    g.fillStyle = COL.dim;
    g.fillText(`Target ${settings.bpm} BPM`, cx, gy + gh + small * 2.4);
  }
}

// ---------- UI ----------
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}

function updateUI() {
  $('startBtn').textContent = eng.running ? 'Stop' : 'Start';
  $('startBtn').classList.toggle('running', eng.running);
  if (document.activeElement !== $('bpm')) $('bpm').value = settings.bpm;
  $('subdiv').value = String(settings.subdiv);
  $('beats').value = String(settings.beatsPerBar);
  $('inputMode').value = settings.inputMode;
  $('sens').value = settings.sensitivity;
  $('clickVol').value = Math.round(settings.clickVol * 100);
  $('clickVolPct').textContent = `${Math.round(settings.clickVol * 100)}%`;
  $('clickSound').value = settings.clickSound;
  $('flip').checked = settings.flip;
  $('micRow').hidden = settings.inputMode !== 'mic';
  $('calibBtn').textContent = eng.calib ? 'Cancel calibration' : 'Calibrate';
  const L = settings.latency[settings.inputMode];
  $('latency').textContent = typeof L === 'number'
    ? `Latency ${Math.round(L * 1000)} ms (calibrated)`
    : 'Not calibrated yet';
  $('latency').classList.toggle('warn', typeof L !== 'number');
  $('songSave').textContent = `Save ${settings.bpm} BPM`;
}

// ---------- saved songs (title + BPM, stored in this browser) ----------
const SONGS_KEY = 'drumcoach.songs.v1';

function loadSongs() {
  try {
    const arr = JSON.parse(localStorage.getItem(SONGS_KEY));
    return Array.isArray(arr) ? arr.filter((s) => s && typeof s.title === 'string' && Number(s.bpm) > 0) : [];
  } catch { return []; }
}
let songs = loadSongs();

// Starter list, added once to every browser. Songs deleted later don't come back.
const SEED_KEY = 'drumcoach.songs.seeded.v1';
const STARTER_SONGS = [
  { title: 'Your own way', bpm: 136, beatsPerBar: 4 },
  { title: 'Hotel california', bpm: 76, beatsPerBar: 4 },
  { title: 'Crazy', bpm: 98, beatsPerBar: 4 },
  { title: 'Papaoutai', bpm: 120, beatsPerBar: 4 },
  { title: 'Dont stop', bpm: 120, beatsPerBar: 4 },
  { title: 'Místicas', bpm: 122, beatsPerBar: 4 },
  { title: 'Born this way', bpm: 124, beatsPerBar: 4 },
];
(function seedSongs() {
  try { if (localStorage.getItem(SEED_KEY)) return; } catch { return; }
  STARTER_SONGS.forEach((s, i) => {
    if (!songs.some((x) => x.title.toLowerCase() === s.title.toLowerCase())) {
      songs.push({ id: `seed${i}`, ...s });
    }
  });
  try { localStorage.setItem(SONGS_KEY, JSON.stringify(songs)); localStorage.setItem(SEED_KEY, '1'); } catch { /* ignore */ }
})();

function saveSongs() {
  try { localStorage.setItem(SONGS_KEY, JSON.stringify(songs)); }
  catch { toast('Could not save the song list in this browser.'); }
}

function renderSongs(selectedId = $('songSelect').value) {
  songs.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const sel = $('songSelect');
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = songs.length ? `Choose a song (${songs.length})` : 'No saved songs yet';
  sel.appendChild(ph);
  for (const s of songs) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.title} · ${s.bpm} BPM · ${s.beatsPerBar || 4} beats`;
    sel.appendChild(o);
  }
  sel.value = songs.some((s) => s.id === selectedId) ? selectedId : '';
  $('songDelete').disabled = !sel.value;
}

function saveCurrentSong() {
  const title = $('songTitle').value.trim().replace(/\s+/g, ' ');
  if (!title) { toast('Type a song title first.'); $('songTitle').focus(); return; }
  const existing = songs.find((s) => s.title.toLowerCase() === title.toLowerCase());
  if (existing) {
    existing.bpm = settings.bpm;
    existing.beatsPerBar = settings.beatsPerBar;
    toast(`Updated "${existing.title}" to ${settings.bpm} BPM.`);
  } else {
    songs.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title, bpm: settings.bpm, beatsPerBar: settings.beatsPerBar,
    });
    toast(`Saved "${title}" at ${settings.bpm} BPM.`);
  }
  saveSongs();
  renderSongs((existing || songs[songs.length - 1]).id);
}

function selectSong(id) {
  const s = songs.find((x) => x.id === id);
  $('songDelete').disabled = !s;
  if (!s) return;
  $('songTitle').value = s.title;
  if (s.beatsPerBar) { settings.beatsPerBar = s.beatsPerBar; saveSettings(); }
  setBpm(s.bpm);
}

function deleteSelectedSong() {
  const s = songs.find((x) => x.id === $('songSelect').value);
  if (!s || !confirm(`Delete "${s.title}" (${s.bpm} BPM) from your list?`)) return;
  songs = songs.filter((x) => x.id !== s.id);
  saveSongs();
  $('songTitle').value = '';
  renderSongs('');
  toast(`Deleted "${s.title}".`);
}

async function populateDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel = $('device');
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${i + 1}`;
    sel.appendChild(o);
  });
  const current = eng.mic && eng.mic.getAudioTracks()[0] && eng.mic.getAudioTracks()[0].getSettings().deviceId;
  if (current) sel.value = current;
}

function meterLoop() {
  requestAnimationFrame(meterLoop);
  const toPct = (v) => clamp((20 * Math.log10(Math.max(v, 1e-6)) + 72) / 72, 0, 1) * 100;
  $('meterFill').style.width = `${toPct(eng.level)}%`;
  $('meterThresh').style.left = `${toPct(detectionFloor())}%`;
}

function bindUI() {
  $('startBtn').addEventListener('click', () => (eng.running ? stop() : start()));
  $('bpm').addEventListener('change', (e) => setBpm(e.target.value));
  $('bpmDown').addEventListener('click', () => setBpm(settings.bpm - 1));
  $('bpmUp').addEventListener('click', () => setBpm(settings.bpm + 1));
  $('subdiv').addEventListener('change', (e) => { settings.subdiv = Number(e.target.value); saveSettings(); eng.hits = []; });
  $('beats').addEventListener('change', (e) => { settings.beatsPerBar = Number(e.target.value); saveSettings(); });
  $('inputMode').addEventListener('change', async (e) => {
    settings.inputMode = e.target.value;
    saveSettings();
    eng.hits = [];
    eng.calib = null;
    if (eng.running) {
      if (settings.inputMode === 'mic') { try { await ensureMic(); } catch { toast('Microphone access was blocked.'); } }
      else stopMic();
    }
    updateUI();
  });
  $('device').addEventListener('change', async (e) => {
    settings.deviceId = e.target.value;
    saveSettings();
    if (eng.running && settings.inputMode === 'mic') { stopMic(); await ensureMic(); }
  });
  $('sens').addEventListener('input', (e) => { settings.sensitivity = Number(e.target.value); saveSettings(); sendSensitivity(); });
  $('clickVol').addEventListener('input', (e) => {
    settings.clickVol = Number(e.target.value) / 100;
    saveSettings();
    if (eng.clickBus) eng.clickBus.gain.value = settings.clickVol;
    $('clickVolPct').textContent = `${Math.round(settings.clickVol * 100)}%`;
  });
  $('clickVol').addEventListener('change', previewClick); // on release
  const soundSel = $('clickSound');
  for (const [key, s] of Object.entries(CLICK_SOUNDS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = s.label;
    soundSel.appendChild(o);
  }
  soundSel.addEventListener('change', (e) => {
    settings.clickSound = e.target.value;
    saveSettings();
    previewClick();
  });
  $('flip').addEventListener('change', (e) => { settings.flip = e.target.checked; saveSettings(); });
  $('calibBtn').addEventListener('click', startCalibration);
  $('resetLatency').addEventListener('click', () => {
    settings.latency[settings.inputMode] = null;
    saveSettings();
    updateUI();
  });

  $('songSelect').addEventListener('change', (e) => selectSong(e.target.value));
  $('songSave').addEventListener('click', saveCurrentSong);
  $('songDelete').addEventListener('click', deleteSelectedSong);
  $('songTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCurrentSong(); });

  // keyboard / touch taps
  const isFormField = (el) => el && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName);
  window.addEventListener('keydown', (ev) => {
    if (ev.repeat || isFormField(ev.target)) return;
    if (!['Space', 'KeyJ', 'KeyF'].includes(ev.code)) return;
    if (settings.inputMode !== 'tap' || !eng.running) return;
    ev.preventDefault();
    onHit(eventToContextTime(ev));
  });
  $('stage').addEventListener('pointerdown', (ev) => {
    if (settings.inputMode !== 'tap' || !eng.running) return;
    onHit(eventToContextTime(ev));
  });
}

bindUI();
renderSongs('');
updateUI();
requestAnimationFrame(draw);
requestAnimationFrame(meterLoop);

// ---------- test hooks (console) ----------
window.drumCoach = {
  settings, eng, view,
  // Feed synthetic hits straight into the analysis (bypasses the detector).
  simulate({ offsetMs = 0, playedBpm = settings.bpm, count = 16 } = {}) {
    if (!eng.running) return 'start first';
    const period = (60 / playedBpm) / settings.subdiv;
    const base = eng.t0 + Math.ceil((eng.ctx.currentTime - eng.t0) / subLen()) * subLen();
    for (let i = 0; i < count; i++) {
      eng.hits.push({ t: base + i * period + offsetMs / 1000 });
    }
    eng.lastHitWall = performance.now();
    analyse();
    return { phaseMs: view.phase * 1000, tempo: view.tempo };
  },
  // Play noise bursts into the real detector at grid + offset (tests the whole chain).
  testSignal({ offsetMs = 0, count = 16, every = 1 } = {}) {
    if (!eng.running) return 'start first';
    const ctx = eng.ctx;
    const len = Math.round(ctx.sampleRate * 0.04);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.6 * Math.exp(-i / (len / 6));
    const sub = subLen();
    const first = eng.t0 + Math.ceil((ctx.currentTime + 0.2 - eng.t0) / sub) * sub;
    for (let i = 0; i < count; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(eng.onset);
      src.start(first + i * sub * every + offsetMs / 1000);
    }
    return `scheduled ${count} bursts`;
  },
};
