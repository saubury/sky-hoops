// Sky Hoops — an arcade game layered on the Sky view.
//
// The Sky engine (sky.js) replays real ADS-B tracks exactly as it does in the
// plain view. The game adds one verb: press and hold on an aircraft to wind up
// a hoop, release to drop it where the aircraft would be N seconds from now if
// it kept flying straight. The real recorded track then decides whether it
// goes through. Longer predictions are worth far more and miss far more often
// (measured on real data: ~85% hit at 15 s, ~50% at 45 s, ~20% at 100 s).

import { sky } from "./sky.js?v=5";

const { THREE, CSS2DObject, scene, camera, renderer, controls, state, hooks, KT, FT, VEX } = sky;
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ROUND_SECONDS = 120;   // real seconds per round
const GAME_SPEED = 8;        // replay speed while playing
const MAX_HOOPS = 4;         // hoops in the air at once
const HOOP_RADIUS = 450;     // metres; what counts as "through"
const LEAD_MIN = 15, LEAD_MAX = 100; // seconds of flight predicted ahead
const CHARGE_SECONDS = 1.6;  // real seconds of holding to reach LEAD_MAX
const FEVER_HITS = 5, FEVER_SECONDS = 10;
const KIND_MULT = { narrow: 1, wide: 1.3, quad: 2, bizjet: 1.3, turboprop: 1.2, turbosingle: 1.3, light: 1.5, lighttwin: 1.5, heli: 2 };
const KIND_SHOUT = { heli: "CHOPPER!", quad: "SUPERJUMBO!", wide: "HEAVY METAL!", light: "TRAINER TAGGED!", lighttwin: "TWIN WIN!" };
const TIERS = [
  { max: 35, css: "#5ad7ff", rgb: [0.35, 2.4, 3.0] },
  { max: 65, css: "#ff4fd8", rgb: [3.0, 0.5, 2.4] },
  { max: 1e9, css: "#ffd23f", rgb: [3.2, 2.2, 0.4] },
];
const tierOf = (lead) => TIERS.find((t) => lead < t.max);
const basePoints = (lead) => 100 * (lead / LEAD_MIN) ** 1.6;
const RANKS = [[0, "Ground Crew"], [2500, "Student Pilot"], [7000, "First Officer"], [14000, "Captain"], [24000, "Hoop Commander"], [40000, "Sky Legend"]];

// Tower calls: short bonus objectives that reward knowing your aircraft. The
// labels only show a callsign and an ICAO type code, so "hoop a wide-body"
// means knowing an A333 is one and a B738 is not. A hit on a matching aircraft
// while the call is live pays triple.
const AUSSIE = new Set(["Qantas", "QantasLink", "Jetstar", "Virgin Australia", "Rex", "Network Aviation", "Alliance Airlines", "Pel-Air", "FlyPelican", "Link Airways", "Bonza", "Toll Aviation", "Team Global Express"]);
const maker = (ac) => (ac.desc || "").toUpperCase();
const CALLS = [
  { text: "a WIDE-BODY", test: (a) => a.kind === "wide" || a.kind === "quad" },
  { text: "a NARROW-BODY JET", test: (a) => a.kind === "narrow" },
  { text: "a FOUR-ENGINED jet", test: (a) => a.kind === "quad" },
  { text: "anything with a PROPELLER", test: (a) => ["turboprop", "turbosingle", "light", "lighttwin"].includes(a.kind) },
  { text: "a twin TURBOPROP", test: (a) => a.kind === "turboprop" },
  { text: "a PISTON-engined aircraft", test: (a) => a.kind === "light" || a.kind === "lighttwin" },
  { text: "a HELICOPTER", test: (a) => a.kind === "heli" },
  { text: "a BOEING", test: (a) => maker(a).startsWith("BOEING") },
  { text: "an AIRBUS", test: (a) => maker(a).startsWith("AIRBUS") },
  { text: "an AUSTRALIAN airline", test: (a) => AUSSIE.has(a.airline) },
  { text: "an OVERSEAS airline", test: (a) => a.airline && !AUSSIE.has(a.airline) },
  // Australia's ICAO 24-bit address block is 7C0000-7FFFFF; anything else is foreign-registered.
  { text: "a FOREIGN-REGISTERED aircraft", test: (a) => !/^7[c-f]/i.test(a.hex) },
  { text: "an aircraft with NO airline callsign", test: (a) => !a.airline },
];
const CALL_SECONDS = 22;
const TITLE_SPIN = 0.6;      // attract-mode orbit on the title and results screens (the Sky view uses 0.25)

const G = {
  call: null, callIn: 6, calls: 0, lastCall: null,
  phase: "title", score: 0, shown: 0, streak: 0, bestStreak: 0, feverMeter: 0, fever: 0,
  timeLeft: ROUND_SECONDS, total: ROUND_SECONDS, hoops: [], thrown: 0, hits: 0, bulls: 0, longest: 0,
  charge: null, gold: null, goldIn: 9, lastBeep: 99, pointer: { x: 0, y: 0 },
};

// ---------------------------------------------------------------------------
// Sound: everything is synthesised with WebAudio, no assets.
// ---------------------------------------------------------------------------

