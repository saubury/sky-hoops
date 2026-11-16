// Sky engine for Sky Hoops: a 3D replay of recorded ADS-B aircraft tracks.
//
// data/windows.json lists the recorded stretches of traffic and
// data/window_<start>_<end>.json holds every aircraft track in one of them.
// Tracks are resampled onto a smooth 2-second spline here, so playback is
// continuous at any speed rather than hopping between 10-second reports.
//
// Scene units are metres: +X east, +Y up, -Z north, origin at Sydney Airport.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const REF = [-33.9401302, 151.175371]; // feed centre (YSSY)
const TOWER = [-33.9437, 151.1808];
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(REF[0] * DEG);
const FT = 0.3048;
const KT = 0.5144;
const NM = 1852;
const VEX = 2;            // vertical exaggeration — makes climbs/descents readable at city scale
const STEP = 2;           // resample interval, seconds
const GAP = 60;           // a silence longer than this splits a track into separate segments
const TRAIL_SECONDS = 300;
const MIN_PLANE_SCALE = 3;
const HOME_POS = new THREE.Vector3(-20000, 24000, 46000);
const HOME_TARGET = new THREE.Vector3(0, 1500, -2000);
// A portrait phone sees a much narrower slice of the scene, so start further back.
if (window.innerWidth < window.innerHeight) HOME_POS.sub(HOME_TARGET).multiplyScalar(1.75).add(HOME_TARGET);

// YSSY runway thresholds (same as the 2D/3D radar view).
const RUNWAYS = [
  { a: [-33.9496, 151.1880], b: [-33.9711, 151.1940] },
  { a: [-33.9294, 151.1720], b: [-33.9643, 151.1810] },
  { a: [-33.9437, 151.1640], b: [-33.9375, 151.1900] },
];

// Callsign prefix -> [operator, tail colour]
const AIRLINES = {
  QFA: ["Qantas", "#e4002b"], QLK: ["QantasLink", "#e4002b"], QJE: ["QantasLink", "#e4002b"], JST: ["Jetstar", "#ff5a00"],
  VOZ: ["Virgin Australia", "#c8102e"], RXA: ["Rex", "#1d5fbf"], ANZ: ["Air New Zealand", "#00b2a9"],
  SIA: ["Singapore Airlines", "#f5b301"], UAE: ["Emirates", "#d71a21"], QTR: ["Qatar Airways", "#8a1538"],
  CPA: ["Cathay Pacific", "#00857c"], UAL: ["United", "#1f6fd1"], AAL: ["American", "#9aa7b5"], DAL: ["Delta", "#c8102e"],
  FJI: ["Fiji Airways", "#a05a2c"], CES: ["China Eastern", "#2b5fb4"], CSN: ["China Southern", "#1b9ad6"],
  CCA: ["Air China", "#d6002a"], CHH: ["Hainan Airlines", "#d6002a"], CXA: ["XiamenAir", "#3aa0e0"],
  JAL: ["Japan Airlines", "#d6002a"], ANA: ["All Nippon", "#2456b8"], KAL: ["Korean Air", "#5bc2e7"], AAR: ["Asiana", "#b0b0b0"],
  THA: ["Thai Airways", "#7b3fa0"], MAS: ["Malaysia Airlines", "#1d5fbf"], GIA: ["Garuda Indonesia", "#00a0a0"],
  ETD: ["Etihad", "#c79a3b"], ACA: ["Air Canada", "#e4002b"], BAW: ["British Airways", "#2456b8"], LAN: ["LATAM", "#e4006d"],
  HAL: ["Hawaiian", "#7b3fa0"], PAL: ["Philippine Airlines", "#2456b8"], CEB: ["Cebu Pacific", "#f5b301"],
  VJC: ["VietJet", "#e4002b"], HVN: ["Vietnam Airlines", "#00839b"], TGW: ["Scoot", "#ffe100"], AXM: ["AirAsia", "#e4002b"],
  XAX: ["AirAsia X", "#e4002b"], IAD: ["Indonesia AirAsia X", "#e4002b"], BTK: ["Batik Air", "#b0202b"], AIC: ["Air India", "#e4572e"],
  ALK: ["SriLankan", "#b0202b"], THY: ["Turkish Airlines", "#e4002b"], FDX: ["FedEx", "#7b3fa0"], UPS: ["UPS", "#8a5a2b"],
  TFR: ["Toll Aviation", "#3aa055"], TFX: ["Team Global Express", "#3aa055"], PFY: ["Pel-Air", "#1d5fbf"],
  FD: ["Royal Flying Doctor Service", "#e4002b"], AM: ["Air Ambulance", "#e4002b"], POL: ["Police Air Wing", "#2456b8"],
  RSCU: ["Rescue helicopter", "#ffb000"], NWK: ["Network Aviation", "#e4002b"], UTY: ["Alliance Airlines", "#1d5fbf"],
  FLYC: ["FlyPelican", "#00a0a0"], BNZ: ["Bonza", "#7b3fa0"], LNK: ["Link Airways", "#1d5fbf"],
};

// Altitude colour ramp (feet -> colour)
const ALT_STOPS = [
  [0, "#ff4d3a"], [3000, "#ff8c2b"], [8000, "#ffd84a"], [16000, "#58f0a0"], [28000, "#3fc8ff"], [40000, "#8e86ff"],
].map(([ft, hex]) => [ft, new THREE.Color(hex)]);

function altColor(ft, out = new THREE.Color()) {
  if (ft <= ALT_STOPS[0][0]) return out.copy(ALT_STOPS[0][1]);
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (ft <= ALT_STOPS[i][0]) {
      const [f0, c0] = ALT_STOPS[i - 1], [f1, c1] = ALT_STOPS[i];
      return out.copy(c0).lerp(c1, (ft - f0) / (f1 - f0));
    }
  }
  return out.copy(ALT_STOPS[ALT_STOPS.length - 1][1]);
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toX = (lon) => (lon - REF[1]) * M_PER_DEG_LON;
const toZ = (lat) => -(lat - REF[0]) * M_PER_DEG_LAT;
const ground = (lat, lon, y = 0) => new THREE.Vector3(toX(lon), y, toZ(lat));

function fmtAlt(ft) {
  if (ft < 50) return "GND";
  if (ft >= 10000) return "FL" + String(Math.round(ft / 100)).padStart(3, "0");
  return (Math.round(ft / 25) * 25).toLocaleString("en-AU") + " ft";
}

// ---------------------------------------------------------------------------
// Renderer, scene, post-processing
// ---------------------------------------------------------------------------

const stage = $("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer({ element: $("labels") });

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color("#0b1a2b");
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0000075);

const camera = new THREE.PerspectiveCamera(50, 1, 5, 3e6);
camera.position.copy(HOME_POS);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.7, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.copy(HOME_TARGET);
controls.minDistance = 300;
controls.maxDistance = 220000;
controls.maxPolarAngle = 88 * DEG;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.25;

const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x0c1420, 1.3);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-0.5, 1, 0.6);
scene.add(sun);

// Shared uniforms for every trail material
const uTime = { value: 0 };
const uTrail = { value: TRAIL_SECONDS };
const uPxScale = { value: 0.001 };
const uGain = { value: 1.9 }; // trail brightness: glowing at night, plain colour by day
const uCurtain = { value: 1 }; // dimmed for the tower's long lens, where a curtain can fill the frame

// ---------------------------------------------------------------------------
// Static world: sky, stars, map tiles, runways, range rings
// ---------------------------------------------------------------------------

let skyMat, stars, groundBase;
const GROUND_TINT = new THREE.Color();
const tileMats = [];

function buildSky() {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1.5e6, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
      uniforms: { uHorizon: { value: FOG_COLOR }, uGlow: { value: new THREE.Color("#3a2440") }, uZenith: { value: new THREE.Color("#01030a") } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uHorizon, uGlow, uZenith; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -1.0, 1.0);
          vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
          // a faint band of last light along the western horizon
          float west = smoothstep(-0.2, 1.0, -vDir.x);
          c += uGlow * west * exp(-abs(h) * 9.0) * 0.9;
          if (h < 0.0) c = uHorizon;
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
  );
  skyMat = sky.material;
  sky.renderOrder = -30;
  sky.frustumCulled = false;
  scene.add(sky);

  const n = 2200, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const az = Math.random() * Math.PI * 2, el = Math.asin(0.04 + Math.random() * 0.96), r = 1.2e6;
    pos.set([Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r], i * 3);
    const b = (0.25 + Math.random() ** 3 * 1.2) * Math.min(1, el * 4);
    col.set([b * 0.85, b * 0.92, b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthTest: false, depthWrite: false, transparent: true }));
  stars.renderOrder = -29;
  stars.frustumCulled = false;
  scene.add(stars);
}

// Satellite imagery laid flat as the ground and graded down to a moonlit
// blue. Three rings: sharp tiles around the airport, medium over the coverage
// area, coarse out to the horizon. Nothing sits below the ground, so tiles
// skip the depth buffer and just draw first (coarse to fine).
function buildGround() {
  const base = groundBase = new THREE.Mesh(new THREE.PlaneGeometry(6e6, 6e6), new THREE.MeshBasicMaterial({ color: 0x04080d, depthTest: false, depthWrite: false }));
  base.rotation.x = -Math.PI / 2;
  base.renderOrder = -22;
  scene.add(base);

  const loader = new THREE.TextureLoader();
  const tileLat = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG;
  const tileLon = (x, n) => (x / n) * 360 - 180;

  function ring(z, radius, order) {
    const n = 2 ** z;
    const cx = Math.floor(((REF[1] + 180) / 360) * n);
    const cy = Math.floor(((1 - Math.asinh(Math.tan(REF[0] * DEG)) / Math.PI) / 2) * n);
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const x = cx + dx, y = cy + dy;
        const nw = ground(tileLat(y, n), tileLon(x, n)), ne = ground(tileLat(y, n), tileLon(x + 1, n));
        const sw = ground(tileLat(y + 1, n), tileLon(x, n)), se = ground(tileLat(y + 1, n), tileLon(x + 1, n));
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute([...nw.toArray(), ...ne.toArray(), ...sw.toArray(), ...se.toArray()], 3));
        g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
        g.setIndex([0, 2, 1, 1, 2, 3]);
        loader.load(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          const mat = new THREE.MeshBasicMaterial({ map: tex, color: GROUND_TINT, depthTest: false, depthWrite: false });
          tileMats.push(mat);
          const mesh = new THREE.Mesh(g, mat);
          mesh.renderOrder = order;
          mesh.frustumCulled = false;
          scene.add(mesh);
        }, undefined, () => {});
      }
    }
  }
  ring(8, 3, -21);
  ring(11, 3, -20);
  ring(13, 3, -19);
}

function buildAirport() {
  const strip = new THREE.MeshBasicMaterial({ color: 0x1a2733, transparent: true, opacity: 0.9, depthWrite: false });
  const lights = [];
  for (const rw of RUNWAYS) {
    const a = ground(...rw.a, 4), b = ground(...rw.b, 4);
    const dir = b.clone().sub(a).normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(30);
    const g = new THREE.BufferGeometry().setFromPoints([a.clone().add(perp), a.clone().sub(perp), b.clone().add(perp), b.clone().sub(perp)]);
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const mesh = new THREE.Mesh(g, strip);
    mesh.renderOrder = -10;
    scene.add(mesh);
    const len = a.distanceTo(b);
    for (let d = 0; d <= len; d += 75) {
      const p = a.clone().addScaledVector(dir, d);
      lights.push(p.clone().add(perp), p.clone().sub(perp));
    }
  }
  const pts = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(lights),
    new THREE.PointsMaterial({ color: new THREE.Color().setRGB(2.4, 1.9, 1.1), size: 2.2, sizeAttenuation: false, depthWrite: false })
  );
  scene.add(pts);

  const geoLabel = (text, pos, cls = "") => {
    const el = document.createElement("div");
    el.className = "geo " + cls;
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.copy(pos);
    scene.add(o);
  };
  geoLabel("SYD · KINGSFORD SMITH", ground(...REF, 250), "big");

  const ringMat = new THREE.LineBasicMaterial({ color: 0x2f7fa8, transparent: true, opacity: 0.35, depthWrite: false });
  for (const nm of [5, 10, 20]) {
    const pts = [];
    for (let i = 0; i <= 180; i++) pts.push(new THREE.Vector3(Math.sin(i * 2 * DEG) * nm * NM, 6, -Math.cos(i * 2 * DEG) * nm * NM));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
    geoLabel(`${nm} NM`, new THREE.Vector3(0, 6, nm * NM));
  }
  for (const [t, x, z] of [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]]) {
    if (t !== "S") geoLabel(t, new THREE.Vector3(x * 21.5 * NM, 6, z * 21.5 * NM));
  }
}

// ---------------------------------------------------------------------------
// Aircraft models. Procedural, nose toward -Z, roughly real-world metres.
// One model per airframe class; the class comes from the ICAO type designator
// each aircraft broadcasts (see classify()).
// ---------------------------------------------------------------------------