const A = { ctx: null, master: null, sfx: null, music: null, echo: null, muted: false, noiseBuf: null, chargeOsc: null, chargeGain: null, step: 0, nextAt: 0, timer: null, playing: false };
try { A.muted = localStorage.getItem("sky.hoops.muted") === "1"; } catch {}
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function initAudio() {
  if (A.ctx) { if (A.ctx.state !== "running") A.ctx.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = (A.ctx = new Ctx());
  const comp = ctx.createDynamicsCompressor();
  comp.connect(ctx.destination);
  A.master = ctx.createGain(); A.master.gain.value = A.muted ? 0 : 0.9; A.master.connect(comp);
  A.sfx = ctx.createGain(); A.sfx.gain.value = 0.9; A.sfx.connect(A.master);
  A.music = ctx.createGain(); A.music.gain.value = 0.34; A.music.connect(A.master);
  // A feedback delay gives the chimes their sparkle tail.
  const delay = ctx.createDelay(1); delay.delayTime.value = 0.19;
  const fb = ctx.createGain(); fb.gain.value = 0.38;
  A.echo = ctx.createGain(); A.echo.gain.value = 0.5;
  A.echo.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(A.master);
  const buf = (A.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate));
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

// iOS Safari has two extra hurdles. The audio context only starts from inside
// a touchend/click handler, and WebAudio on its own is treated as "ambient"
// sound, which the ring/silent switch mutes. Declaring a playback session (or,
// on older iOS, keeping a silent <audio> element playing) makes it behave like
// a game or music app instead.
let silentEl = null;
function unlockAudio() {
  initAudio();
  if (!A.ctx) return;
  if (A.ctx.state !== "running") A.ctx.resume();
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    else if (!silentEl && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
      // 0.25 s of silence as a WAV: 44-byte header + zeroed 8-bit samples.
      const n = 2000, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
      b.set([82, 73, 70, 70], 0); v.setUint32(4, 36 + n, true); b.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
      v.setUint16(32, 1, true); v.setUint16(34, 8, true); b.set([100, 97, 116, 97], 36); v.setUint32(40, n, true); b.fill(128, 44);
      silentEl = new Audio(URL.createObjectURL(new Blob([b], { type: "audio/wav" })));
      silentEl.loop = true; silentEl.setAttribute("playsinline", "");
    }
    if (silentEl && silentEl.paused) silentEl.play().catch(() => {});
  } catch {}
  // First sound from inside the gesture: some iOS versions only truly start the context once something plays.
  if (V.synth && !V.primed) { V.primed = true; const u = new SpeechSynthesisUtterance(" "); u.volume = 0; V.synth.speak(u); }
  if (!A.kicked) { A.kicked = true; const o = A.ctx.createOscillator(), g = A.ctx.createGain(); g.gain.value = 0.0001; o.connect(g); g.connect(A.ctx.destination); o.start(); o.stop(A.ctx.currentTime + 0.05); }
}
["touchend", "click", "keydown"].forEach((ev) => window.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
document.addEventListener("visibilitychange", () => { if (!document.hidden && A.ctx && A.ctx.state !== "running") A.ctx.resume(); });

function tone(f, { at = 0, dur = 0.2, type = "sine", g = 0.2, to = null, dest = A.sfx, echo = false, attack = 0.005 } = {}) {
  if (!A.ctx) return;
  const t = A.ctx.currentTime + at, o = A.ctx.createOscillator(), v = A.ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  v.gain.setValueAtTime(0.0001, t);
  v.gain.exponentialRampToValueAtTime(g, t + attack);
  v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(v); v.connect(dest);
  if (echo) v.connect(A.echo);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise({ at = 0, dur = 0.2, g = 0.2, from = 800, to = 4000, q = 1, type = "bandpass", dest = A.sfx } = {}) {
  if (!A.ctx) return;
  const t = A.ctx.currentTime + at, s = A.ctx.createBufferSource(), f = A.ctx.createBiquadFilter(), v = A.ctx.createGain();
  s.buffer = A.noiseBuf; s.loop = true;
  f.type = type; f.Q.value = q; f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  v.gain.setValueAtTime(g, t); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(v); v.connect(dest);
  s.start(t); s.stop(t + dur + 0.05);
}

const sfx = {
  throw(frac) { noise({ dur: 0.35, g: 0.25, from: 500, to: 5000 + frac * 3000, q: 2 }); tone(300 + frac * 500, { dur: 0.22, type: "triangle", g: 0.18, to: 1200 + frac * 900 }); },
  denied() { tone(140, { dur: 0.12, type: "square", g: 0.12 }); tone(110, { at: 0.1, dur: 0.16, type: "square", g: 0.12 }); },
  hit(streak) {
    const root = 72 + Math.min(streak, 9);
    [0, 4, 7, 12].forEach((s, i) => tone(midi(root + s), { at: i * 0.06, dur: 0.28, type: "triangle", g: 0.24, echo: true }));
    tone(midi(root - 12), { dur: 0.3, type: "sine", g: 0.3 });
    noise({ dur: 0.18, g: 0.12, from: 6000, to: 9000, type: "highpass" });
  },
  bullseye(streak) {
    const root = 84 + Math.min(streak, 9);
    [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(midi(root + s), { at: 0.2 + i * 0.045, dur: 0.35, type: "sine", g: 0.16, echo: true }));
    tone(midi(root - 24), { dur: 0.5, type: "sawtooth", g: 0.14, to: midi(root - 12) });
  },
  miss() { tone(330, { dur: 0.28, type: "sawtooth", g: 0.11, to: 200 }); tone(247, { at: 0.24, dur: 0.5, type: "sawtooth", g: 0.11, to: 110 }); },
  near() { tone(620, { dur: 0.35, type: "sine", g: 0.16, to: 380 }); },
  call() { noise({ dur: 0.06, g: 0.2, from: 2500, to: 2500, q: 4 }); tone(880, { at: 0.06, dur: 0.08, type: "square", g: 0.12 }); tone(1175, { at: 0.16, dur: 0.14, type: "square", g: 0.12, echo: true }); },
  roger() { [79, 84, 88, 91].forEach((n, i) => tone(midi(n), { at: 0.12 + i * 0.05, dur: 0.3, type: "square", g: 0.1, echo: true })); },
  gold() { tone(midi(83), { dur: 0.09, type: "square", g: 0.14, echo: true }); tone(midi(88), { at: 0.09, dur: 0.45, type: "square", g: 0.14, echo: true }); },
  fever() {
    tone(180, { dur: 0.7, type: "sawtooth", g: 0.16, to: 1800 });
    noise({ dur: 0.8, g: 0.2, from: 300, to: 9000, q: 3 });
    [72, 76, 79, 84].forEach((n) => tone(midi(n), { at: 0.7, dur: 0.9, type: "square", g: 0.09, echo: true }));
  },
  beep(hi) { tone(hi ? 1320 : 660, { dur: hi ? 0.5 : 0.14, type: "square", g: 0.14, echo: hi }); },
  tick() { tone(990, { dur: 0.06, type: "square", g: 0.1 }); },
  fanfare() { [[72, 0], [72, 0.14], [72, 0.28], [76, 0.42], [79, 0.62], [76, 0.78], [84, 0.94]].forEach(([n, at]) => { tone(midi(n), { at, dur: n === 84 ? 1.1 : 0.2, type: "square", g: 0.13, echo: true }); tone(midi(n - 12), { at, dur: 0.22, type: "triangle", g: 0.16 }); }); },
  chargeStart() {
    if (!A.ctx) return;
    sfx.chargeStop();
    const o = (A.chargeOsc = A.ctx.createOscillator()), v = (A.chargeGain = A.ctx.createGain());
    o.type = "sawtooth"; o.frequency.value = 160;
    const f = A.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 1400;
    v.gain.value = 0.0001; v.gain.exponentialRampToValueAtTime(0.09, A.ctx.currentTime + 0.05);
    o.connect(f); f.connect(v); v.connect(A.sfx); o.start();
  },
  chargeSet(frac) { if (A.chargeOsc) A.chargeOsc.frequency.setTargetAtTime(160 + frac * 760 + (frac >= 1 ? Math.sin(performance.now() / 30) * 40 : 0), A.ctx.currentTime, 0.03); },
  chargeStop() {
    if (!A.chargeOsc) return;
    const o = A.chargeOsc, v = A.chargeGain;
    v.gain.cancelScheduledValues(A.ctx.currentTime); v.gain.setTargetAtTime(0.0001, A.ctx.currentTime, 0.02);
    o.stop(A.ctx.currentTime + 0.12);
    A.chargeOsc = A.chargeGain = null;
  },
};

// A small step sequencer: four chords, bass, arpeggio, kick and hats.
const CHORDS = [[57, 0, 3, 7], [53, 0, 4, 7], [48, 0, 4, 7], [55, 0, 4, 7]]; // Am F C G
const ARP = [0, 2, 3, 2, 4, 2, 3, 2, 0, 2, 3, 2, 5, 3, 2, 3];
function musicStep(step, t) {
  const at = t - A.ctx.currentTime, bar = Math.floor(step / 16) % 4, s = step % 16, [root, ...iv] = CHORDS[bar];
  const notes = [iv[0], iv[1], iv[2], iv[0] + 12, iv[1] + 12, iv[2] + 12];
  const fever = G.fever > 0;
  if (s % 4 === 0) { tone(150, { at, dur: 0.16, type: "sine", g: 0.5, to: 45, dest: A.music }); }
  if (s % 4 === 2) noise({ at, dur: 0.05, g: 0.1, from: 7000, to: 9000, type: "highpass", dest: A.music });
  if (s === 4 || s === 12) noise({ at, dur: 0.12, g: 0.16, from: 1800, to: 900, q: 0.8, dest: A.music });
  if ([0, 3, 6, 8, 11, 14].includes(s)) tone(midi(root - 12), { at, dur: 0.2, type: "sawtooth", g: 0.2, dest: A.music });
  tone(midi(root + 12 + notes[ARP[s]]), { at, dur: 0.11, type: fever ? "square" : "triangle", g: fever ? 0.1 : 0.13, dest: A.music });
  if (fever && s % 2 === 1) noise({ at, dur: 0.03, g: 0.07, from: 9000, to: 9500, type: "highpass", dest: A.music });
}
function musicStart() {
  if (!A.ctx || A.playing) return;
  A.playing = true; A.step = 0; A.nextAt = A.ctx.currentTime + 0.08;
  A.timer = setInterval(() => {
    while (A.nextAt < A.ctx.currentTime + 0.12) {
      musicStep(A.step++, A.nextAt);
      A.nextAt += 60 / (G.fever > 0 ? 150 : 124) / 4;
    }
  }, 25);
}
function musicStop() { clearInterval(A.timer); A.playing = false; }

function setMuted(m) {
  A.muted = m;
  if (m) hush();
  if (A.master) A.master.gain.setTargetAtTime(m ? 0 : 0.9, A.ctx.currentTime, 0.02);
  $("gMute").textContent = m ? "♪ off" : "♪ on";
  try { localStorage.setItem("sky.hoops.muted", m ? "1" : "0"); } catch {}
}

// ---------------------------------------------------------------------------
// Tower voice: announcements are spoken with the browser's built-in speech
// synthesis (still no audio files). Speech can't be routed through WebAudio,
// so the radio feel comes from around it: a squelch click to key the mic, a
// bed of static while the tower talks, and the music ducked underneath.
// ---------------------------------------------------------------------------

const V = { synth: window.speechSynthesis || null, on: true, voice: null, cur: null, curPri: -1, pending: null, watchdog: 0, hiss: null, primed: false };
try { V.on = localStorage.getItem("sky.hoops.voice") !== "0"; } catch {}

// An Australian voice if the device has one, then British, then any English.
function pickVoice() {
  const rank = (v) => (/^en[-_]AU/i.test(v.lang) ? 0 : /^en[-_]GB/i.test(v.lang) ? 2 : 4) + (v.localService ? 0 : 1);
  V.voice = V.synth.getVoices().filter((v) => /^en/i.test(v.lang)).sort((a, b) => rank(a) - rank(b))[0] || null;
}

function radio(on) {
  if (!A.ctx) return;
  A.music.gain.setTargetAtTime(on ? 0.12 : 0.34, A.ctx.currentTime, 0.08);
  if (on && !V.hiss) {
    const src = A.ctx.createBufferSource(), f = A.ctx.createBiquadFilter(), g = A.ctx.createGain();
    src.buffer = A.noiseBuf; src.loop = true;
    f.type = "bandpass"; f.frequency.value = 2200; f.Q.value = 0.7; g.gain.value = 0.028;
    src.connect(f); f.connect(g); g.connect(A.sfx); src.start();
    V.hiss = src;
    noise({ dur: 0.05, g: 0.16, from: 2600, to: 2600, q: 4 });
  } else if (!on && V.hiss) {
    V.hiss.stop(); V.hiss = null;
    noise({ dur: 0.08, g: 0.14, from: 3200, to: 1400, q: 2 });
  }
}

// pri 2 interrupts whatever is being said; pri 1 waits its turn (one slot,
// dropped if it goes stale); pri 0 is colour and is skipped when the tower is busy.
function say(text, pri = 1) {
  if (!V.synth || !V.on || A.muted) return;
  if (V.cur) {
    if (pri <= V.curPri) { if (pri > 0) V.pending = { text, pri, by: performance.now() + 5000 }; return; }
    V.synth.cancel();
  }
  if (!V.voice) pickVoice();
  const u = new SpeechSynthesisUtterance(text);
  if (V.voice) { u.voice = V.voice; u.lang = V.voice.lang; } else u.lang = "en-AU";
  u.rate = 1.12; u.pitch = 0.8; // clipped and level, like someone who has said it a thousand times today
  const done = () => {
    if (V.cur !== u) return; // an interrupted utterance reporting in late
    clearTimeout(V.watchdog);
    V.cur = null; V.curPri = -1;
    radio(false);
    const next = V.pending; V.pending = null;
    if (next && performance.now() < next.by) say(next.text, next.pri);
  };
  u.onend = u.onerror = done;
  V.cur = u; V.curPri = pri; V.pending = null;
  clearTimeout(V.watchdog);
  V.watchdog = setTimeout(done, 2500 + text.length * 110); // some browsers never fire onend
  radio(true);
  V.synth.speak(u);
}

function hush() {
  clearTimeout(V.watchdog);
  V.cur = V.pending = null; V.curPri = -1;
  if (V.synth) V.synth.cancel();
  radio(false);
}

function setVoice(on) {
  V.on = on;
  if (!on) hush();
  $("gVoice").textContent = on ? "ATC on" : "ATC off";
  try { localStorage.setItem("sky.hoops.voice", on ? "1" : "0"); } catch {}
}

// Callsigns the way a controller reads them: "QFA427" is "Qantas four two
// seven", and an aircraft flying under its registration goes by its last
// three letters, "VH-XKQ" is "X-ray Kilo Quebec".
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const NATO = { A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel", I: "India", J: "Juliett", K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee", Z: "Zulu" };
const spell = (str) => [...str.toUpperCase()].map((c) => DIGITS[c] || NATO[c] || "").filter(Boolean).join(" ");
function callsign(ac) {
  const m = /^[A-Z]{2,4}(\d\w*)$/.exec(ac.flight);
  if (ac.airline && m) return ac.airline + " " + spell(m[1]);
  const id = (ac.flight || ac.reg || "").replace(/[^A-Za-z0-9]/g, "");
  return id ? spell(id.slice(-3)) : "unidentified traffic";
}
const KIND_SAY = { heli: "Chopper down the hoop.", quad: "Super jumbo, through the hoop.", wide: "Heavy, through the hoop.", light: "Trainer tagged.", lighttwin: "Twin, through the hoop." };

// ---------------------------------------------------------------------------
// Scene effects: hoops, sparks, shockwaves, pop-ups
// ---------------------------------------------------------------------------

const fx = new THREE.Group();
scene.add(fx);
const TORUS = new THREE.TorusGeometry(1, 0.075, 10, 56);
const TORUS_THIN = new THREE.TorusGeometry(1, 0.022, 6, 56);
// Pixel-art mode: chunkier rings (the thin ones would be under one art pixel) with visible corners.
const TORUS_PX = new THREE.TorusGeometry(1, 0.15, 4, 20);
const TORUS_THIN_PX = new THREE.TorusGeometry(1, 0.07, 4, 20);
const P = { on: false, font: false };
try { P.on = localStorage.getItem("sky.hoops.pixel") === "1"; } catch {}
function setPixelMode(on) {
  P.on = on;
  if (on && !P.font) { // the pixel typeface is only fetched if the mode is used
    P.font = true;
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "https://fonts.googleapis.com/css2?family=VT323&display=swap";
    document.head.appendChild(link);
  }
  document.body.classList.toggle("pixel", on);
  sky.setPixel(on);
  $("gPixel").textContent = on ? "8-bit on" : "8-bit off";
  try { localStorage.setItem("sky.hoops.pixel", on ? "1" : "0"); } catch {}
}
const DISC = new THREE.CircleGeometry(1, 40);
const hdr = (rgb, k = 1) => new THREE.Color().setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k);
// Drawn size only: the hit test always uses HOOP_RADIUS. Pixel mode draws aircraft three times as big, so hoops grow to match.
const visRadius = (pos) => Math.max(HOOP_RADIUS, camera.position.distanceTo(pos) * 0.028) * (P.on ? 2.4 : 1);

function makeHoopMesh(tier, ghost = false) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(P.on ? TORUS_PX : TORUS, new THREE.MeshBasicMaterial({ color: hdr(tier.rgb), transparent: ghost, opacity: ghost ? 0.55 : 1 }));
  const timing = new THREE.Mesh(P.on ? TORUS_THIN_PX : TORUS_THIN, new THREE.MeshBasicMaterial({ color: hdr(tier.rgb, 0.7), transparent: true, opacity: 0.8 }));
  const disc = new THREE.Mesh(DISC, new THREE.MeshBasicMaterial({ color: hdr(tier.rgb, 0.4), transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }));
  group.add(ring, timing, disc);
  group.userData = { ring, timing, disc };
  return group;
}
function setHoopTier(group, tier) {
  const { ring, timing, disc } = group.userData;
  ring.material.color.copy(hdr(tier.rgb)); timing.material.color.copy(hdr(tier.rgb, 0.7)); disc.material.color.copy(hdr(tier.rgb, 0.4));
}
function disposeHoop(group) {
  fx.remove(group);
  Object.values(group.userData).forEach((m) => m.material.dispose());
}