function planformGeometry(points, thickness, y) {
  // points: [x (right), forward] outline of the right half; mirrored to make both sides
  const shape = new THREE.Shape();
  const all = [...points, ...points.slice().reverse().map(([x, f]) => [-x, f])];
  all.forEach(([x, f], i) => (i ? shape.lineTo(x, f) : shape.moveTo(x, f)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // shape +y (forward) -> -Z, extrusion -> +Y
  g.translate(0, y, 0);
  return g;
}

function finGeometry(points, thickness) {
  // points: [forward, height] side profile, extruded sideways
  const shape = new THREE.Shape();
  points.forEach(([f, h], i) => (i ? shape.lineTo(f, h) : shape.moveTo(f, h)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.rotateY(Math.PI / 2); // shape +x (forward) -> -Z
  g.translate(-thickness / 2, 0, 0);
  return g;
}

const tube = (r0, r1, len, x, y, f) => {
  const g = new THREE.CylinderGeometry(r0, r1, len, 12);
  g.rotateX(Math.PI / 2); // +Y end (r0) -> +Z (rear); so r0 is the rear radius, r1 the front
  g.translate(x, y, -f);
  return g;
};

function finishModel(parts, fin, extra) {
  const body = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  body.computeBoundingBox();
  const bb = body.boundingBox;
  const size = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
  return { body, fin, size, belly: -bb.min.y, top: bb.max.y, noseF: -bb.min.z, props: [], rotors: [], boost: 1, ...extra };
}

function fixedWing(o) {
  const { L, R, half, chord, tip, sweep, wingF, wingY, finH, stabHalf, tTail = false, engines = [], props = [], gear = false, nose = 2.4, boost = 1, tcK = 0.28 } = o;
  const tc = L * tcK, parts = []; // tc = tail-cone length
  parts.push(tube(R, R, L, 0, 0, 0));
  const n = new THREE.SphereGeometry(R, 14, 10); n.scale(1, 1, nose); n.translate(0, 0, -L / 2); parts.push(n);
  parts.push(tube(R * 0.18, R, tc, 0, R * 0.28, -(L / 2 + tc / 2)));
  parts.push(planformGeometry([[0, wingF], [R * 0.9, wingF], [half, wingF - sweep], [half, wingF - sweep - tip], [R * 0.9, wingF - chord], [0, wingF - chord]], Math.max(0.14, R * 0.25), wingY));
  const fs = -(L / 2 + tc * 0.3), sc = stabHalf * 0.75, ss = stabHalf * (sweep / half);
  parts.push(planformGeometry([[0, fs], [stabHalf, fs - ss], [stabHalf, fs - ss - sc * 0.5], [0, fs - sc]], Math.max(0.1, R * 0.16), tTail ? finH - R * 0.1 : R * 0.3));
  for (const e of engines) for (const sx of [-1, 1]) parts.push(tube(e.r * 0.85, e.r, e.l, sx * e.x, e.y, e.f));
  if (gear) {
    for (const [x, f] of [[-R * 1.9, wingF - chord * 0.6], [R * 1.9, wingF - chord * 0.6], [0, L * 0.42]]) {
      const w = new THREE.SphereGeometry(R * 0.36, 8, 6); w.translate(x, -R * 1.75, -f); parts.push(w);
      parts.push(new THREE.CylinderGeometry(R * 0.07, R * 0.07, R * 1.2, 6).translate(x, -R * 1.2, -f)); // strut
    }
  }
  const ff = -(L / 2) + finH * 0.2;
  const fin = finGeometry([[ff, R * 0.7], [ff - finH * 0.75, finH], [ff - finH * 1.1, finH], [ff - finH * 0.95, R * 0.7]], Math.max(0.12, R * 0.2));
  const model = finishModel(parts, fin, { boost, lights: [half, wingY, -(wingF - sweep - tip / 2)], tailZ: L / 2 + tc, lightR: Math.max(half * 0.036, 0.13) });
  model.props = props.flatMap((p) => (p.x ? [-1, 1] : [0]).map((sx) => ({ pos: [sx * p.x, p.y, -p.f], r: p.r })));
  model.top = Math.max(model.top, finH);
  return model;
}

function helicopter() {
  const parts = [];
  const cabin = new THREE.SphereGeometry(1.15, 14, 10); cabin.scale(1, 1.05, 1.55); cabin.translate(0, 0, -0.6); parts.push(cabin);
  parts.push(tube(0.12, 0.3, 5.6, 0, 0.3, -3.6)); // tail boom
  parts.push(tube(0.13, 0.13, 0.8, 0, 0, 0).rotateX(Math.PI / 2).translate(0, 1.4, -0.3)); // mast
  for (const sx of [-1, 1]) {
    parts.push(tube(0.07, 0.07, 3.4, sx * 0.95, -1.4, 0.5)); // skids
    for (const f of [1.3, -0.4]) parts.push(tube(0.05, 0.05, 0.7, 0, 0, 0).rotateX(Math.PI / 2).translate(sx * 0.95, -1.1, -f));
  }
  const fin = finGeometry([[-5.3, 0.3], [-6.5, 1.8], [-7.0, 1.8], [-6.6, -0.5], [-5.7, -0.2]], 0.12);
  const m = finishModel(parts, fin, { boost: 2.1, lights: [1.15, 0, -0.6], tailZ: 6.4, lightR: 0.22 });
  m.rotors = [{ pos: [0, 1.85, -0.3], r: 5.2, axis: "y" }, { pos: [0.25, 0.6, 6.3], r: 0.8, axis: "x" }];
  m.size = 10.4; m.top = 1.9;
  return m;
}

function groundVehicle() {
  const box = new THREE.BoxGeometry(2.4, 1.6, 5.2); box.translate(0, 0.9, 0);
  const cab = new THREE.BoxGeometry(2.2, 0.9, 2.0); cab.translate(0, 2.1, -1.2);
  const beacon = new THREE.BoxGeometry(0.9, 0.35, 0.5); beacon.translate(0, 2.75, -1.2);
  return finishModel([box, cab], beacon, { boost: 2.2, lights: null, tailZ: 0, lightR: 0.3, belly: 0, forceTail: "#ffb000" });
}

const MODELS = {
  narrow: fixedWing({ L: 28, R: 1.95, half: 17.5, chord: 8.7, tip: 2.1, sweep: 10, wingF: 5.5, wingY: -1.1, finH: 9.2, stabHalf: 6.4,
    engines: [{ x: 5.8, y: -2.3, f: 2.2, r: 1.15, l: 4.6 }] }),
  wide: fixedWing({ L: 44, R: 2.9, half: 28, chord: 13, tip: 3, sweep: 17, wingF: 9, wingY: -1.6, finH: 13, stabHalf: 10,
    engines: [{ x: 9.5, y: -3.7, f: 4.5, r: 1.95, l: 7 }] }),
  quad: fixedWing({ L: 48, R: 3.5, half: 33, chord: 16, tip: 3.5, sweep: 20, wingF: 11, wingY: -2, finH: 15, stabHalf: 12,
    engines: [{ x: 9.5, y: -4.3, f: 6, r: 1.8, l: 6.5 }, { x: 19.5, y: -3.6, f: -1.5, r: 1.8, l: 6.5 }] }),
  bizjet: fixedWing({ L: 15, R: 1.25, half: 9.5, chord: 4.5, tip: 1.3, sweep: 4.5, wingF: 1, wingY: -0.8, finH: 5, stabHalf: 3.6, tTail: true, boost: 1.25,
    engines: [{ x: 2.2, y: 0.9, f: -6.5, r: 0.75, l: 3.4 }] }),
  turboprop: fixedWing({ L: 22, R: 1.5, half: 14, chord: 3.6, tip: 1.8, sweep: 0.6, wingF: 2.5, wingY: 1.4, finH: 6.5, stabHalf: 4.6, tTail: true, boost: 1.15,
    engines: [{ x: 4.6, y: 0.9, f: 1.5, r: 0.8, l: 5 }], props: [{ x: 4.6, y: 0.9, f: 4.3, r: 2.3 }] }),
  turbosingle: fixedWing({ L: 6.5, R: 0.9, half: 8.2, chord: 2.3, tip: 1.6, sweep: 0.2, wingF: 1.8, wingY: 0.85, finH: 3.3, stabHalf: 3, gear: true, nose: 1.8, tcK: 0.75, boost: 1.6,
    props: [{ x: 0, y: 0, f: 4.9, r: 1.4 }] }),
  light: fixedWing({ L: 3.4, R: 0.62, half: 5.5, chord: 1.6, tip: 1.45, sweep: 0, wingF: 1.3, wingY: 0.62, finH: 2.1, stabHalf: 1.8, gear: true, nose: 1.5, tcK: 1.05, boost: 1.9,
    props: [{ x: 0, y: 0, f: 2.68, r: 0.95 }] }),
  lighttwin: fixedWing({ L: 4.4, R: 0.68, half: 6, chord: 1.9, tip: 1.3, sweep: 0.25, wingF: 1.5, wingY: -0.5, finH: 2.5, stabHalf: 2.2, gear: true, nose: 2.2, tcK: 0.85, boost: 1.8,
    engines: [{ x: 1.9, y: -0.3, f: 1.0, r: 0.4, l: 2.2 }], props: [{ x: 1.9, y: -0.3, f: 2.2, r: 0.95 }] }),
  heli: helicopter(),
  vehicle: groundVehicle(),
};

const KIND_LABEL = {
  narrow: "Narrow-body jet", wide: "Wide-body jet", quad: "Four-engine heavy", bizjet: "Business jet", turboprop: "Turboprop",
  turbosingle: "Single turboprop", light: "Light piston single", lighttwin: "Light piston twin", heli: "Helicopter", vehicle: "Ground vehicle",
};
const BIZJET_RE = /GULFSTREAM|LEARJET|CITATION|DASSAULT|FALCON|CHALLENGER|GLOBAL|PILATUS|PHENOM|LEGACY|PRAETOR|HAWKER|HONDA|PREMIER|ECLIPSE|CIRRUS|BEECHJET|WESTWIND|ASTRA/;

// Pick a model class. `shape` is the ICAO description code joined on by the
// server from the broadcast type designator: airframe (L/S/A = aeroplane,
// H = helicopter, G = gyrocopter), engine count, engine kind (P/T/J/E).
// Aircraft that don't broadcast a known type fall back to the ADS-B emitter
// category, then to how they actually flew.
function classify(raw, segs) {
  const shape = raw.shape || "", cat = raw.category || "", name = (raw.desc || "").toUpperCase();
  const speeds = [];
  let maxAlt = 0;
  for (const s of segs) for (let k = 0; k < s.n; k++) { maxAlt = Math.max(maxAlt, s.A[k]); speeds.push(s.G[k]); }
  const fast = speeds.sort((a, b) => a - b)[Math.floor(speeds.length * 0.8)] || 0; // 80th percentile: ignores the odd bogus speed report
  const small = classifyByType(shape, cat, name, raw.wake);
  // The type comes from a registry keyed on the transponder's hex code, and the
  // registry is occasionally wrong: nothing with a piston or a rotor does 250 kt.
  if (["light", "lighttwin", "heli", "vehicle"].includes(small) && fast > 250) return "narrow";
  if (small) return small;
  return maxAlt < 8000 && fast < 150 ? "light" : "narrow";
}

function classifyByType(shape, cat, name, wake) {
  if ("VT".includes(shape[0] || "-") || (!shape && cat[0] === "C")) return "vehicle"; // service vehicles, fixed transmitters
  if ("HG".includes(shape[0] || "-") || (!shape && cat === "A7")) return "heli";
  if (shape) {
    const n = +shape[1] || 1, eng = shape[2];
    if (eng === "J") {
      if (n >= 4) return "quad";
      if (n === 3 || wake === "H") return "wide";
      return n === 1 || wake === "L" || BIZJET_RE.test(name) ? "bizjet" : "narrow";
    }
    if (eng === "T") return n >= 2 ? "turboprop" : "turbosingle";
    return n >= 2 ? "lighttwin" : "light";
  }
  if (cat === "A1" || cat[0] === "B") return "light";
  if (cat === "A5") return "wide";
  return null;
}

const BODY_MAT = new THREE.MeshStandardMaterial({ color: 0xeef3f8, metalness: 0.35, roughness: 0.4, emissive: 0x2a3a4c });
const VEHICLE_MAT = new THREE.MeshStandardMaterial({ color: 0xd9b44a, metalness: 0.1, roughness: 0.7, emissive: 0x3a2c08 });
const LIGHT_GEO = new THREE.SphereGeometry(1, 8, 6);
const RED_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(4, 0.25, 0.2) });
const GREEN_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.2, 4, 0.5) });
const STROBE_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(5, 5, 5) });
const HIT_GEO = new THREE.SphereGeometry(0.8, 8, 6);
const HIT_MAT = new THREE.MeshBasicMaterial({ visible: false });
const SHADOW_GEO = new THREE.RingGeometry(0.37, 0.53, 32).rotateX(-Math.PI / 2);
const DISC_GEO = new THREE.CircleGeometry(1, 24);
const BLADE_GEO = new THREE.BoxGeometry(2, 0.14, 0.03);
const DISC_MAT = new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false });
const BLADE_MAT = new THREE.MeshBasicMaterial({ color: 0x1c232b });