// Sparks: one pooled point cloud.
const SPARKS = 3000;
const sp = { pos: new Float32Array(SPARKS * 3), col: new Float32Array(SPARKS * 4), vel: new Float32Array(SPARKS * 3), life: new Float32Array(SPARKS), max: new Float32Array(SPARKS), grav: new Float32Array(SPARKS), next: 0 };
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute("position", new THREE.BufferAttribute(sp.pos, 3));
sparkGeo.setAttribute("color", new THREE.BufferAttribute(sp.col, 4));
const dot = document.createElement("canvas"); dot.width = dot.height = 32;
{
  const g = dot.getContext("2d"), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "#fff"); grad.addColorStop(0.4, "rgba(255,255,255,0.8)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
}
const sparkMat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, depthTest: false, map: new THREE.CanvasTexture(dot), blending: THREE.AdditiveBlending, fog: false });
const sparks = new THREE.Points(sparkGeo, sparkMat);
sparks.frustumCulled = false; sparks.renderOrder = 20;
scene.add(sparks);

function burst(pos, rgbs, count, speed, life = 1.3) {
  for (let n = 0; n < count; n++) {
    const i = sp.next; sp.next = (sp.next + 1) % SPARKS;
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), v = speed * (0.35 + Math.random() * 0.9);
    sp.pos.set([pos.x, pos.y, pos.z], i * 3);
    sp.vel.set([r * Math.cos(th) * v, u * v + speed * 0.25, r * Math.sin(th) * v], i * 3);
    const c = rgbs[n % rgbs.length], k = 0.6 + Math.random() * 0.8;
    sp.col.set([c[0] * k, c[1] * k, c[2] * k, 1], i * 4);
    sp.life[i] = sp.max[i] = life * (0.5 + Math.random() * 0.7);
    sp.grav[i] = speed * 0.55;
  }
}
function updateSparks(dt) {
  const drag = Math.exp(-dt * 1.6);
  for (let i = 0; i < SPARKS; i++) {
    if (sp.life[i] <= 0) continue;
    sp.life[i] -= dt;
    const j = i * 3;
    sp.vel[j] *= drag; sp.vel[j + 1] = sp.vel[j + 1] * drag - sp.grav[i] * dt; sp.vel[j + 2] *= drag;
    sp.pos[j] += sp.vel[j] * dt; sp.pos[j + 1] += sp.vel[j + 1] * dt; sp.pos[j + 2] += sp.vel[j + 2] * dt;
    sp.col[i * 4 + 3] = Math.max(sp.life[i] / sp.max[i], 0) ** 0.7;
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.color.needsUpdate = true;
  sparkMat.blending = state.day ? THREE.NormalBlending : THREE.AdditiveBlending;
}

const waves = [];
function shockwave(pos, rotY, rgb, size, dur = 0.7, grow = 3.5) {
  const mesh = new THREE.Mesh(P.on ? TORUS_THIN_PX : TORUS_THIN, new THREE.MeshBasicMaterial({ color: hdr(rgb, 1.3), transparent: true, depthWrite: false }));
  mesh.position.copy(pos); mesh.rotation.y = rotY;
  fx.add(mesh);
  waves.push({ mesh, age: 0, dur, size, grow });
}
function updateWaves(dt) {
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i], k = (w.age += dt) / w.dur;
    if (k >= 1) { fx.remove(w.mesh); w.mesh.material.dispose(); waves.splice(i, 1); continue; }
    w.mesh.scale.setScalar(w.size * (1 + (1 - (1 - k) ** 3) * w.grow));
    w.mesh.material.opacity = (1 - k) ** 1.5;
  }
}