// A propeller or rotor: a faint blur disc plus blades, spun every frame about its local Z.
function makeSpinner({ pos, r, axis = "z" }, blades) {
  const pivot = new THREE.Group();
  pivot.position.set(...pos);
  if (axis === "y") pivot.rotation.x = -Math.PI / 2;
  if (axis === "x") pivot.rotation.y = Math.PI / 2;
  const spin = new THREE.Group();
  spin.add(new THREE.Mesh(DISC_GEO, DISC_MAT));
  for (let i = 0; i < blades; i++) { const b = new THREE.Mesh(BLADE_GEO, BLADE_MAT); b.rotation.z = (i * Math.PI) / blades; spin.add(b); }
  spin.scale.setScalar(r);
  pivot.add(spin);
  return { pivot, spin };
}

const ringTexture = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d");
  g.strokeStyle = "#fff"; g.lineWidth = 5;
  for (let q = 0; q < 4; q++) { g.beginPath(); g.arc(128, 128, 112, q * Math.PI / 2 + 0.25, (q + 1) * Math.PI / 2 - 0.25); g.stroke(); }
  return new THREE.CanvasTexture(c);
})();

// ---------------------------------------------------------------------------
// Trails: a camera-facing ribbon along the path plus a translucent "curtain"
// hanging to the ground. Geometry is the whole track, built once; the shader
// reveals/fades it by comparing each vertex's timestamp with the clock.
// ---------------------------------------------------------------------------

const TRAIL_FRAG_HEAD = `
  uniform float uTime, uTrail, uSel;
  varying float vTime; varying vec3 vColor;
  float trailAlpha() {
    float age = uTime - vTime;
    if (age < 0.0) return uSel * 0.3 * step(0.5, fract(vTime / 10.0)); // dashed "route ahead" for the selected flight
    return max(pow(max(1.0 - age / uTrail, 0.0), 1.5), uSel * 0.32);
  }`;

function trailMaterials() {
  const uSel = { value: 0 };
  const common = { transparent: true, depthWrite: false, blending: glowBlend(), side: THREE.DoubleSide };
  const line = new THREE.ShaderMaterial({
    ...common,
    uniforms: { uTime, uTrail, uSel, uPxScale, uGain, uWidth: { value: 2.6 } },
    vertexShader: `
      uniform float uPxScale, uWidth;
      attribute vec3 aPrev, aNext, aColor; attribute float aSide, aTime;
      varying float vTime, vSide; varying vec3 vColor;
      void main() {
        vTime = aTime; vSide = aSide; vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 a = (modelViewMatrix * vec4(aPrev, 1.0)).xyz, b = (modelViewMatrix * vec4(aNext, 1.0)).xyz;
        vec3 side = cross(b - a, mv.xyz);
        float l = length(side);
        side = l > 1e-5 ? side / l : vec3(1.0, 0.0, 0.0);
        mv.xyz += side * aSide * max(length(mv.xyz) * uPxScale * uWidth, 1.5) * 0.5;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `${TRAIL_FRAG_HEAD}
      uniform float uGain;
      varying float vSide;
      void main() {
        float a = trailAlpha() * (1.0 - vSide * vSide);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * uGain, a);
      }`,
  });
  const curtain = new THREE.ShaderMaterial({
    ...common,
    uniforms: { uTime, uTrail, uSel, uCurtain },
    vertexShader: `
      attribute vec3 aColor; attribute float aTime, aV;
      varying float vTime, vV, vDist; varying vec3 vColor;
      void main() {
        vTime = aTime; vV = aV; vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = length(mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `${TRAIL_FRAG_HEAD}
      uniform float uCurtain;
      varying float vV, vDist;
      void main() {
        if (uTime < vTime) discard;
        // fade out near the camera so flying alongside a trail doesn't flood the view
        float a = trailAlpha() * (0.02 + 0.2 * pow(vV, 4.0)) * smoothstep(400.0, 6000.0, vDist) * uCurtain;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor, a);
      }`,
  });
  return { line, curtain, uSel };
}

function buildTrailMeshes(seg, mats) {
  const n = seg.n, c = new THREE.Color();
  const pos = new Float32Array(n * 6), prev = new Float32Array(n * 6), next = new Float32Array(n * 6);
  const col = new Float32Array(n * 6), side = new Float32Array(n * 2), time = new Float32Array(n * 2);
  const cpos = new Float32Array(n * 6), cv = new Float32Array(n * 2);
  const idx = [];
  for (let k = 0; k < n; k++) {
    const p = Math.max(k - 1, 0), q = Math.min(k + 1, n - 1);
    altColor(seg.A[k], c);
    for (let s = 0; s < 2; s++) {
      const o = (k * 2 + s) * 3;
      pos[o] = seg.X[k]; pos[o + 1] = seg.Y[k]; pos[o + 2] = seg.Z[k];
      prev[o] = seg.X[p]; prev[o + 1] = seg.Y[p]; prev[o + 2] = seg.Z[p];
      next[o] = seg.X[q]; next[o + 1] = seg.Y[q]; next[o + 2] = seg.Z[q];
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      side[k * 2 + s] = s ? 1 : -1;
      time[k * 2 + s] = seg.t0 + k * STEP;
      cpos[o] = seg.X[k]; cpos[o + 1] = s ? seg.Y[k] : 0; cpos[o + 2] = seg.Z[k];
      cv[k * 2 + s] = s;
    }
    if (k < n - 1) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
  }
  const attr = (a, size) => new THREE.BufferAttribute(a, size);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", attr(pos, 3)); lg.setAttribute("aPrev", attr(prev, 3)); lg.setAttribute("aNext", attr(next, 3));
  lg.setAttribute("aColor", attr(col, 3)); lg.setAttribute("aSide", attr(side, 1)); lg.setAttribute("aTime", attr(time, 1));
  lg.setIndex(idx);
  const cg = new THREE.BufferGeometry();
  cg.setAttribute("position", attr(cpos, 3)); cg.setAttribute("aColor", attr(col, 3));
  cg.setAttribute("aTime", attr(time, 1)); cg.setAttribute("aV", attr(cv, 1));
  cg.setIndex(idx);
  const line = new THREE.Mesh(lg, mats.line), curtain = new THREE.Mesh(cg, mats.curtain);
  line.frustumCulled = curtain.frustumCulled = false;
  line.renderOrder = 2; curtain.renderOrder = 1;
  return [line, curtain];
}

// ---------------------------------------------------------------------------
// Track processing
// ---------------------------------------------------------------------------

// Turn one aircraft's raw ~10s position reports into smooth, uniformly sampled
// segments (cubic Hermite through the reports), with heading / bank / pitch
// derived from the path itself.
function buildSegments(ac) {
  const raw = [];
  let lastAlt = null, lastTrack = 0;
  for (let i = 0; i < ac.t.length; i++) {
    let alt = ac.alt[i];
    if (alt == null) alt = lastAlt;
    if (alt == null) continue;
    lastAlt = alt;
    if (ac.track[i] != null) lastTrack = ac.track[i];
    const p = { t: ac.t[i], x: toX(ac.lon[i]), z: toZ(ac.lat[i]), alt: Math.max(alt, 0), gs: ac.gs[i] ?? 0, vr: ac.vr[i] ?? 0, trk: lastTrack * DEG };
    const last = raw[raw.length - 1];
    if (last) {
      if (p.t < last.t + 0.5) continue;
      // An airborne aircraft can't hold still: an identical fix is a stale repeat.
      if (p.x === last.x && p.z === last.z && p.alt > 0) continue;
    }
    raw.push(p);
  }

  const groups = [];
  for (const p of raw) {
    const g = groups[groups.length - 1];
    if (g && p.t - g[g.length - 1].t <= GAP) g.push(p);
    else groups.push([p]);
  }

  const segs = [];
  for (const g of groups) {
    const t0 = g[0].t, n = Math.floor((g[g.length - 1].t - t0) / STEP) + 1;
    if (g.length < 2 || n < 4) continue;
    const seg = { t0, t1: t0 + (n - 1) * STEP, n, X: new Float32Array(n), Y: new Float32Array(n), Z: new Float32Array(n),
      A: new Float32Array(n), H: new Float32Array(n), B: new Float32Array(n), P: new Float32Array(n), G: new Float32Array(n), V: new Float32Array(n) };
    const tangent = (i, key) => {
      const a = g[Math.max(i - 1, 0)], b = g[Math.min(i + 1, g.length - 1)];
      return (b[key] - a[key]) / (b.t - a.t);
    };
    let j = 0;
    for (let k = 0; k < n; k++) {
      const t = t0 + k * STEP;
      while (j < g.length - 2 && g[j + 1].t <= t) j++;
      const p0 = g[j], p1 = g[j + 1], h = p1.t - p0.t, s = clamp((t - p0.t) / h, 0, 1);
      const s2 = s * s, s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
      const herm = (key) => h00 * p0[key] + h10 * h * tangent(j, key) + h01 * p1[key] + h11 * h * tangent(j + 1, key);
      seg.X[k] = herm("x"); seg.Z[k] = herm("z");
      seg.A[k] = Math.max(herm("alt"), 0);
      seg.Y[k] = seg.A[k] * FT * VEX;
      seg.G[k] = p0.gs + (p1.gs - p0.gs) * s;
      seg.V[k] = p0.vr + (p1.vr - p0.vr) * s;
      seg.H[k] = s < 0.5 ? p0.trk : p1.trk; // fallback; replaced below when actually moving
    }
    // Heading from the direction of travel, unwrapped so it interpolates cleanly through north.
    for (let k = 0; k < n; k++) {
      const a = Math.max(k - 1, 0), b = Math.min(k + 1, n - 1);
      const dx = seg.X[b] - seg.X[a], dz = seg.Z[b] - seg.Z[a], dt = (b - a) * STEP;
      const horiz = Math.hypot(dx, dz);
      let hdg = horiz / dt > 3 ? Math.atan2(dx, -dz) : seg.H[k];
      if (k) hdg += Math.round((seg.H[k - 1] - hdg) / (2 * Math.PI)) * 2 * Math.PI;
      seg.H[k] = hdg;
      seg.P[k] = horiz / dt > 3 ? clamp(Math.atan2(seg.Y[b] - seg.Y[a], horiz), -0.4, 0.4) : 0;
    }
    // Bank from turn rate: tan(bank) = v * omega / g
    for (let k = 0; k < n; k++) {
      const a = Math.max(k - 2, 0), b = Math.min(k + 2, n - 1);
      const omega = (seg.H[b] - seg.H[a]) / ((b - a) * STEP);
      seg.B[k] = seg.A[k] < 30 ? 0 : clamp(Math.atan((seg.G[k] * KT * omega) / 9.81), -0.6, 0.6);
    }
    segs.push(seg);
  }
  return segs;
}

function sample(ac, t) {
  const cur = ac.cur;
  for (const s of ac.segs) {
    if (t < s.t0 || t > s.t1) continue;
    const f = (t - s.t0) / STEP, k = Math.min(Math.floor(f), s.n - 2), u = f - k;
    const L = (arr) => arr[k] + (arr[k + 1] - arr[k]) * u;
    cur.pos.set(L(s.X), L(s.Y), L(s.Z));
    cur.alt = L(s.A); cur.hdg = L(s.H); cur.bank = L(s.B); cur.pitch = L(s.P); cur.gs = L(s.G); cur.vr = L(s.V);
    cur.remaining = s.t1 - t;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

// Extension points for add-on views (the game) that load this module and build
// on top of it. All unset in the plain Sky view.
const hooks = { frame: null, pick: null, key: null, loaded: null };

const state = {
  start: 0, duration: 1, t: 0, speed: 10, playing: true,
  aircraft: [], byHex: new Map(), selected: null,
  mode: "free", director: false, directorAt: 0,
  showGround: false, histogram: null, day: false,
};
// ---------------------------------------------------------------------------
// Day / night. Night is the glowing look (additive trails, heavy bloom, stars);
// day shows the satellite imagery at full colour under a blue sky, so glow
// effects switch to ordinary blending or they would wash out to white.
// ---------------------------------------------------------------------------
const THEMES = {
  night: { horizon: "#0b1a2b", zenith: "#01030a", glow: "#3a2440", tint: [0.3, 0.42, 0.62], base: 0x04080d, fog: 0.0000075,
           bloom: [0.85, 0.82], gain: 1.9, hemi: [0xcfe4ff, 0x0c1420, 1.3], sun: 2.2 },
  day:   { horizon: "#a9c9e6", zenith: "#2a6fc4", glow: "#3d3420", tint: [1.25, 1.3, 1.4], base: 0x2c5673, fog: 0.000011,
           bloom: [0.3, 1.0], gain: 0.85, hemi: [0xffffff, 0x8c9aa6, 1.9], sun: 3.0 },
};
function glowBlend() { return state.day ? THREE.NormalBlending : THREE.AdditiveBlending; }

function setDay(day) {
  state.day = day;
  const th = day ? THEMES.day : THEMES.night;
  scene.fog.density = th.fog;
  FOG_COLOR.set(th.horizon); // shared by the fog and the sky's horizon band
  skyMat.uniforms.uZenith.value.set(th.zenith);
  skyMat.uniforms.uGlow.value.set(th.glow);
  stars.visible = !day;
  GROUND_TINT.setRGB(...th.tint);
  tileMats.forEach((m) => m.color.copy(GROUND_TINT));
  groundBase.material.color.set(th.base);
  bloom.strength = th.bloom[0]; bloom.threshold = th.bloom[1];
  uGain.value = th.gain;
  hemi.color.set(th.hemi[0]); hemi.groundColor.set(th.hemi[1]); hemi.intensity = th.hemi[2];
  sun.intensity = th.sun;
  const blend = glowBlend();
  for (const ac of state.aircraft) {
    ac.mats.line.blending = ac.mats.curtain.blending = blend;
    ac.halo.material.blending = ac.shadow.material.blending = blend;
    ac.shadow.material.opacity = day ? 0.3 : 0.4;
  }
  document.body.classList.toggle("day", day);
  $("dayBtn").classList.toggle("active", day);
}

// Follow the sun for the window being replayed, unless the viewer has chosen.
function autoDay(epoch) {
  let pref = null;
  try { pref = localStorage.getItem("sky.day"); } catch {}
  if (pref !== null) return setDay(pref === "1");
  const hour = +new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour12: false, hour: "2-digit" }).format(new Date(epoch * 1000)) % 24;
  setDay(hour >= 6 && hour < 19);
}

const worldGroup = new THREE.Group(); // everything rebuilt per data window
scene.add(worldGroup);

function airlineOf(flight) {
  const m = /^([A-Z]{2,4})\d/.exec(flight);
  return (m && AIRLINES[m[1]]) || null;
}

function makeAircraft(rawAc) {
  const segs = buildSegments(rawAc);
  if (!segs.length) return null;
  const flight = (rawAc.flight || "").replace(/@/g, "").trim(); // "@@@@@@@@" = callsign not set
  const airline = airlineOf(flight);
  const kind = classify(rawAc, segs), model = MODELS[kind];
  const tail = new THREE.Color(model.forceTail || (airline ? airline[1] : "#7fb4d8"));
  const ac = {
    hex: rawAc.hex, flight, name: flight || rawAc.reg || rawAc.hex.toUpperCase(), type: rawAc.type, reg: rawAc.reg, squawk: rawAc.squawk,
    kind, model, desc: rawAc.desc || "", viewK: clamp((model.size * model.boost) / 38, 0.4, 1.7),
    airline: airline ? airline[0] : "", tailCss: "#" + tail.getHexString(), segs,
    cur: { pos: new THREE.Vector3(), alt: 0, hdg: 0, bank: 0, pitch: 0, gs: 0, vr: 0, remaining: 0, visible: false },
    color: new THREE.Color(), scale: MIN_PLANE_SCALE,
  };

  const group = new THREE.Group();
  group.rotation.order = "YXZ";
  group.add(new THREE.Mesh(model.body, kind === "vehicle" ? VEHICLE_MAT : BODY_MAT));
  group.add(new THREE.Mesh(model.fin, new THREE.MeshStandardMaterial({ color: tail, emissive: tail, emissiveIntensity: 0.55, roughness: 0.5 })));
  const strobe = new THREE.Mesh(LIGHT_GEO, STROBE_MAT); strobe.position.set(0, model.top * 0.35, model.tailZ);
  strobe.scale.setScalar(model.lightR * 0.8);
  if (model.lights) {
    const [lx, ly, lz] = model.lights;
    const red = new THREE.Mesh(LIGHT_GEO, RED_MAT); red.position.set(-lx, ly, lz); red.scale.setScalar(model.lightR);
    const green = new THREE.Mesh(LIGHT_GEO, GREEN_MAT); green.position.set(lx, ly, lz); green.scale.setScalar(model.lightR);
    group.add(red, green);
  }
  const spinners = [...model.props.map((p) => makeSpinner(p, 2)), ...model.rotors.map((p) => makeSpinner(p, 2))];
  spinners.forEach((sp) => group.add(sp.pivot));
  const hit = new THREE.Mesh(HIT_GEO, HIT_MAT); hit.userData.ac = ac; hit.scale.setScalar(model.size);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture, color: 0x8fe6ff, transparent: true, depthWrite: false, depthTest: false, blending: glowBlend() }));
  halo.scale.setScalar(model.size * 2.5); halo.visible = false;
  group.add(strobe, hit, halo);
  group.visible = false;

  // CSS2DRenderer owns the outer element's transform, so the styled tag is a child.
  const wrap = document.createElement("div");
  const el = document.createElement("div");
  el.className = "tag";
  el.dataset.hex = ac.hex;
  el.innerHTML = "<b></b><i></i>";
  el.addEventListener("click", (e) => { e.stopPropagation(); select(ac, true); });
  wrap.appendChild(el);
  const label = new CSS2DObject(wrap);
  label.position.set(0, model.top + model.size * 0.08, 0);
  label.visible = false;
  group.add(label);

  const shadow = new THREE.Mesh(SHADOW_GEO, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false, blending: glowBlend() }));
  shadow.visible = false;

  const mats = trailMaterials();
  const trails = segs.flatMap((s) => buildTrailMeshes(s, mats));
  worldGroup.add(group, shadow, ...trails);
  Object.assign(ac, { group, strobe, spinners, hit, halo, label, el, elName: el.firstChild, elInfo: el.lastChild, shadow, mats, trails, phase: Math.random() });
  return ac;
}