function popup(pos, html, cls = "", css = "#fff") {
  const wrap = document.createElement("div"), el = document.createElement("div");
  el.className = "pop " + cls; el.style.setProperty("--pc", css); el.innerHTML = html;
  wrap.appendChild(el);
  const o = new CSS2DObject(wrap);
  o.position.copy(pos);
  scene.add(o);
  setTimeout(() => { scene.remove(o); wrap.remove(); }, 1500);
}

let toastUntil = 0;
function toast(text, sub = "", css = "#5ad7ff", force = false) {
  const now = performance.now();
  if (!force && now < toastUntil) return;
  toastUntil = now + 900;
  const el = document.createElement("div");
  el.style.setProperty("--tc", css);
  el.innerHTML = text + (sub ? `<small>${sub}</small>` : "");
  $("gToast").replaceChildren(el);
  setTimeout(() => el.remove(), 1500);
}
function flash(css) {
  const f = $("gFlash");
  f.style.setProperty("--fc", css); f.classList.remove("on"); void f.offsetWidth; f.classList.add("on");
}
function shake() { const s = $("stage"); s.classList.remove("shake"); void s.offsetWidth; s.classList.add("shake"); }
function bump(id) { const e = $(id); e.classList.remove("bump"); void e.offsetWidth; e.classList.add("bump"); }
function confetti(n = 140) {
  const box = $("gConfetti"), cols = ["#5ad7ff", "#ff4fd8", "#ffd23f", "#7dff6b", "#fff"];
  for (let i = 0; i < n; i++) {
    const c = document.createElement("i");
    c.style.cssText = `left:${Math.random() * 100}%;background:${cols[i % cols.length]};animation-duration:${1.8 + Math.random() * 2.2}s;animation-delay:${Math.random() * 0.8}s;--dx:${(Math.random() - 0.5) * 300}px;--rot:${(Math.random() - 0.5) * 1800}deg`;
    box.appendChild(c);
    setTimeout(() => c.remove(), 5200);
  }
}

// ---------------------------------------------------------------------------
// Aiming and throwing
// ---------------------------------------------------------------------------

// Where the aircraft would be `lead` seconds from now if it held heading, speed and climb rate.
function predict(ac, lead, out) {
  const c = ac.cur, d = c.gs * KT * lead;
  return out.set(c.pos.x + Math.sin(c.hdg) * d, Math.max(c.alt + (c.vr / 60) * lead, 0) * FT * VEX, c.pos.z - Math.cos(c.hdg) * d);
}

const ghost = makeHoopMesh(TIERS[0], true);
ghost.visible = false;
fx.add(ghost);
const aimGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const aimLine = new THREE.Line(aimGeo, new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, dashSize: 300, gapSize: 200, depthWrite: false }));
aimLine.visible = false; aimLine.frustumCulled = false;
fx.add(aimLine);

const raycaster = new THREE.Raycaster();
function planeAt(x, y) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
  const hits = raycaster.intersectObjects(state.aircraft.filter((a) => a.group.visible).map((a) => a.hit), false);
  return hits.length ? hits[0].object.userData.ac : null;
}

function beginCharge(ac, e) {
  if (G.phase !== "play" || G.charge) return;
  G.pointer.x = e.clientX; G.pointer.y = e.clientY;
  if (!ac.cur.visible || ac.cur.alt < 50 || ac.hoop || G.hoops.length >= MAX_HOOPS) {
    sfx.denied();
    const why = ac.hoop ? "ALREADY HOOPED" : G.hoops.length >= MAX_HOOPS ? "OUT OF HOOPS" : "ON THE GROUND";
    popup(ac.cur.pos, why, "miss", "#ffb199");
    say("Negative. " + (ac.hoop ? "Already hooped." : G.hoops.length >= MAX_HOOPS ? "Out of hoops." : "Traffic is on the ground."), 0);
    return;
  }
  G.charge = { ac, t0: performance.now() };
  controls.enabled = false;
  ghost.visible = aimLine.visible = true;
  $("gCharge").classList.remove("hidden");
  sfx.chargeStart();
}

function endCharge(release) {
  const ch = G.charge;
  if (!ch) return;
  G.charge = null;
  controls.enabled = true;
  ghost.visible = aimLine.visible = false;
  $("gCharge").classList.add("hidden");
  sfx.chargeStop();
  if (release && ch.ac.cur.visible) throwHoop(ch.ac, ch.frac ?? 0);
}

function throwHoop(ac, frac) {
  const lead = LEAD_MIN + frac * (LEAD_MAX - LEAD_MIN), tier = tierOf(lead);
  const group = makeHoopMesh(tier);
  predict(ac, lead, group.position);
  group.rotation.y = -ac.cur.hdg;
  fx.add(group);
  const hoop = { ac, group, tier, lead, t: state.t + lead, pos: group.position, minD: Infinity, gone: 0, born: performance.now() };
  ac.hoop = hoop;
  ac.el.classList.add("hooped");
  G.hoops.push(hoop);
  G.thrown++;
  sfx.throw(frac);
  shockwave(ac.cur.pos, -ac.cur.hdg, tier.rgb, visRadius(ac.cur.pos) * 0.4, 0.45, 2.5);
  renderAmmo();
}