function disposeWorld() {
  for (const ac of state.aircraft) {
    ac.trails.forEach((m) => m.geometry.dispose());
    ac.mats.line.dispose(); ac.mats.curtain.dispose();
    ac.group.children[1].material.dispose();
    ac.shadow.material.dispose();
    ac.label.removeFromParent(); ac.label.element.remove();
  }
  worldGroup.clear();
  state.aircraft = []; state.byHex.clear(); state.selected = null;
}

// ---------------------------------------------------------------------------
// Camera rig
// ---------------------------------------------------------------------------

const RIG_DEFAULTS = {
  chase: { az: 0, el: 0.2, dist: 560 }, wing: { az: 0, el: 0.06, dist: 430 }, orbit: { az: 0, el: 0.3, dist: 950 },
  cockpit: { az: 0, el: 0, dist: 1 }, tower: { az: 0, el: 0, dist: 1 },
};
const rig = { az: 0, el: 0, dist: 500, orbitAngle: 0 };
const cam = { pos: camera.position.clone(), look: HOME_TARGET.clone(), up: new THREE.Vector3(0, 1, 0), fov: 50, lastPos: new THREE.Vector3(), lastAc: null, fly: null };
const TOWER_POS = ground(...TOWER, 95 * VEX);
const _v = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _want = new THREE.Vector3(), _wantLook = new THREE.Vector3(), _wantUp = new THREE.Vector3();

function setMode(mode, keepRig = false) {
  if (mode !== "free" && !state.selected) {
    const pick = pickInteresting();
    if (!pick) return;
    select(pick, false);
  }
  const wasFree = state.mode === "free";
  state.mode = mode;
  document.querySelectorAll("#modes [data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  controls.enabled = mode === "free";
  if (mode === "free") {
    controls.target.copy(cam.look);
    cam.fly = null;
    camera.up.set(0, 1, 0);
    camera.fov = cam.fov = 50;
    camera.updateProjectionMatrix();
  } else {
    if (!keepRig) Object.assign(rig, RIG_DEFAULTS[mode]);
    if (wasFree) { cam.pos.copy(camera.position); cam.look.copy(controls.target); cam.lastAc = null; }
    controls.autoRotate = false;
    $("hint").style.opacity = 0;
  }
  uCurtain.value = mode === "tower" ? 0.3 : 1;
}

function flyHome() {
  setMode("free");
  cam.fly = { pos: HOME_POS.clone(), target: HOME_TARGET.clone() };
}

function updateCamera(dt) {
  if (state.mode === "free") {
    if (cam.fly) {
      const a = 1 - Math.exp(-dt * 2.2);
      camera.position.lerp(cam.fly.pos, a);
      controls.target.lerp(cam.fly.target, a);
      if (camera.position.distanceTo(cam.fly.pos) < 150) cam.fly = null;
    }
    controls.update();
    cam.look.copy(controls.target);
    return;
  }
  const ac = state.selected;
  if (!ac || !ac.cur.visible) return;
  const c = ac.cur, p = c.pos, mode = state.mode;

  // Carry the camera along with the aircraft so smoothing only has to absorb
  // changes of viewpoint, not the aircraft's own (possibly 60x) motion.
  if (cam.lastAc === ac) {
    _v.subVectors(p, cam.lastPos);
    cam.look.add(_v);
    if (mode !== "tower") cam.pos.add(_v);
  }
  cam.lastAc = ac; cam.lastPos.copy(p);

  _fwd.set(Math.sin(c.hdg), 0, -Math.cos(c.hdg));
  let fov = 50;
  _wantUp.set(0, 1, 0);
  if (mode === "tower") {
    _want.copy(TOWER_POS);
    _wantLook.copy(p);
    fov = clamp((2 * Math.atan((700 * rig.dist) / Math.max(p.distanceTo(TOWER_POS), 1))) / DEG, 1.5, 60); // long lens: frame ~1.4 km around it
  } else if (mode === "cockpit") {
    const yaw = c.hdg + rig.az, pitch = c.pitch * 0.6 - 0.04 + rig.el;
    _want.copy(p).addScaledVector(_fwd, ac.model.noseF * 0.8 * ac.scale).setY(p.y + (ac.model.belly + ac.model.top * 0.35) * ac.scale);
    _wantLook.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(4000).add(_want);
    _right.set(Math.cos(yaw), 0, Math.sin(yaw));
    _wantUp.set(0, Math.cos(c.bank), 0).addScaledVector(_right, Math.sin(c.bank));
    fov = 68;
  } else {
    if (mode === "orbit") rig.orbitAngle += dt * 0.11;
    const theta = mode === "chase" ? c.hdg + Math.PI + rig.az : mode === "wing" ? c.hdg + 1.85 + rig.az : rig.orbitAngle + rig.az;
    const el = clamp(rig.el, -0.3, 1.45), dist = rig.dist * ac.viewK; // stand closer to smaller aircraft
    _want.set(Math.sin(theta) * Math.cos(el), Math.sin(el), -Math.cos(theta) * Math.cos(el)).multiplyScalar(dist).add(p);
    _wantLook.copy(p);
    if (mode === "chase") _wantLook.addScaledVector(_fwd, dist * 0.22).y += dist * 0.06;
  }
  _want.y = Math.max(_want.y, 25);

  const a = 1 - Math.exp(-dt * (mode === "cockpit" ? 6 : 3.2));
  cam.pos.lerp(_want, a);
  cam.look.lerp(_wantLook, a);
  cam.up.lerp(_wantUp, a).normalize();
  cam.fov += (fov - cam.fov) * a;
  camera.position.copy(cam.pos);
  camera.up.copy(cam.up);
  camera.lookAt(cam.look);
  if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
}

// Rig mouse controls (when not in free-orbit mode)
{
  const el = renderer.domElement;
  let drag = null, moved = 0;
  el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; moved = 0; });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    moved += Math.abs(dx) + Math.abs(dy);
    drag = { x: e.clientX, y: e.clientY };
    if (state.mode === "free" || state.mode === "tower") return;
    const sign = state.mode === "cockpit" ? -1 : 1;
    rig.az -= dx * 0.005 * sign;
    rig.el = clamp(rig.el + dy * 0.005 * sign, state.mode === "cockpit" ? -0.9 : -0.3, state.mode === "cockpit" ? 0.9 : 1.45);
  });
  window.addEventListener("pointerup", (e) => {
    if (drag && moved < 6 && e.target === el) pickAt(e.clientX, e.clientY);
    drag = null;
  });
  el.addEventListener("wheel", (e) => {
    if (state.mode === "free") return;
    e.preventDefault();
    const lim = state.mode === "tower" ? [0.15, 8] : [140, 30000];
    rig.dist = clamp(rig.dist * Math.exp(e.deltaY * 0.0012), ...lim);
  }, { passive: false });
  controls.addEventListener("start", () => { controls.autoRotate = false; cam.fly = null; $("hint").style.opacity = 0; });
}