function removeHoop(hoop) {
  G.hoops.splice(G.hoops.indexOf(hoop), 1);
  hoop.ac.hoop = null;
  hoop.ac.el?.classList.remove("hooped");
  disposeHoop(hoop.group);
  renderAmmo();
}

function scoreHit(hoop) {
  const ac = hoop.ac, bull = hoop.minD < HOOP_RADIUS * 0.12, gold = G.gold?.ac === ac, fever = G.fever > 0;
  const called = !!G.call && G.call.def.test(ac);
  const streakMult = Math.min(1 + G.streak * 0.5, 5);
  const mult = (KIND_MULT[ac.kind] || 1) * streakMult * (bull ? 2 : 1) * (gold ? 3 : 1) * (fever ? 2 : 1) * (called ? 3 : 1);
  const pts = Math.round((basePoints(hoop.lead) * mult) / 10) * 10;
  G.score += pts; G.hits++; G.streak++; G.bestStreak = Math.max(G.bestStreak, G.streak);
  if (bull) G.bulls++;
  if (hoop.lead > G.longest) G.longest = hoop.lead;

  const vis = visRadius(hoop.pos), rgb = hoop.tier.rgb, white = [2.5, 2.5, 2.5];
  burst(hoop.pos, gold ? [[3.2, 2.2, 0.4], white] : bull ? [rgb, white, [3, 0.5, 2.4], [0.4, 3, 1]] : [rgb, white], bull || gold ? 320 : 150, vis * (bull ? 2.6 : 1.8), bull ? 1.7 : 1.2);
  shockwave(hoop.pos, hoop.group.rotation.y, rgb, vis);
  if (bull || gold) { shockwave(hoop.pos, hoop.group.rotation.y, white, vis * 0.6, 1.0, 6); shake(); }
  flash(gold ? "#ffd23f" : hoop.tier.css);
  const tags = [called && "TOWER CALL ×3", bull && "BULLSEYE ×2", gold && "GOLDEN ×3", fever && "FEVER ×2", streakMult > 1 && `STREAK ×${streakMult}`].filter(Boolean).join(" · ");
  popup(hoop.pos, `+${pts.toLocaleString("en-AU")}<small>${ac.name}${tags ? " · " + tags : ""}</small>`, pts >= 2000 ? "big" : "", gold ? "#ffd23f" : hoop.tier.css);
  sfx.hit(G.streak);
  if (bull) sfx.bullseye(G.streak);
  bump("gScore"); bump("gCombo");

  if (called) { G.calls++; sfx.roger(); toast("ROGER THAT!", "that is " + G.call.def.text.toLowerCase() + " · triple points", "#7dff6b", true); say("Roger that, " + callsign(ac) + ". Triple points.", 2); clearCall(); }
  else if (gold) { toast("GOLDEN CATCH!", ac.name, "#ffd23f", true); say("Golden catch! " + callsign(ac) + ", triple points.", 2); clearGold(); confetti(40); }
  else if (bull) { toast("BULLSEYE!", "", hoop.tier.css, true); say("Bullseye! " + callsign(ac) + ", dead centre."); }
  else if (hoop.lead > 80) { toast("LONG BOMB!", Math.round(hoop.lead) + " seconds out", "#ffd23f"); say("Long bomb! " + Math.round(hoop.lead) + " seconds out."); }
  else if (G.streak === 3) { toast("HAT-TRICK!", "", "#7dff6b"); say("Hat-trick. Three in a row."); }
  else if (G.streak === 6) { toast("ON FIRE!", "", "#ff8c2b"); say("Six in a row. You are on fire."); }
  else if (G.streak === 9) { toast("UNSTOPPABLE!", "", "#ff4fd8"); say("Niner in a row. Unstoppable."); }
  else if (KIND_SHOUT[ac.kind]) { toast(KIND_SHOUT[ac.kind], "", hoop.tier.css); say(KIND_SAY[ac.kind], 0); }
  else say(callsign(ac) + ", through the hoop.", 0);

  if (gold && G.gold) clearGold();
  if (!fever && (G.feverMeter += bull ? 2 : 1) >= FEVER_HITS) startFever();
  removeHoop(hoop);
}

function scoreMiss(hoop, lost) {
  const close = !lost && hoop.minD < HOOP_RADIUS * 2.2;
  popup(hoop.pos, lost ? "LOST CONTACT" : close ? "SO CLOSE!" : "MISSED", "miss");
  shockwave(hoop.pos, hoop.group.rotation.y, [2.5, 0.4, 0.3], visRadius(hoop.pos), 0.5, -0.7);
  close ? sfx.near() : sfx.miss();
  if (G.streak >= 3) { toast("STREAK BROKEN", "", "#ff7a6a"); say("Streak broken."); }
  else say(lost ? callsign(hoop.ac) + ", radar contact lost." : close ? "So close. " + callsign(hoop.ac) + " going around." : callsign(hoop.ac) + ", missed approach.", 0);
  G.streak = 0;
  if (G.fever <= 0) G.feverMeter = Math.max(0, G.feverMeter - 1);
  removeHoop(hoop);
}

function startFever() {
  G.fever = FEVER_SECONDS; G.feverMeter = FEVER_HITS;
  document.body.classList.add("fever");
  sky.bloom.strength += 0.5;
  sfx.fever();
  toast("FEVER!", "double points", "#ff4fd8", true);
  say("Fever! All hoops double points.");
  confetti(60);
}
function endFever() {
  G.fever = 0; G.feverMeter = 0;
  if (document.body.classList.contains("fever")) sky.bloom.strength = Math.max(0.2, sky.bloom.strength - 0.5);
  document.body.classList.remove("fever");
}

function clearCall() {
  G.call = null;
  G.callIn = 5 + Math.random() * 4;
  $("gCall").classList.add("hidden");
}
function spawnCall() {
  const air = state.aircraft.filter((a) => a.cur.visible && a.cur.alt > 300);
  // Only ask for something that is actually up there, and that isn't most of the sky.
  const ok = CALLS.filter((c) => { const n = air.filter(c.test).length; return c !== G.lastCall && n >= 1 && n <= Math.max(1, air.length * 0.6); });
  if (!ok.length) { G.callIn = 3; return; }
  const def = (G.lastCall = ok[Math.floor(Math.random() * ok.length)]);
  G.call = { def, left: CALL_SECONDS };
  $("gCallText").innerHTML = "Hoop " + def.text.replace(/([A-Z][A-Z-]+(?: [A-Z-]+)*)/, "<b>$1</b>");
  $("gCall").classList.remove("hidden");
  bump("gCall");
  sfx.call();
  say("Tower, all stations. Hoop " + def.text.toLowerCase() + ". Triple points.", 2);
}