const raycaster = new THREE.Raycaster();
function pickAt(x, y) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
  const hits = raycaster.intersectObjects(state.aircraft.filter((a) => a.group.visible).map((a) => a.hit), false);
  if (hits.length) select(hits[0].object.userData.ac, true);
}

// ---------------------------------------------------------------------------
// Selection + director
// ---------------------------------------------------------------------------

function select(ac, engage) {
  if (engage && hooks.pick?.(ac)) return;
  if (state.selected) { state.selected.mats.uSel.value = 0; state.selected.el.classList.remove("sel"); state.selected.halo.visible = false; }
  state.selected = ac;
  $("card").classList.toggle("hidden", !ac);
  if (!ac) {
    if (state.mode !== "free") setMode("free");
    return;
  }
  ac.mats.uSel.value = 1;
  ac.el.classList.add("sel");
  $("cardFlight").textContent = ac.name;
  $("cardAirline").textContent = ac.airline || (ac.flight ? "" : "no callsign broadcast");
  $("cardDesc").textContent = [ac.desc, KIND_LABEL[ac.kind]].filter(Boolean).join(" · ");
  $("cardFin").style.background = ac.tailCss; $("cardFin").style.color = ac.tailCss;
  $("cardType").textContent = ac.type || "";
  $("cardReg").textContent = ac.reg || "";
  $("cardHex").textContent = "ICAO " + ac.hex.toUpperCase();
  $("cardSquawk").textContent = ac.squawk ? "SQK " + ac.squawk : "";
  drawProfile();
  if (engage) {
    $("hint").style.opacity = 0;
    if (state.director) toggleDirector(false);
    if (state.mode === "free") setMode("chase");
  }
}

function visibleAircraft() {
  return state.aircraft.filter((a) => a.cur.visible).sort((a, b) => a.name.localeCompare(b.name));
}

// A flight worth watching: airborne, lower is busier (arrivals/departures), with time left in range.
function pickInteresting(exclude) {
  const pool = state.aircraft.filter((a) => a.cur.visible && a !== exclude && a.cur.alt > 400 && a.cur.remaining > 15 * state.speed);
  if (!pool.length) return state.aircraft.find((a) => a.cur.visible && a !== exclude && a.cur.alt > 400) || null;
  pool.sort((a, b) => (b.flight ? 1 : 0) - (a.flight ? 1 : 0) || a.cur.alt - b.cur.alt);
  return pool[Math.floor(Math.random() * Math.min(pool.length, 6))];
}

function cycleFlight(dir) {
  const list = visibleAircraft();
  if (!list.length) return;
  const i = list.indexOf(state.selected);
  select(list[(i + dir + list.length) % list.length], true);
}

function toggleDirector(on = !state.director) {
  state.director = on;
  $("directorBtn").classList.toggle("active", on);
  if (on) state.directorAt = 0;
}

function runDirector(now) {
  if (!state.director || now < state.directorAt) return;
  state.directorAt = now + 14000;
  const pick = pickInteresting(state.selected);
  if (!pick) { select(null); flyHome(); return; }
  select(pick, false);
  const modes = ["chase", "wing", "orbit", "chase", "tower", "cockpit"];
  setMode(modes[Math.floor(Math.random() * modes.length)]);
}

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------

function updateAircraft(now) {
  const scaleK = Math.tan((camera.fov * DEG) / 2) * 0.0018;
  let air = 0, all = 0;
  for (const ac of state.aircraft) {
    const c = ac.cur;
    let vis = sample(ac, state.t) && (ac.kind !== "vehicle" || state.showGround);
    if (vis) {
      all++;
      if (c.alt >= 50) air++;
      else if (!state.showGround && c.gs < 30) vis = false; // hide parked/taxiing clutter, keep take-off and landing rolls
    }
    c.visible = vis;
    const inCockpit = state.mode === "cockpit" && ac === state.selected;
    ac.group.visible = vis && !inCockpit;
    ac.label.visible = vis && !inCockpit;
    ac.shadow.visible = vis && c.alt >= 50;
    if (!vis) continue;

    ac.scale = Math.max(MIN_PLANE_SCALE, camera.position.distanceTo(c.pos) * scaleK) * ac.model.boost * (ac === state.selected ? 1.25 : 1);
    ac.group.position.copy(c.pos);
    ac.group.position.y += ac.model.belly * ac.scale; // keep the wheels out of the tarmac
    ac.group.rotation.set(c.pitch, -c.hdg, -c.bank);
    ac.group.scale.setScalar(ac.scale);
    ac.strobe.visible = (now / 1000 + ac.phase) % 1.3 < 0.09;
    for (const sp of ac.spinners) sp.spin.rotation.z = now * 0.031 + ac.phase * 6;
    ac.halo.visible = ac === state.selected && (state.mode === "free" || state.mode === "tower");
    if (ac.halo.visible) ac.halo.material.rotation = now / 2500;

    altColor(c.alt, ac.color);
    ac.shadow.position.set(c.pos.x, 5, c.pos.z);
    ac.shadow.scale.setScalar(ac.scale * ac.model.size);
    if (state.day) ac.shadow.material.color.setRGB(0, 0, 0); else ac.shadow.material.color.copy(ac.color);
  }
  $("countAir").textContent = air;
  $("countAll").textContent = all;
}

let lastSlow = 0;
function slowUpdate(now) {
  if (now - lastSlow < 250) return;
  lastSlow = now;
  const sel = state.selected;
  const rows = [];
  for (const ac of visibleAircraft()) {
    const c = ac.cur, css = "#" + ac.color.getHexString();
    const arrow = c.vr > 250 ? " ▲" : c.vr < -250 ? " ▼" : "";
    ac.elName.textContent = ac.name;
    ac.elInfo.textContent = fmtAlt(c.alt) + arrow + (ac.type ? " · " + ac.type : "");
    ac.el.style.setProperty("--c", css);
    rows.push(`<div class="frow${ac === sel ? " sel" : ""}" data-hex="${esc(ac.hex)}"><span class="dot" style="color:${css}"></span><span class="cs">${esc(ac.name)}</span><span class="ty">${esc(ac.type || "")}</span><span class="al">${fmtAlt(c.alt)}${arrow}</span></div>`);
  }
  $("flightList").innerHTML = rows.join("") || '<div class="frow"><span></span><span class="ty">quiet skies…</span></div>';

  const d = new Date((state.start + state.t) * 1000);
  $("clock").textContent = clockFmt.format(d);
  $("clockDate").textContent = dateFmt.format(d) + " · Sydney";
  $("playhead").style.left = (state.t / state.duration) * 100 + "%";

  if (sel && sel.cur.visible) {
    const c = sel.cur;
    $("gAlt").textContent = fmtAlt(c.alt);
    $("gGs").textContent = Math.round(c.gs) + " kt";
    $("gHdg").textContent = String(Math.round((((c.hdg / DEG) % 360) + 360) % 360)).padStart(3, "0") + "°";
    $("gVs").textContent = (c.vr > 0 ? "+" : "") + (Math.round(c.vr / 50) * 50).toLocaleString("en-AU") + " fpm";
    drawProfile();
  }
}

const clockFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hmFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour12: false, hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short" });

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (state.playing && state.aircraft.length) {
    state.t += dt * state.speed;
    if (state.t >= state.duration) state.t = 0;
  }
  uTime.value = state.t;

  updateAircraft(now);
  if (state.selected && !state.selected.cur.visible) {
    // The flight we were following left coverage (or landed).
    if (state.director) state.directorAt = 0; else select(null);
  }
  runDirector(now);
  updateCamera(dt);
  hooks.frame?.(dt, now);
  uPxScale.value = (2 * Math.tan((camera.fov * DEG) / 2)) / renderer.domElement.clientHeight;
  slowUpdate(now);

  composer.render();
  labelRenderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// HUD: timeline histogram, altitude profile, controls
// ---------------------------------------------------------------------------