function clearGold() {
  if (!G.gold) return;
  G.gold.ac.el?.classList.remove("gold");
  G.gold = null;
  G.goldIn = 12 + Math.random() * 8;
}
function spawnGold() {
  const pool = state.aircraft.filter((a) => a.cur.visible && a.cur.alt > 300 && !a.hoop && a.cur.remaining > 220);
  if (!pool.length) { G.goldIn = 3; return; }
  const ac = pool[Math.floor(Math.random() * pool.length)];
  G.gold = { ac, left: 15 };
  ac.el.classList.add("gold");
  sfx.gold();
  toast("GOLDEN PLANE", ac.name + " · triple points", "#ffd23f");
  say("Traffic alert. Golden plane, " + callsign(ac) + ". Triple points.");
}

// ---------------------------------------------------------------------------
// Per-frame update (called by the Sky engine after aircraft and camera)
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3();
function updateCharge() {
  const ch = G.charge;
  if (!ch) return;
  const ac = ch.ac;
  if (!ac.cur.visible || ac.cur.alt < 50) return endCharge(false);
  const frac = (ch.frac = clamp((performance.now() - ch.t0) / 1000 / CHARGE_SECONDS, 0, 1));
  const lead = LEAD_MIN + frac * (LEAD_MAX - LEAD_MIN), tier = tierOf(lead);
  predict(ac, lead, ghost.position);
  ghost.rotation.y = -ac.cur.hdg;
  ghost.scale.setScalar(visRadius(ghost.position) * (1 + Math.sin(performance.now() / 60) * 0.04));
  ghost.userData.timing.visible = false;
  setHoopTier(ghost, tier);
  aimGeo.setFromPoints([ac.cur.pos, ghost.position]);
  aimLine.computeLineDistances();
  aimLine.material.color.set(tier.css);
  const box = $("gCharge");
  box.style.left = G.pointer.x + "px"; box.style.top = G.pointer.y + "px";
  box.style.setProperty("--cc", tier.css);
  box.firstElementChild.textContent = "+" + (Math.round(basePoints(lead) / 10) * 10).toLocaleString("en-AU");
  box.children[1].textContent = Math.round(lead) + " S AHEAD" + (frac >= 1 ? " · MAX" : "");
  box.lastElementChild.firstElementChild.style.width = frac * 100 + "%";
  sfx.chargeSet(frac);
}

function updateHoops(dt, now) {
  for (const hoop of [...G.hoops]) {
    const ac = hoop.ac, { ring, timing, disc } = hoop.group.userData;
    const vis = visRadius(hoop.pos), appear = clamp((now - hoop.born) / 250, 0, 1);
    hoop.group.scale.setScalar(vis * (0.3 + 0.7 * (1 - (1 - appear) ** 3)));
    ring.rotation.z += dt * 1.2;
    const left = clamp((hoop.t - state.t) / hoop.lead, 0, 1);
    timing.scale.setScalar(1 + left * 1.6); // closes onto the hoop as the aircraft is due
    disc.material.opacity = 0.1 + 0.08 * Math.sin(now / 130);

    if (ac.cur.visible) {
      hoop.gone = 0;
      const d = ac.cur.pos.distanceTo(hoop.pos);
      if (d < hoop.minD) hoop.minD = d;
      if (hoop.minD < HOOP_RADIUS && d > hoop.minD + 25) scoreHit(hoop);
      else if (state.t > hoop.t + Math.max(8, hoop.lead * 0.3)) hoop.minD < HOOP_RADIUS ? scoreHit(hoop) : scoreMiss(hoop, false);
    } else if ((hoop.gone += dt) > 1.2) {
      hoop.minD < HOOP_RADIUS ? scoreHit(hoop) : scoreMiss(hoop, true);
    }
  }
}

function renderAmmo() {
  const used = G.hoops.length;
  $("gAmmo").innerHTML = Array.from({ length: MAX_HOOPS }, (_, i) => `<span class="${i < MAX_HOOPS - used ? "" : "used"}"></span>`).join("");
}

function renderHud(dt) {
  G.shown += (G.score - G.shown) * Math.min(1, dt * 9);
  if (G.score - G.shown < 6) G.shown = G.score;
  $("gScore").textContent = Math.round(G.shown).toLocaleString("en-AU");
  const mult = Math.min(1 + G.streak * 0.5, 5) * (G.fever > 0 ? 2 : 1);
  $("gCombo").textContent = "×" + mult + (G.fever > 0 ? " FEVER" : "");
  $("gFeverBar").firstElementChild.style.width = (G.fever > 0 ? G.fever / FEVER_SECONDS : G.feverMeter / FEVER_HITS) * 100 + "%";
  $("gTimer").textContent = Math.ceil(Math.max(G.timeLeft, 0));
  $("gTimerArc").style.strokeDashoffset = 276.5 * (1 - clamp(G.timeLeft / G.total, 0, 1));
  $("gTimerBox").classList.toggle("low", G.timeLeft <= 10);
}

hooks.frame = (dt, now) => {
  if (document.body.dataset.phase !== G.phase) document.body.dataset.phase = G.phase; // lets the stylesheet lay out per phase
  if (G.phase === "play") {
    G.timeLeft -= dt;
    if (G.fever > 0 && (G.fever -= dt) <= 0) endFever();
    if (G.gold) {
      if ((G.gold.left -= dt) <= 0 || !G.gold.ac.cur.visible) clearGold();
    } else if ((G.goldIn -= dt) <= 0) spawnGold();
    if (G.call) {
      $("gCallBar").style.width = (G.call.left / CALL_SECONDS) * 100 + "%";
      if ((G.call.left -= dt) <= 0) { clearCall(); say("Tower call cancelled.", 0); }
    } else if ((G.callIn -= dt) <= 0) spawnCall();
    updateCharge();
    updateHoops(dt, now);
    const sec = Math.ceil(G.timeLeft);
    if (sec <= 10 && sec < G.lastBeep && sec > 0) { G.lastBeep = sec; sfx.tick(); }
    if ((sec === 60 || sec === 30 || sec === 10) && G.timeCall !== sec && G.total > sec) { G.timeCall = sec; say(sec === 60 ? "One minute remaining." : sec === 30 ? "Thirty seconds remaining." : "Ten seconds.", sec === 10 ? 2 : 1); }
    renderHud(dt);
    if (G.timeLeft <= 0) gameOver();
  }
  updateSparks(dt);
  updateWaves(dt);
};

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function clearField() {
  endCharge(false);
  [...G.hoops].forEach(removeHoop);
  clearGold();
  clearCall();
  endFever();
}

function show(id, on) { $(id).classList.toggle("hidden", !on); }

function toTitle() {
  clearField();
  musicStop();
  hush();
  G.phase = "title";
  show("gTitle", true); show("gOver", false); show("gHud", false); show("gCount", false);
  state.speed = 6;
  controls.autoRotate = true;
  controls.autoRotateSpeed = TITLE_SPIN;
}

// Start where the next couple of minutes of replay have the most traffic.
function busiestStart(need) {
  const h = state.histogram;
  if (!h || state.duration <= need) return 0;
  const w = state.duration / h.length, span = Math.ceil(need / w);
  let best = 0, bestSum = -1, sum = 0;
  for (let i = 0; i < h.length; i++) {
    sum += h[i];
    if (i >= span) sum -= h[i - span];
    if (i >= span - 1 && sum > bestSum) { bestSum = sum; best = i - span + 1; }
  }
  return best * w;
}

function startGame() {
  if (G.phase === "count" || G.phase === "play" || !state.aircraft.length) return;
  initAudio();
  clearField();
  const need = ROUND_SECONDS * GAME_SPEED + LEAD_MAX * 1.5;
  state.t = busiestStart(need);
  state.speed = GAME_SPEED;
  sky.setPlaying(true);
  Object.assign(G, {
    phase: "count", score: 0, shown: 0, streak: 0, bestStreak: 0, feverMeter: 0, thrown: 0, hits: 0, bulls: 0, longest: 0, goldIn: 9, lastBeep: 99, timeCall: 0, callIn: 6, calls: 0,
    total: Math.min(ROUND_SECONDS, Math.max(20, (state.duration - state.t - LEAD_MAX) / GAME_SPEED)),
  });
  G.timeLeft = G.total;
  show("gTitle", false); show("gOver", false); show("gHud", true);
  $("gBest").textContent = "best " + bestScore().toLocaleString("en-AU");
  renderAmmo(); renderHud(1);
  controls.autoRotate = false;
  sky.flyHome();

  say("All stations, Sky Hoops tower. Stand by.", 2);
  let n = 3;
  const tickDown = () => {
    if (G.phase !== "count") return;
    const el = $("gCountNum");
    show("gCount", true);
    el.textContent = n > 0 ? n : "GO!";
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    sfx.beep(n === 0);
    if (n-- > 0) return setTimeout(tickDown, 750);
    G.phase = "play";
    musicStart();
    say("Cleared for takeoff.", 2);
    setTimeout(() => show("gCount", false), 700);
  };
  tickDown();
}

function bestScore() { try { return +localStorage.getItem("sky.hoops.best") || 0; } catch { return 0; } }

function gameOver() {
  clearField();
  musicStop();
  G.phase = "over";
  state.speed = 5;
  controls.autoRotate = true;
  controls.autoRotateSpeed = TITLE_SPIN;
  const best = bestScore(), isBest = G.score > best && G.score > 0;
  if (isBest) { try { localStorage.setItem("sky.hoops.best", String(G.score)); } catch {} }
  $("gFinal").textContent = G.score.toLocaleString("en-AU");
  const rank = RANKS.filter(([min]) => G.score >= min).pop()[1];
  $("gRank").textContent = rank;
  show("gNewBest", isBest);
  const acc = G.thrown ? Math.round((G.hits / G.thrown) * 100) : 0;
  $("gStats").innerHTML = [
    [G.hits + " / " + G.thrown, "hoops scored"], [acc + "%", "accuracy"], [G.bulls, "bullseyes"],
    [G.bestStreak + " in a row", "best streak"], [G.calls, "tower calls"], [Math.max(best, G.score).toLocaleString("en-AU"), "best score"],
  ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("");
  show("gHud", false); show("gOver", true);
  sfx.fanfare();
  say("Time. All stations, round complete. Final score, " + G.score + ". Rank, " + rank + "." + (isBest ? " New personal best." : "") + " Tower out.", 2);
  confetti(isBest ? 220 : 110);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// Capture phase on the canvas's parent: a press that lands on an aircraft
// starts a throw and never reaches the camera controls.
$("stage").addEventListener("pointerdown", (e) => {
  if (G.phase !== "play" || e.button !== 0) return;
  const ac = planeAt(e.clientX, e.clientY);
  if (!ac) return;
  e.stopPropagation(); e.preventDefault();
  beginCharge(ac, e);
}, true);
$("labels").addEventListener("pointerdown", (e) => {
  const tag = e.target.closest?.(".tag");
  if (!tag || G.phase !== "play" || e.button !== 0) return;
  const ac = state.byHex.get(tag.dataset.hex);
  if (ac) { e.preventDefault(); beginCharge(ac, e); }
});
window.addEventListener("pointermove", (e) => { G.pointer.x = e.clientX; G.pointer.y = e.clientY; });
window.addEventListener("pointerup", () => endCharge(true));
window.addEventListener("pointercancel", () => endCharge(false));
window.addEventListener("blur", () => endCharge(false));
// A long press on a phone would otherwise open the context menu / text callout mid-throw.
window.addEventListener("contextmenu", (e) => { if (e.target.tagName !== "SELECT") e.preventDefault(); });

hooks.pick = () => true; // clicking an aircraft never opens the Sky view's flight card here
hooks.key = (e) => {
  const k = e.key.toLowerCase();
  if (k === " " || k === "enter") { e.preventDefault(); if (G.phase === "title" || G.phase === "over") startGame(); return true; }
  if (k === "m") { setMuted(!A.muted); return true; }
  if (k === "v") { setVoice(!V.on); return true; }
  if (k === "p") { setPixelMode(!P.on); return true; }
  if (k === "escape") { if (G.phase === "play" || G.phase === "count") toTitle(); return true; }
  return ["1", "2", "3", "4", "5", "6", "arrowleft", "arrowright", "d"].includes(k); // Sky-view shortcuts that make no sense mid-game
};
hooks.loaded = toTitle;

$("gStart").addEventListener("click", startGame);
$("gAgain").addEventListener("click", startGame);
$("gMute").addEventListener("click", () => { initAudio(); setMuted(!A.muted); });
$("gVoice").addEventListener("click", () => { initAudio(); setVoice(!V.on); });
$("gPixel").addEventListener("click", () => setPixelMode(!P.on));
setMuted(A.muted);
setPixelMode(P.on);
setVoice(V.on && !!V.synth);
if (!V.synth) $("gVoice").classList.add("hidden");
renderAmmo();
if (state.aircraft.length) toTitle();

window.__hoops = { G, startGame, throwHoop, state }; // handy for poking at the game from the console