function buildHistogram() {
  const bins = 240, counts = new Float32Array(bins), w = state.duration / bins;
  for (const ac of state.aircraft) for (const s of ac.segs) {
    for (let b = Math.max(0, Math.floor(s.t0 / w)); b <= Math.min(bins - 1, Math.floor(s.t1 / w)); b++) counts[b]++;
  }
  state.histogram = counts;
  drawHistogram();
}

function drawHistogram() {
  const cv = $("histogram"), counts = state.histogram;
  if (!counts) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  const max = Math.max(1, ...counts), bw = W / counts.length, base = H - 12;
  const grad = g.createLinearGradient(0, 0, 0, base);
  grad.addColorStop(0, "rgba(90,215,255,0.95)"); grad.addColorStop(1, "rgba(90,215,255,0.15)");
  g.fillStyle = grad;
  counts.forEach((c, i) => { const h = (c / max) * (base - 4); g.fillRect(i * bw + 0.5, base - h, Math.max(bw - 1, 1), h); });
  g.fillStyle = "rgba(120,190,230,0.3)";
  g.fillRect(0, base, W, 1);
}

function drawProfile() {
  const ac = state.selected, cv = $("profile");
  if (!ac) return;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const t0 = ac.segs[0].t0, t1 = ac.segs[ac.segs.length - 1].t1;
  let maxA = 1000;
  for (const s of ac.segs) for (let k = 0; k < s.n; k++) maxA = Math.max(maxA, s.A[k]);
  const px = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * (W - 4) + 2, py = (a) => H - 6 - (a / maxA) * (H - 16);
  for (const s of ac.segs) {
    g.beginPath();
    for (let k = 0; k < s.n; k++) g[k ? "lineTo" : "moveTo"](px(s.t0 + k * STEP), py(s.A[k]));
    g.strokeStyle = "rgba(90,215,255,0.9)"; g.lineWidth = 3; g.stroke();
    g.lineTo(px(s.t1), H); g.lineTo(px(s.t0), H); g.closePath();
    g.fillStyle = "rgba(90,215,255,0.12)"; g.fill();
  }
  if (ac.cur.visible) {
    g.fillStyle = "#fff"; g.shadowColor = "#5ad7ff"; g.shadowBlur = 14;
    g.beginPath(); g.arc(px(state.t), py(ac.cur.alt), 6, 0, 7); g.fill();
    g.shadowBlur = 0;
  }
}

function setPlaying(p) {
  state.playing = p;
  $("playBtn").textContent = p ? "❚❚" : "▶";
}

function wireUi() {
  document.querySelectorAll("#modes [data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (state.director) toggleDirector(false);
    b.dataset.mode === "free" && state.mode === "free" ? flyHome() : setMode(b.dataset.mode);
  }));
  $("directorBtn").addEventListener("click", () => toggleDirector());
  $("playBtn").addEventListener("click", () => setPlaying(!state.playing));
  document.querySelectorAll("#speeds button").forEach((b) => b.addEventListener("click", () => {
    state.speed = +b.dataset.speed;
    document.querySelectorAll("#speeds button").forEach((o) => o.classList.toggle("active", o === b));
  }));
  const toggleLabels = () => { document.body.classList.toggle("no-labels"); $("labelsBtn").classList.toggle("active"); };
  const toggleGround = () => { state.showGround = !state.showGround; $("groundBtn").classList.toggle("active", state.showGround); };
  $("labelsBtn").addEventListener("click", toggleLabels);
  $("groundBtn").addEventListener("click", toggleGround);
  const toggleDay = () => { setDay(!state.day); try { localStorage.setItem("sky.day", state.day ? "1" : "0"); } catch {} };
  $("dayBtn").addEventListener("click", toggleDay);
  $("cardClose").addEventListener("click", () => { toggleDirector(false); select(null); });
  $("prevFlight").addEventListener("click", () => cycleFlight(-1));
  $("nextFlight").addEventListener("click", () => cycleFlight(1));
  $("flightList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-hex]");
    if (row) select(state.byHex.get(row.dataset.hex), true);
  });

  const tl = $("timeline");
  let scrubbing = false;
  const scrub = (e) => {
    const r = tl.getBoundingClientRect();
    state.t = clamp((e.clientX - r.left) / r.width, 0, 0.9999) * state.duration;
    lastSlow = 0;
  };
  tl.addEventListener("pointerdown", (e) => { scrubbing = true; tl.setPointerCapture(e.pointerId); scrub(e); });
  tl.addEventListener("pointermove", (e) => scrubbing && scrub(e));
  tl.addEventListener("pointerup", () => (scrubbing = false));

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.metaKey || e.ctrlKey) return;
    if (hooks.key?.(e)) return;
    const modeKeys = { 1: "free", 2: "chase", 3: "wing", 4: "orbit", 5: "cockpit", 6: "tower" };
    if (modeKeys[e.key]) { toggleDirector(false); setMode(modeKeys[e.key]); }
    else if (e.key === " ") { e.preventDefault(); setPlaying(!state.playing); }
    else if (e.key === "ArrowRight") cycleFlight(1);
    else if (e.key === "ArrowLeft") cycleFlight(-1);
    else if (e.key === "d" || e.key === "D") toggleDirector();
    else if (e.key === "h" || e.key === "H") { toggleDirector(false); flyHome(); }
    else if (e.key === "l" || e.key === "L") toggleLabels();
    else if (e.key === "g" || e.key === "G") toggleGround();
    else if (e.key === "n" || e.key === "N") toggleDay();
    else if (e.key === "Escape") { toggleDirector(false); select(null); }
  });

  $("windowSelect").addEventListener("change", (e) => {
    const [start, end] = e.target.value.split("-").map(Number);
    loadWindow(start, end);
  });
  window.addEventListener("resize", resize);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  labelRenderer.setSize(w, h);
  drawHistogram();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function fail(title, detail) {
  $("loading").classList.remove("done");
  $("loading").classList.add("error");
  $("loadingText").textContent = title;
  $("loadingDetail").textContent = detail || "";
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `${url} → HTTP ${res.status}`);
  return body;
}

async function loadWindow(start, end) {
  $("loading").classList.remove("done", "error");
  $("loadingText").textContent = "Loading flight tracks…";
  $("loadingDetail").textContent = "";
  let data;
  try {
    data = await getJson(`data/window_${start}_${end}.json`);
  } catch (err) {
    return fail("Couldn't load flight tracks", err.message);
  }
  disposeWorld();
  state.start = data.start;
  state.duration = data.end - data.start;
  state.t = 0;
  for (const raw of data.aircraft) {
    const ac = makeAircraft(raw);
    if (ac) { state.aircraft.push(ac); state.byHex.set(ac.hex, ac); }
  }
  if (!state.aircraft.length) return fail("No aircraft tracks in this window", "Try another time chunk from the selector once more data has landed.");
  $("tStart").textContent = hmFmt.format(new Date(data.start * 1000));
  $("tEnd").textContent = hmFmt.format(new Date(data.end * 1000));
  autoDay(data.start + (data.end - data.start) / 2);
  buildHistogram();
  // Open on the busiest moment of the first half so the sky is full straight away.
  const h = state.histogram;
  let best = 0;
  for (let i = 0; i < h.length / 2; i++) if (h[i] > h[best] * 1.15) best = i;
  state.t = Math.max(0, (best / h.length) * state.duration - 60);
  flyHome();
  camera.position.copy(HOME_POS);
  controls.autoRotate = true;
  $("loading").classList.add("done");
  hooks.loaded?.();
}

async function boot() {
  buildSky();
  buildGround();
  buildAirport();
  wireUi();
  resize();
  requestAnimationFrame(frame);

  let windows;
  try {
    ({ windows } = await getJson("data/windows.json"));
  } catch (err) {
    return fail("Couldn't load the flight data", err.message);
  }
  if (!windows.length) return fail("No continuous stretch of data found yet", "The table needs at least ~10 minutes of unbroken polling.");
  const sel = $("windowSelect");
  sel.innerHTML = windows.map((w, i) => {
    const a = new Date(w.start * 1000), b = new Date(w.end * 1000);
    return `<option value="${w.start}-${w.end}">${i ? "" : "★ "}${dayFmt.format(a).replace(",", "")} ${hmFmt.format(a)}–${hmFmt.format(b)} · ~${Math.round(w.avg_airborne)} up</option>`;
  }).join("");
  await loadWindow(windows[0].start, windows[0].end);
}

export const sky = { THREE, CSS2DObject, scene, camera, renderer, controls, bloom, state, hooks, KT, FT, VEX, flyHome, setPlaying };

boot();
