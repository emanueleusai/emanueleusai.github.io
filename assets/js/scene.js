// Live CMS event display behind every page (three.js r161, plain ES module, no build step).
//
// The models are a real CMS collision event exported from the iSpy event display (models/*.glb,
// meters, beam along z): charged-particle tracks (yellow), ECAL energy deposits in the barrel and
// endcaps (EB/EE, green), HCAL barrel deposits (HB, blue), two reconstructed electrons, and the ECAL
// barrel geometry drawn as faint glass. The hardware views add a procedural HGCAL layer and module
// from hexaboard.js, loaded on first use.
//
// Contract (see SPEC.md): initScene({ canvas, reducedMotion, initialView, paused }) ->
// { setView, replay, setPaused, dispose }. setPaused(true) stops everything that moves on its own
// (drift, spin, pulses, the replay, the module's hit animation, scroll and pointer easing); the
// scene still redraws when the view changes or the window resizes.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const MODEL_DIR = new URL('../../models/', import.meta.url);

const COLOR = {
  background: '#04060b',
  track: '#ffd23f', trackCore: '#ffe48a',          // site palette: --track
  ecal: '#46e27a', hcal: '#4db8ff',                 // --ecal, --hcal
  electron: '#46e27a', electronCore: '#f3fff6',
  head: '#fffaf0', flash: '#ffe9b0',
  geometry: new THREE.Color(0.498, 0.8, 1),         // ECAL barrel material in the original export (linear)
};

// Collision replay timeline, in seconds. Particles leave the vertex at SPEED m/s (slowed down a lot).
const SPEED = 3.4;
const STAGGER = [0.12, 0.3];      // each track starts at 0.12 s + up to 0.3 s of random stagger
const HIT_GROW = 0.55;            // energy deposits grow out of their inner face
const ELECTRON_START = 1.95;      // the two reconstructed electrons are drawn last, faster
const ELECTRON_SPEED = 5.5;
const REPLAY_END = 3.2;           // everything is idle after this
const FINAL = 1e4;                // "replay finished" clock value

const GEOMETRY_ALPHA = 0.01;      // per-face alpha of the ECAL barrel glass (as in the original export)
const GEOMETRY_LINE_ALPHA = 0.02;

// HGCAL (endcap calorimeter upgrade): a layer just in front of the EE deposits, and one module
// pulled out of it toward the viewer.
const LAYER_Z = 3.45;
const MODULE_POS = new THREE.Vector3(1.0, 0.62, LAYER_Z + 0.4);
// Close-up: the module faces the viewer, tilted a little. Exploded: it lies back (face up) so
// its layers separate vertically on screen, like an assembly drawing.
const MODULE_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, 0.2, 0.12));
const MODULE_Q_EXPLODED = new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.2, 0.5, 0.35, 'YXZ'));
const EXPLODE_SPACING = 0.13;     // m between the baseplate and the readout chips, fully exploded

const WIDE = 960;                 // px: above this the event moves to the right of the text
// Narrow screens: while the first screen (the hero's headline and lead) is in view, the subject
// sits this fraction of the viewport height lower, and rises to the center as the page scrolls.
const DROP = 0.3;
const FIT = 1.1;                  // default aspect below which the camera pulls back (narrow screens)
// Wide screens: the text sits in a left-aligned reading column (site.css: --col 760px after the
// --gutter, clamp(16px, 5vw, 72px)), and the subject is placed on the "stage" to its right. A view's
// shift says how far toward the stage center its target sits (1 = centered on it). A stage that is
// narrower, relative to its height, than at 1440x900 shrinks the subject to fit.
const COLUMN = 760;
const STAGE_REF = (1440 - 72 - COLUMN) / 900;
// Close-ups of the hardware fade what lies behind the module into the dark (a depth cue): fog
// starts FOG[0] and is complete FOG[1] view distances behind the camera target; when fog = 0
// both lie far beyond the scene.
const FOG = [0.2, 0.95];
const FOG_OFF = [90, 180];

// ---------------------------------------------------------------------------------------------
// Views. Camera: look-at target (m), distance (m), polar angle from +y and azimuth around +y
// (measured from +z toward +x), vertical fov (deg, landscape). Layers are opacity multipliers:
// event = tracks, electrons and vertex glow; ecal = barrel geometry; hits = EB/EE/HB deposits;
// hgcal = the HGCAL layer; module = the single module. orbit: camera drift (rad/s); roll: event
// angle about the beam axis (rad) and spin its speed (rad/s); shift: placement on the stage of
// wide screens (see COLUMN); fit: aspect below which narrow screens pull back (default FIT);
// bright: overall brightness. Hardware close-ups only: fog (0..1, see FOG), explode (the module's
// layers apart, 0..1) and mrot (the module laid back for the exploded view, 0..1).
// ---------------------------------------------------------------------------------------------
const L = (event, ecal, hits, hgcal = 0, module = 0) => ({ event, ecal, hits, hgcal, module });

const VIEWS = {
  home: {
    target: [0, 0.05, -0.2], dist: 17.5, polar: 1.17, azimuth: -0.78, fov: 34,
    roll: -1.45, orbit: 0.03, spin: 0, shift: 0.87, bright: 1, layers: L(1, 0.55, 1), fit: 0.91,
  },
  research: {
    target: [0, 0, 0], dist: 15, polar: Math.PI / 2, azimuth: 0, fov: 26,
    roll: -1.5, orbit: 0, spin: 0.02, shift: 0.85, bright: 1, layers: L(1, 1.4, 0.9), fit: 0.99,
  },
  'research-side': {
    target: [0, 0, -0.25], dist: 19.5, polar: 1.5, azimuth: Math.PI / 2, fov: 32,
    roll: -0.63, orbit: 0, spin: 0.006, shift: 1.04, bright: 1, layers: L(0.9, 1.6, 1), fit: 0.85,
  },
  hardware: {
    target: [0, 0.12, LAYER_Z], dist: 9.2, polar: 1.2, azimuth: 0.6, fov: 34,
    roll: 0, orbit: 0.008, spin: 0, shift: 0.87, bright: 1, layers: L(0.14, 0.22, 0.24, 1, 0), fit: 0.8,
  },
  'hardware-module': {
    target: MODULE_POS.toArray(), dist: 0.55, polar: 1.12, azimuth: 0.7, fov: 34,
    roll: 0, orbit: 0, spin: 0, shift: 0.97, bright: 1, layers: L(0, 0, 0, 1, 1), explode: 0, fog: 1, fit: 0.8,
  },
  'hardware-exploded': {
    target: MODULE_POS.toArray(), dist: 0.62, polar: 1.45, azimuth: 0.5, fov: 34,
    roll: 0, orbit: 0, spin: 0, shift: 0.97, bright: 1, layers: L(0, 0, 0, 1, 1), explode: 1, mrot: 1, fog: 1, fit: 0.8,
  },
  teaching: {
    target: [0, -0.25, -0.8], dist: 16, polar: 1.48, azimuth: 0.66, fov: 40,
    roll: 0.3, orbit: 0, spin: 0.012, shift: 1.12, bright: 0.8, layers: L(0.85, 1.1, 0.8), fit: 0.86,
  },
  join: {
    target: [0, 0, 0], dist: 14.5, polar: 1.12, azimuth: 0.62, fov: 38,
    roll: -0.9, orbit: 0.025, spin: 0, shift: 1.06, bright: 1, layers: L(1, 1, 1),
    // Entrance: the camera starts at the collision point and pulls out while the event replays.
    from: { dist: 0.28, polar: 1.34, azimuth: 1.4, fov: 62 }, pullOut: 3.8,
  },
  publications: {
    target: [0, 0, -0.3], dist: 22, polar: 1.24, azimuth: -0.42, fov: 30,
    roll: -1.2, orbit: 0.018, spin: 0, shift: 0.88, bright: 0.55, layers: L(0.9, 0.8, 0.8),
  },
  cv: {
    target: [0, 0.2, 0.2], dist: 22, polar: 0.98, azimuth: 2.35, fov: 30,
    roll: 0.6, orbit: -0.016, spin: 0, shift: 0.92, bright: 0.5, layers: L(0.9, 0.8, 0.8),
  },
  // The lone-track pose is computed from the data once the tracks have loaded (see soloView).
  notfound: {
    target: [0.4, -0.3, -1.4], dist: 2.4, polar: 1.3, azimuth: 1.9, fov: 42,
    roll: 0, orbit: 0, spin: 0, shift: 0.75, bright: 1, layers: L(1, 0.22, 0), solo: 1,
  },
};
const HARDWARE = new Set(['hardware', 'hardware-module', 'hardware-exploded']);
// If the hardware cannot be built (hexaboard.js failed to load), every hardware view shows the
// endcap pose with the event at full strength instead of an empty close-up.
const HARDWARE_FALLBACK = { ...VIEWS.hardware, layers: L(0.85, 0.9, 0.9), orbit: 0.02 };
const HIT_LAYERS = ['eb', 'ee', 'hb'];

// State vector interpolated between views (dist is stored as a logarithm so zooms feel even).
const K = { tx: 0, ty: 1, tz: 2, dist: 3, polar: 4, azimuth: 5, fov: 6, shift: 7, event: 8, ecal: 9,
  hits: 10, hgcal: 11, module: 12, bright: 13, explode: 14, solo: 15, roll: 16, fog: 17, fit: 18, mrot: 19 };
const NK = 20;
const ANGLES = [K.azimuth, K.roll];

function viewVector(def, out = new Float64Array(NK)) {
  out[K.tx] = def.target[0]; out[K.ty] = def.target[1]; out[K.tz] = def.target[2];
  out[K.dist] = Math.log(def.dist); out[K.polar] = def.polar; out[K.azimuth] = def.azimuth;
  out[K.fov] = def.fov; out[K.shift] = def.shift; out[K.bright] = def.bright;
  out[K.event] = def.layers.event; out[K.ecal] = def.layers.ecal; out[K.hits] = def.layers.hits;
  out[K.hgcal] = def.layers.hgcal; out[K.module] = def.layers.module;
  out[K.explode] = def.explode || 0; out[K.solo] = def.solo || 0; out[K.roll] = def.roll;
  out[K.fog] = def.fog || 0; out[K.fit] = def.fit || FIT; out[K.mrot] = def.mrot || 0;
  return out;
}

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const nearestAngle = (a, ref) => a + TAU * Math.round((ref - a) / TAU);

// Small deterministic PRNG so the replay stagger is the same on every visit.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

// Tracks as screen-space ribbons: one instanced quad per segment, clipped at the growing tip.
// Drawn in two passes over the same geometry: an additive halo (glow without post-processing)
// and a crisp core with normal blending, so dense bundles stay yellow instead of burning white.
const TRACK_VERT = /* glsl */`
attribute vec3 iStart;
attribute vec3 iEnd;
attribute vec4 iData;          // arc length at start, at end (m), start delay (s), track index
uniform float uTime;
uniform float uSpeed;
uniform vec2 uViewport;        // drawing-buffer size (device px)
uniform float uPx;             // device px per CSS px
uniform float uHalf;           // ribbon half-width (CSS px)
uniform float uSolo;           // index of the lone track (notfound view)
uniform float uSoloMix;
varying float vAcross;
varying float vArc;
varying float vTip;
varying float vSolo;

void main() {
  float tip = (uTime - iData.z) * uSpeed;
  float f = clamp((tip - iData.x) / max(iData.y - iData.x, 1e-5), 0.0, 1.0);
  float solo = abs(iData.w - uSolo) < 0.5 ? 1.0 : 0.0;
  vSolo = solo;
  if (f <= 0.0 || (solo < 0.5 && uSoloMix > 0.999)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec4 a = modelViewMatrix * vec4(iStart, 1.0);
  vec4 b = modelViewMatrix * vec4(mix(iStart, iEnd, f), 1.0);
  // Clip against the near plane so segments passing beside the camera stay well formed.
  float near = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
  float zn = -near * 1.001;
  if (a.z > zn && b.z > zn) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (a.z > zn) a.xyz = mix(a.xyz, b.xyz, (zn - a.z) / (b.z - a.z));
  if (b.z > zn) b.xyz = mix(b.xyz, a.xyz, (zn - b.z) / (a.z - b.z));

  vec4 ca = projectionMatrix * a;
  vec4 cb = projectionMatrix * b;
  vec2 sa = ca.xy / ca.w * uViewport * 0.5;
  vec2 sb = cb.xy / cb.w * uViewport * 0.5;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = position.x > 0.5 ? cb : ca;
  c.xy += nrm * position.y * uHalf * uPx / (uViewport * 0.5) * c.w;
  gl_Position = c;

  vAcross = position.y;
  vArc = mix(iData.x, mix(iData.x, iData.y, f), position.x);
  vTip = tip;
}`;

const TRACK_FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uCore;
uniform vec3 uHeadColor;
uniform float uOpacity;
uniform float uPx;
uniform float uHalf;
uniform float uCoreW;          // core half-width (CSS px)
uniform float uSigma;          // halo width (CSS px)
uniform float uGlow;
uniform float uHead;
uniform float uSoloMix;
uniform float uSoloTime;       // lone-track pulse clock
uniform float uSpeed;
uniform vec2 uFade;            // fade out along the track: start, length (m); length 0 = off
varying float vAcross;
varying float vArc;
varying float vTip;
varying float vSolo;

void main() {
  float d = abs(vAcross) * uHalf;
  float head = uHead * exp(-max(vTip - vArc, 0.0) / 0.16);
  float keep = mix(1.0, vSolo, uSoloMix);
  // Lone track: a steady path with a white-hot pulse running outward along it, again and again.
  // (uSoloTime < 0 under reduced motion: no pulse.)
  float behind = uSoloTime * uSpeed * 0.7 - vArc;
  float pulse = behind > 0.0 ? exp(-behind / 0.35) : exp(behind / 0.04);
  head = max(head, pulse * (uSoloTime < 0.0 ? 0.0 : uSoloMix * vSolo));
  if (uFade.y > 0.0) keep *= 1.0 - smoothstep(uFade.x, uFade.x + uFade.y, vArc);
#ifdef HALO
  float halo = exp(-0.5 * d * d / (uSigma * uSigma)) * uGlow * (1.0 + 2.0 * head);
  float a = uOpacity * keep * halo;
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(uColor, uHeadColor, min(head, 1.0)), clamp(a, 0.0, 1.0));
#else
  float aa = 0.8 / uPx;
  float core = 1.0 - smoothstep(uCoreW - aa, uCoreW + aa, d);
  float a = uOpacity * keep * core;
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(uCore, uHeadColor, min(head, 1.0)), clamp(a, 0.0, 1.0));
#endif
  #include <colorspace_fragment>
}`;

// Energy deposits: each box grows out of its inner face (the side facing the collision) with a
// little overshoot and a white flash, timed by when the particles reach its radius.
const HIT_VERT = /* glsl */`
attribute vec3 aAnchor;
attribute float aDelay;
uniform float uTime;
uniform float uGrow;
varying float vShade;
varying float vK;

void main() {
  float k = clamp((uTime - aDelay) / uGrow, 0.0, 1.0);
  float e = k - 1.0;
  float s = 1.0 + 2.2 * e * e * e + 1.2 * e * e;
  vec3 p = aAnchor + (position - aAnchor) * max(s, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vShade = 0.6 + 0.4 * abs(dot(n, normalize(-mv.xyz)));
  vK = k;
  gl_Position = projectionMatrix * mv;
}`;

const HIT_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying float vShade;
varying float vK;

void main() {
  float a = uOpacity * smoothstep(0.0, 0.3, vK);
  if (a < 0.002) discard;
  float flash = (1.0 - vK) * (1.0 - vK) * step(0.001, vK);
  gl_FragColor = vec4(mix(uColor * vShade, vec3(1.0), 0.65 * flash), a);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------------------------

// Every polyline in a glTF scene, in scene coordinates (undoes mesh quantization transforms).
// Indexed LINES are split into chains wherever consecutive segments stop connecting.
function extractChains(root) {
  root.updateMatrixWorld(true);
  const chains = [];
  const v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isLine) return;
    const pos = o.geometry.attributes.position;
    const index = o.geometry.index ? o.geometry.index.array : null;
    const at = i => (index ? index[i] : i);
    const n = index ? index.length : pos.count;
    const runs = [];
    if (o.isLineSegments) {
      let cur = null;
      for (let s = 0; s + 1 < n; s += 2) {
        const a = at(s), b = at(s + 1);
        if (!cur || cur[cur.length - 1] !== a) { cur = [a]; runs.push(cur); }
        cur.push(b);
      }
    } else {
      const run = [];
      for (let s = 0; s < n; s++) run.push(at(s));
      runs.push(run);
    }
    const color = o.material && o.material.color ? o.material.color.clone() : null;
    for (const run of runs) {
      if (run.length < 2) continue;
      const pts = new Float32Array(run.length * 3);
      run.forEach((i, k) => { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); v.toArray(pts, k * 3); });
      chains.push({ pts, color, node: o });
    }
  });
  return chains;
}

const QUAD = new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]);

// chains: [{ pts, arc0?, index? }]; arc0 continues an earlier track's arc length (404 extension).
function buildRibbons(chains, delays) {
  let nSeg = 0;
  for (const c of chains) nSeg += c.pts.length / 3 - 1;
  const start = new Float32Array(nSeg * 3), end = new Float32Array(nSeg * 3), data = new Float32Array(nSeg * 4);
  const lengths = [];
  let s = 0;
  chains.forEach((c, ci) => {
    const p = c.pts;
    let arc = c.arc0 || 0;
    for (let k = 0; k + 5 < p.length; k += 3) {
      const dx = p[k + 3] - p[k], dy = p[k + 4] - p[k + 1], dz = p[k + 5] - p[k + 2];
      const len = Math.hypot(dx, dy, dz);
      start.set(p.subarray(k, k + 3), s * 3);
      end.set(p.subarray(k + 3, k + 6), s * 3);
      data[s * 4] = arc; data[s * 4 + 1] = arc + len; data[s * 4 + 2] = delays[ci]; data[s * 4 + 3] = c.index ?? ci;
      arc += len; s++;
    }
    lengths.push(arc - (c.arc0 || 0));
  });
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
  g.setAttribute('iStart', new THREE.InstancedBufferAttribute(start, 3));
  g.setAttribute('iEnd', new THREE.InstancedBufferAttribute(end, 3));
  g.setAttribute('iData', new THREE.InstancedBufferAttribute(data, 4));
  g.instanceCount = nSeg;
  return { geometry: g, lengths };
}

// Returns the halo and core materials; they share one uniforms object.
function ribbonMaterials({ color, core, speed, coreW, sigma, glow, head, half }) {
  const uniforms = {
    uTime: { value: 0 }, uSpeed: { value: speed }, uViewport: { value: new THREE.Vector2(1, 1) },
    uPx: { value: 1 }, uHalf: { value: half }, uCoreW: { value: coreW }, uSigma: { value: sigma },
    uGlow: { value: glow }, uHead: { value: head }, uOpacity: { value: 0 },
    uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(core) },
    uHeadColor: { value: new THREE.Color(COLOR.head) },
    uSolo: { value: -1 }, uSoloMix: { value: 0 }, uSoloTime: { value: 0 }, uFade: { value: new THREE.Vector2(0, 0) },
  };
  const base = { vertexShader: TRACK_VERT, fragmentShader: TRACK_FRAG, uniforms, transparent: true, depthWrite: false };
  return {
    uniforms,
    halo: new THREE.ShaderMaterial({ ...base, defines: { HALO: '' }, blending: THREE.AdditiveBlending }),
    core: new THREE.ShaderMaterial({ ...base, blending: THREE.NormalBlending }),
  };
}

// Hit boxes (12 triangles = 36 vertices each, possibly indexed) -> one animated mesh.
function buildHits(root, color, random) {
  root.updateMatrixWorld(true);
  let src = null;
  root.traverse(o => { if (o.isMesh && !src) src = o; });
  if (!src) return null;
  const pos = src.geometry.attributes.position;
  const index = src.geometry.index ? src.geometry.index.array : null;
  const n = index ? index.length : pos.count;
  const boxes = Math.floor(n / 36);
  const P = new Float32Array(boxes * 108), A = new Float32Array(boxes * 108), D = new Float32Array(boxes * 36);
  const v = new THREE.Vector3(), c = new THREE.Vector3(), anchor = new THREE.Vector3();
  const corners = [];
  for (let b = 0; b < boxes; b++) {
    corners.length = 0;
    c.set(0, 0, 0);
    for (let k = 0; k < 36; k++) {
      const i = b * 36 + k;
      v.fromBufferAttribute(pos, index ? index[i] : i).applyMatrix4(src.matrixWorld);
      v.toArray(P, i * 3);
      c.addScaledVector(v, 1 / 36);
      if (!corners.some(q => q.distanceToSquared(v) < 1e-10)) corners.push(v.clone());
    }
    corners.sort((p, q) => p.lengthSq() - q.lengthSq());
    anchor.set(0, 0, 0);
    const m = Math.min(4, corners.length);
    for (let k = 0; k < m; k++) anchor.addScaledVector(corners[k], 1 / m);
    const delay = STAGGER[0] + STAGGER[1] * 0.5 + 0.08 + c.length() / SPEED + random() * 0.14;
    for (let k = 0; k < 36; k++) { anchor.toArray(A, (b * 36 + k) * 3); D[b * 36 + k] = delay; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('aAnchor', new THREE.BufferAttribute(A, 3));
  g.setAttribute('aDelay', new THREE.BufferAttribute(D, 1));
  g.computeVertexNormals(); // non-indexed: flat per-face normals, used for gentle shading
  g.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({
    vertexShader: HIT_VERT, fragmentShader: HIT_FRAG,
    uniforms: { uTime: { value: 0 }, uGrow: { value: HIT_GROW }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  return new THREE.Mesh(g, material);
}

function glowTexture() {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.28)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Opacity control for objects whose materials we do not own (hexaboard.js). Opaque materials
// become transparent only while partly faded, and then stop writing depth so a half-faded layer
// never hides the event behind it.
function fadeable(group) {
  const mats = new Set();
  group.traverse(o => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => mats.add(x)); });
  return { group, f: -1, mats: [...mats].map(m => ({ m, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite })) };
}
function setTransparent(entry, on) {
  for (let i = 0; i < entry.mats.length; i++) {
    const r = entry.mats[i];
    const t = r.transparent || on;
    if (t !== r.m.transparent) { r.m.transparent = t; r.m.needsUpdate = true; }
    r.m.depthWrite = r.depthWrite && !on;
  }
}
function setFade(entry, f) {
  if (!entry || Math.abs(f - entry.f) < 1e-3) return;
  entry.f = f;
  entry.group.visible = f > 0.003;
  for (let i = 0; i < entry.mats.length; i++) entry.mats[i].m.opacity = entry.mats[i].opacity * f;
  setTransparent(entry, f < 0.995);
}

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

export async function initScene({ canvas, reducedMotion = false, initialView = 'home', paused = false } = {}) {
  // still: no autonomous motion (the OS asks for reduced motion, or the reader paused the scene).
  let still = reducedMotion || !!paused;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' });
  renderer.setClearColor(new THREE.Color(COLOR.background), 1);

  const scene = new THREE.Scene();
  // Fog only touches the built-in materials (HGCAL hardware, detector glass, sprites); the event
  // shaders ignore it. It is always present so that turning it up never recompiles a shader.
  scene.fog = new THREE.Fog(COLOR.background, FOG_OFF[0], FOG_OFF[1]);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 80);
  const eventRoot = new THREE.Group();       // rolls about the beam axis
  const hgcalRoot = new THREE.Group();       // fixed in the detector frame
  // The hardware draws after the (transparent) event, so while the layer fades in it covers the
  // tracks behind it gradually instead of letting them shine through until it turns opaque.
  hgcalRoot.renderOrder = 10;
  scene.add(eventRoot, hgcalRoot);
  // Only the HGCAL hardware uses lit materials; the event is self-lit.
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x10141c, 0.9);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 4, 9);
  key.target.position.set(0, 0, LAYER_Z);
  scene.add(hemi, key, key.target);

  let needsRender = true;              // force one frame even if nothing moves
  let disposed = false;
  let warned = false;
  const warn = (what, err) => {
    if (warned) return;
    warned = true;
    console.warn(`[scene] ${what}:`, err && err.message ? err.message : err);
  };

  // --- shared timing -------------------------------------------------------------------------
  const clock = () => performance.now() / 1000;
  let now = clock();
  let replayStart = -1;                 // seconds; -1 = not started
  let pendingReplay = !still;           // replay as soon as the tracks are in
  let tracksLoading = true;
  let joinPending = false;
  const replayTime = () => (replayStart >= 0 ? now - replayStart : (pendingReplay ? 0 : FINAL));

  // --- event layers --------------------------------------------------------------------------
  const layers = {};                    // name -> { object, loadedAt }
  const random = rng(20261006);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const load = file => loader.loadAsync(new URL(file, MODEL_DIR).href);
  let soloIndex = -1;

  const geometryMat = new THREE.MeshBasicMaterial({ color: COLOR.geometry, transparent: true, opacity: 0, depthWrite: false });
  const geometryLineMat = new THREE.LineBasicMaterial({ color: COLOR.geometry, transparent: true, opacity: 0, depthWrite: false });

  const trackMat = ribbonMaterials({ color: COLOR.track, core: COLOR.trackCore, speed: SPEED, coreW: 0.6, sigma: 1.6, glow: 0.32, head: 0.85, half: 4 });
  const soloMat = ribbonMaterials({ color: COLOR.track, core: COLOR.trackCore, speed: SPEED, coreW: 0.6, sigma: 1.6, glow: 0.32, head: 0.85, half: 4 });
  const electronMat = ribbonMaterials({ color: COLOR.electron, core: COLOR.electronCore, speed: ELECTRON_SPEED, coreW: 0.85, sigma: 2.6, glow: 0.55, head: 1, half: 7 });

  const glowTex = glowTexture();
  const vertexGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: COLOR.flash, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: COLOR.flash, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  vertexGlow.position.set(0, 0, -0.03);
  flash.position.copy(vertexGlow.position);
  vertexGlow.renderOrder = flash.renderOrder = 5;
  eventRoot.add(vertexGlow, flash);

  function addLayer(name, object, order) {
    object.renderOrder = order;
    eventRoot.add(object);
    layers[name] = { object, loadedAt: clock() };
    needsRender = true;
  }
  function ribbons(chains, delays, mats, order) {
    const { geometry, lengths } = buildRibbons(chains, delays);
    const group = new THREE.Group();
    for (const [m, o] of [[mats.halo, order], [mats.core, order + 0.5]]) {
      const mesh = new THREE.Mesh(geometry, m);
      mesh.frustumCulled = false; // instanced quads: the base geometry says nothing about extent
      mesh.renderOrder = o;
      group.add(mesh);
    }
    return { group, lengths };
  }

  const tracksReady = load('Tracks_V3.glb').then(gltf => {
    const chains = extractChains(gltf.scene);
    const delays = chains.map(() => STAGGER[0] + random() * STAGGER[1]);
    const { group, lengths } = ribbons(chains, delays, trackMat, 3);
    addLayer('tracks', group, 3);
    // Lone track for the 404 view: the longest high-momentum track from the primary vertex.
    const node = chains[0] && chains[0].node;
    const pt = node && node.userData && Array.isArray(node.userData.pt) && node.userData.pt.length === chains.length ? node.userData.pt : null;
    let best = -1;
    chains.forEach((c, i) => {
      const r0 = Math.hypot(c.pts[0], c.pts[1]);
      if (r0 > 0.01 || (pt && pt[i] < 5)) return;
      if (best < 0 || lengths[i] > lengths[best]) best = i;
    });
    if (best >= 0) {
      soloIndex = best;
      soloView(chains[best].pts);
      // 404 view: the lone particle (think of a muon) keeps going past the calorimeter, out into the dark.
      const p = chains[best].pts, n = p.length / 3;
      const end = new THREE.Vector3().fromArray(p, (n - 1) * 3);
      const dir = end.clone().sub(new THREE.Vector3().fromArray(p, (n - 2) * 3)).normalize();
      const ext = new Float32Array(13 * 3);
      for (let k = 0; k < 13; k++) end.clone().addScaledVector(dir, k * 0.5).toArray(ext, k * 3);
      const { group } = ribbons([{ pts: ext, arc0: lengths[best], index: best }], [delays[best]], soloMat, 3);
      soloMat.uniforms.uSolo.value = best;
      soloMat.uniforms.uSoloMix.value = 1;
      soloMat.uniforms.uFade.value.set(lengths[best] + 0.3, 5);
      addLayer('soloExtension', group, 3);
    }
  }).catch(err => warn('event tracks unavailable', err)).finally(() => {
    tracksLoading = false;
    if (pendingReplay) replay();
  });

  load('GsfElectrons_V2.glb').then(gltf => {
    const chains = extractChains(gltf.scene);
    addLayer('electrons', ribbons(chains, chains.map(() => ELECTRON_START), electronMat, 4).group, 4);
  }).catch(err => warn('electrons unavailable', err));

  for (const [name, file, color] of [['eb', 'EBRecHits_V2.glb', COLOR.ecal], ['ee', 'EERecHits_V2.glb', COLOR.ecal], ['hb', 'HBRecHits_V2.glb', COLOR.hcal]]) {
    load(file).then(gltf => {
      const mesh = buildHits(gltf.scene, color, rng(name.charCodeAt(0) * 7919 + name.charCodeAt(1)));
      if (mesh) addLayer(name, mesh, 2);
    }).catch(err => warn(`${name.toUpperCase()} hits unavailable`, err));
  }

  load('EcalBarrel3D_V1.glb').then(gltf => {
    const group = new THREE.Group();
    const parts = [];
    gltf.scene.traverse(o => { if (o.isMesh || o.isLine) parts.push(o); });
    for (const o of parts) {
      o.material.dispose();
      o.material = o.isLine ? geometryLineMat : geometryMat;
      group.add(o); // keeps its own (quantization) transform
    }
    addLayer('geometry', group, 1);
  }).catch(err => warn('detector geometry unavailable', err));

  // --- HGCAL hardware (lazy) -----------------------------------------------------------------
  let hgcal = null;                     // { layer, module, layerFade, moduleFade, loadedAt }
  let hgcalFailed = false;
  let hgcalPromise = null;
  const modulePivot = new THREE.Group();
  modulePivot.position.copy(MODULE_POS);
  modulePivot.quaternion.copy(MODULE_Q);
  hgcalRoot.add(modulePivot);
  let envTexture = null;
  let lastExplode = -1, lastMrot = -1;

  function ensureHGCAL() {
    if (hgcalPromise) return hgcalPromise;
    const env = import('three/addons/environments/RoomEnvironment.js').catch(() => null);
    hgcalPromise = Promise.all([import('./hexaboard.js'), env]).then(async ([mod, envMod]) => {
      if (disposed) return;
      // Image-based lighting for the metal, silicon and gold of the hardware (the event is unlit).
      if (envMod) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        envTexture = pmrem.fromScene(new envMod.RoomEnvironment(renderer), 0.04).texture;
        scene.environment = envTexture;
        pmrem.dispose();
      }
      const layer = mod.createLayer({ innerRadius: 0.32, outerRadius: 1.55, moduleSize: 0.167 });
      layer.group.position.set(0, 0, LAYER_Z);
      const module = mod.createModule({ explodeSpacing: EXPLODE_SPACING });
      const layerFade = fadeable(layer.group), moduleFade = fadeable(module.group);
      // Compile the shaders (opaque and fading variants) off-screen first, so the fly-in does not
      // stutter; later switches between the two reuse the cached programs.
      const staging = new THREE.Scene();
      staging.add(layer.group, module.group);
      const parallel = renderer.compileAsync && renderer.extensions.has('KHR_parallel_shader_compile');
      for (const on of [false, true]) {
        setTransparent(layerFade, on);
        setTransparent(moduleFade, on);
        try {
          if (parallel) await renderer.compileAsync(staging, camera, scene);
          else renderer.compile(staging, camera, scene);
        } catch { /* compiles on first draw instead */ }
      }
      if (disposed) return;
      hgcalRoot.add(layer.group);
      modulePivot.add(module.group);
      hgcal = { layer, module, layerFade, moduleFade, loadedAt: clock() };
      setFade(layerFade, 0);
      setFade(moduleFade, 0);
      lastExplode = lastMrot = -1;
    }).catch(err => {
      warn('HGCAL model unavailable', err);
      hgcalFailed = true;
      if (!HARDWARE.has(viewName) || disposed) return;
      def = HARDWARE_FALLBACK;
      if (!still) startTransition(def, null);
      else if (!dip.active) setState(def);  // (a pending dip applies the new def itself)
    }).finally(() => { needsRender = true; });
    return hgcalPromise;
  }

  // --- view state ----------------------------------------------------------------------------
  let viewName = VIEWS[initialView] ? initialView : 'home';
  let def = VIEWS[viewName];
  const state = viewVector(def);
  const vel = new Float64Array(NK);
  // Transition: cubic Hermite per component, from the current value and velocity (so a new view
  // can interrupt a flight smoothly) to the target, arriving with the new view's drift. Each
  // component runs in its own window [a, b] of the flight (see startTransition).
  const tr = {
    active: false, start: 0, dur: 1,
    from: new Float64Array(NK), to: new Float64Array(NK), v0: new Float64Array(NK), v1: new Float64Array(NK),
    a: new Float64Array(NK), b: new Float64Array(NK).fill(1),
  };
  const dip = { active: false, start: 0, dur: 0.5, swapped: false, apply: null };
  let fade = 1;
  const joinFrom = new Float64Array(NK);

  function soloView(pts) {
    // Camera off to the side and a little behind the collision point, so the track runs from the
    // vertex (left) out to the right and recedes into the dark.
    const n = pts.length / 3;
    const a = new THREE.Vector3(pts[0], pts[1], pts[2]);
    const b = new THREE.Vector3(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2]);
    const up = new THREE.Vector3(0, 1, 0);
    const dir = b.clone().sub(a).normalize();
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const eye = side.clone().multiplyScalar(0.5).addScaledVector(dir, -0.75).addScaledVector(up, 0.42).normalize();
    const right = new THREE.Vector3().crossVectors(eye.clone().negate(), up);
    if (right.dot(dir) < 0) eye.addScaledVector(side, -1).normalize();
    const target = a.clone().lerp(b, 0.16);
    const sph = new THREE.Spherical().setFromVector3(eye);
    Object.assign(VIEWS.notfound, { target: target.toArray(), polar: sph.phi, azimuth: sph.theta });
    if (viewName === 'notfound' && !tr.active && !dip.active) setState(VIEWS.notfound);
  }

  function setState(d) {
    viewVector(d, state);
    vel.fill(0);
    tr.active = false;
    needsRender = true;
  }

  function startTransition(d, dur, from = null) {
    tr.from.set(from || state);
    if (from) tr.v0.fill(0); else tr.v0.set(vel);
    viewVector(d, tr.to);
    tr.v1.fill(0);
    if (!still) { tr.v1[K.azimuth] = d.orbit; tr.v1[K.roll] = d.spin; }
    for (const k of ANGLES) {
      // Aim for where the current drift would carry us, then wrap to the nearest turn.
      tr.to[k] = nearestAngle(tr.to[k], tr.from[k] + tr.v0[k] * 0.8);
    }
    const f = tr.from, t = tr.to;
    if (dur == null) {
      const span = Math.abs(t[K.azimuth] - f[K.azimuth]) + Math.abs(t[K.polar] - f[K.polar]) +
        0.35 * Math.abs(t[K.dist] - f[K.dist]) + 0.15 * Math.hypot(t[K.tx] - f[K.tx], t[K.ty] - f[K.ty], t[K.tz] - f[K.tz]);
      dur = clamp(1.35 + 0.22 * span, 1.4, 1.8);
    }
    // Choreography: when pulling back from a close-up, back off first and pan later; when diving
    // in, aim first and close in later. This keeps the camera from cutting through the HGCAL
    // layer. Things that fade out go early, things that fade in arrive late.
    tr.a.fill(0); tr.b.fill(1);
    const zoom = t[K.dist] - f[K.dist];
    const win = (keys, a, b) => { for (const k of keys) { tr.a[k] = a; tr.b[k] = b; } };
    if (zoom > 0.6) { win([K.dist, K.polar, K.azimuth], 0, 0.8); win([K.tx, K.ty, K.tz], 0.3, 1); }
    else if (zoom < -0.6) { win([K.tx, K.ty, K.tz], 0, 0.75); win([K.dist], 0.2, 1); }
    for (const k of [K.event, K.ecal, K.hits, K.hgcal, K.module, K.explode, K.solo, K.mrot]) {
      if (t[k] < f[k] - 1e-3) win([k], 0, 0.55);
      else if (t[k] > f[k] + 1e-3) win([k], k === K.explode || k === K.mrot ? 0.4 : 0.3, 1);
    }
    // (Fog takes the whole flight: its log mapping already makes it set in late and lift early.)
    tr.dur = dur;
    tr.start = clock();
    tr.active = true;
    needsRender = true;
  }

  function startJoinPullOut() {
    joinPending = false;
    const d = VIEWS.join;
    viewVector(d, joinFrom);
    joinFrom[K.dist] = Math.log(d.from.dist); joinFrom[K.polar] = d.from.polar;
    joinFrom[K.azimuth] = d.from.azimuth; joinFrom[K.fov] = d.from.fov;
    state.set(joinFrom);
    startTransition(d, d.pullOut, joinFrom);
  }

  function enterJoin() {
    // Cut to the collision point (the camera would otherwise fly through the detector), then
    // replay the event while pulling out. The cut happens while the old event is still dark.
    if (still) { setState(def); return; }   // paused during the dip: no pull-out, no replay
    const d = VIEWS.join;
    viewVector(d, joinFrom);
    joinFrom[K.dist] = Math.log(d.from.dist); joinFrom[K.polar] = d.from.polar;
    joinFrom[K.azimuth] = d.from.azimuth; joinFrom[K.fov] = d.from.fov;
    state.set(joinFrom);
    vel.fill(0);
    tr.active = false;
    joinPending = true;
    replay();
  }

  let flightToken = 0;
  function setView(name, { instant = false } = {}) {
    if (disposed) return;
    const next = VIEWS[name] ? name : 'home';
    if (next === viewName) return;
    viewName = next;
    def = hgcalFailed && HARDWARE.has(next) ? HARDWARE_FALLBACK : VIEWS[next];
    const token = ++flightToken;       // cancels a flight still waiting for the hardware
    if (HARDWARE.has(next)) ensureHGCAL();
    needsRender = true;

    if (still) {
      // No flying: a quick dip to dark, swap, fade back in.
      if (instant) { setState(def); dip.active = false; fade = 1; return; }
      startDip(0.5, () => setState(def));
      return;
    }
    if (next === 'join') {
      if (instant) { enterJoin(); return; }
      startDip(0.6, enterJoin);
      return;
    }
    dip.active = false;                 // (a cut-off dip fades back up in update)
    joinPending = false;
    if (instant) { setState(def); return; }
    if (HARDWARE.has(next) && !hgcal) {
      // The hardware is built on first use (textures painted, shaders compiled). Hold the flight
      // until it is ready, briefly, so that work does not stall the camera halfway.
      Promise.race([hgcalPromise, new Promise(r => setTimeout(r, 1500))]).then(() => {
        if (token !== flightToken || disposed) return;
        if (still) startDip(0.5, () => setState(def));   // paused while waiting: no flight
        else startTransition(def, null);
      });
      return;
    }
    startTransition(def, null);
  }

  // Dip to dark and back, swapping the view at the darkest point. A dip that is already on its way
  // down keeps its timing and makes both changes at the swap; one on its way back up restarts
  // from the current brightness.
  function startDip(dur, apply) {
    if (dip.active && !dip.swapped) {
      const prev = dip.apply;
      dip.apply = prev ? () => { prev(); apply(); } : apply;
      return;
    }
    dip.apply = apply;
    dip.active = true;
    dip.swapped = false;
    dip.dur = dur;
    dip.start = clock() - (1 - fade) * 0.5 * dur;
  }

  function replay() {
    if (disposed || still) return;
    if (tracksLoading) { pendingReplay = true; return; }   // starts when the tracks arrive
    pendingReplay = false;
    replayStart = clock();
    needsRender = true;
    if (joinPending) startJoinPullOut();
  }

  // Initial pose: the requested view; join starts inside the collision.
  if (HARDWARE.has(viewName)) ensureHGCAL();
  else {
    // Fetch the hardware code in idle time once the event is in, so a later visit to the hardware
    // page only has to build it. (The 3D objects themselves are created only when needed.)
    const idle = cb => (window.requestIdleCallback ? window.requestIdleCallback(cb) : setTimeout(cb, 0));
    setTimeout(() => idle(() => {
      if (disposed || hgcalPromise) return;
      import('./hexaboard.js').catch(() => {});
      import('three/addons/environments/RoomEnvironment.js').catch(() => {});
    }), 6000);
  }
  if (viewName === 'join' && !still) {
    viewVector(def, joinFrom);
    joinFrom[K.dist] = Math.log(def.from.dist); joinFrom[K.polar] = def.from.polar;
    joinFrom[K.azimuth] = def.from.azimuth; joinFrom[K.fov] = def.from.fov;
    state.set(joinFrom);
    joinPending = true;
  }

  // --- input: scroll roll and pointer parallax ------------------------------------------------
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  let scrollRoll = 0;
  const onPointer = e => {
    pointer.x = clamp(e.clientX / Math.max(1, innerWidth) * 2 - 1, -1, 1);
    pointer.y = clamp(e.clientY / Math.max(1, innerHeight) * 2 - 1, -1, 1);
  };
  if (finePointer && !reducedMotion) window.addEventListener('pointermove', onPointer, { passive: true });

  // --- sizing ---------------------------------------------------------------------------------
  let width = 1, height = 1;
  const stage = { center: 0, fit: 1 };
  function resize() {
    const w = Math.max(1, canvas.clientWidth || innerWidth);
    const h = Math.max(1, canvas.clientHeight || innerHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, w < 720 ? 1.5 : 1.75);
    if (w === width && h === height && ratio === renderer.getPixelRatio()) return;
    width = w; height = h;
    if (w > WIDE) {
      const left = Math.min(clamp(w * 0.05, 16, 72) + COLUMN, w * 0.66);
      stage.center = left / (2 * w);                       // stage center, from the screen center
      stage.fit = Math.max(1, STAGE_REF * h / (w - left));
    } else {
      stage.center = 0;
      stage.fit = 1;
    }
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const m of [trackMat, soloMat, electronMat]) { m.uniforms.uViewport.value.copy(buf); m.uniforms.uPx.value = ratio; }
    needsRender = true;
  }
  const ro = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas); else window.addEventListener('resize', resize);
  resize();

  // --- per-frame update -------------------------------------------------------------------------
  const target = new THREE.Vector3();
  const sph = new THREE.Spherical();
  const tmp = new THREE.Vector3();
  let lastFov = -1, lastShift = -1, lastAspect = -1, lastNear = -1, lastDrop = -1;
  let dropStep = -1;                    // still scenes: the drop in use (it changes with a dip, not a glide)
  let dropPending = false;

  function hermite(sg, T) {
    for (let k = 0; k < NK; k++) {
      const a = tr.a[k], w = (tr.b[k] - a) * T;            // window start (fraction) and length (s)
      const s = clamp((sg - a) / (tr.b[k] - a), 0, 1);
      const s2 = s * s, s3 = s2 * s;
      const p0 = tr.from[k], p1 = tr.to[k];
      // Initial velocity carries over only for windows that open immediately.
      const m0 = a > 0 ? 0 : tr.v0[k] * w, m1 = tr.v1[k] * w;
      state[k] = (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1
        + (sg > tr.b[k] ? tr.v1[k] * (sg - tr.b[k]) * T : 0);  // drift on after an early finish
      vel[k] = sg >= a && sg <= tr.b[k]
        ? ((6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * m0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * m1) / w
        : (sg > tr.b[k] ? tr.v1[k] : 0);
    }
  }

  // Load fade of a layer (0..1); keeps the loop rendering while it runs.
  let moving = false;                   // something changes this frame (drawn at the full rate)
  let drifting = false;                 // only the slow orbit/spin drift changes
  function loadFade(name) {
    const l = layers[name];
    if (!l) return 0;
    const a = now - l.loadedAt;
    if (a < 0.7) moving = true;
    return smooth(0, 0.7, a);
  }

  // Narrow screens: how far below the center the subject sits (fraction of the viewport height).
  // It follows the scroll while the scene moves; a still scene switches between the two places
  // halfway down the first screen, through a short dip to dark.
  function heroDrop() {
    if (width > WIDE) { dropStep = -1; return 0; }
    const out = clamp((window.scrollY || 0) / height, 0, 1);
    if (!still) { dropStep = -1; return DROP * (1 - out); }
    const want = () => (clamp((window.scrollY || 0) / height, 0, 1) < 0.5 ? DROP : 0);
    if (dropStep < 0) dropStep = want();
    else if (want() !== dropStep && !(dropPending && dip.active)) {
      dropPending = true;
      startDip(0.5, () => { dropPending = false; dropStep = want(); });
    }
    return dropStep;
  }

  function update(dt) {
    moving = false;
    drifting = false;

    if (dip.active) {
      const s = (now - dip.start) / dip.dur;
      if (s >= 0.5 && !dip.swapped) { dip.swapped = true; dip.apply(); }
      fade = s >= 1 ? 1 : smooth(0, 1, Math.abs(1 - 2 * s));
      if (s >= 1) dip.active = false;
      moving = true;
    } else if (fade < 1) {
      fade = Math.min(1, fade + dt * 3);
      moving = true;
    }

    if (tr.active) {
      const s = Math.min(1, (now - tr.start) / tr.dur);
      hermite(s, tr.dur);
      if (s >= 1) tr.active = false;
      moving = true;
    } else if (!still && (def.orbit || def.spin)) {
      state[K.azimuth] += def.orbit * dt;
      state[K.roll] += def.spin * dt;
      vel.fill(0);
      vel[K.azimuth] = def.orbit; vel[K.roll] = def.spin;
      drifting = true;                  // slow: drawn at a reduced rate (see frame)
    } else {
      vel.fill(0);
    }

    // Scroll-linked roll and pointer parallax, both eased.
    if (!still) {
      const goal = (window.scrollY || 0) * 0.00025;
      const ease = 1 - Math.exp(-dt * 4);
      if (Math.abs(goal - scrollRoll) > 1e-4) { scrollRoll += (goal - scrollRoll) * ease; moving = true; }
      if (finePointer) {
        const pe = 1 - Math.exp(-dt * 2.5);
        const dx = pointer.x - pointer.sx, dy = pointer.y - pointer.sy;
        if (Math.abs(dx) + Math.abs(dy) > 1e-4) { pointer.sx += dx * pe; pointer.sy += dy * pe; moving = true; }
      }
    }

    // Camera.
    const aspect = width / height;
    // Keep the subject in frame: on the stage beside the text, or on narrow (portrait) screens.
    const fit = width > WIDE ? stage.fit : Math.max(1, state[K.fit] / aspect);
    target.set(state[K.tx], state[K.ty], state[K.tz]);
    sph.set(
      Math.exp(state[K.dist]) * Math.pow(fit, 0.42),
      clamp(state[K.polar] + pointer.sy * 0.045, 0.05, Math.PI - 0.05),
      state[K.azimuth] - pointer.sx * 0.08,
    );
    camera.position.setFromSpherical(sph).add(target);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(state[K.fov]) / 2) * Math.pow(fit, 0.58)));
    const shift = state[K.shift] * stage.center;
    const near = clamp(sph.radius * 0.02, 0.005, 0.1);
    const drop = heroDrop();
    if (fov !== lastFov || shift !== lastShift || aspect !== lastAspect || near !== lastNear || drop !== lastDrop) {
      if (drop !== lastDrop) needsRender = true;
      lastFov = fov; lastShift = shift; lastAspect = aspect; lastNear = near; lastDrop = drop;
      camera.fov = fov;
      camera.aspect = aspect;
      camera.near = near;
      if (shift > 0.001 || drop > 0.001) camera.setViewOffset(width, height, -shift * width, -drop * height, width, height);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }

    eventRoot.rotation.z = state[K.roll] + scrollRoll;

    // Depth cue for the hardware close-ups, measured from the target in units of the view's own
    // distance (so phones, where the camera pulls back, get the same falloff). Log-interpolated,
    // so it only sets in near the end of a flight.
    const fogA = clamp(state[K.fog], 0, 1), d0 = Math.exp(state[K.dist]);
    scene.fog.near = sph.radius + d0 * Math.exp((1 - fogA) * Math.log(FOG_OFF[0]) + fogA * Math.log(FOG[0]));
    scene.fog.far = sph.radius + d0 * Math.exp((1 - fogA) * Math.log(FOG_OFF[1]) + fogA * Math.log(FOG[1]));

    // Replay clock and layer opacities.
    const t = replayTime();
    if (pendingReplay || (replayStart >= 0 && t < REPLAY_END)) moving = true;
    const b = clamp(state[K.bright], 0, 2) * fade;
    const ev = clamp(state[K.event], 0, 2) * b;
    const solo = clamp(state[K.solo], 0, 1);

    if (layers.tracks) {
      const u = trackMat.uniforms;
      u.uTime.value = t;
      u.uOpacity.value = ev * loadFade('tracks');
      u.uSolo.value = soloIndex;
      u.uSoloMix.value = soloIndex >= 0 ? solo : 0;
      u.uSoloTime.value = still ? -1 : now % 4.6;
      if (solo > 0.01 && !still) moving = true;
      layers.tracks.object.visible = u.uOpacity.value > 0.002;
    }
    if (layers.soloExtension) {
      const u = soloMat.uniforms;
      u.uTime.value = t;
      u.uSoloTime.value = trackMat.uniforms.uSoloTime.value;
      u.uOpacity.value = ev * solo * loadFade('soloExtension');
      layers.soloExtension.object.visible = u.uOpacity.value > 0.002;
    }
    if (layers.electrons) {
      const u = electronMat.uniforms;
      u.uTime.value = t;
      u.uOpacity.value = ev * (1 - solo) * loadFade('electrons');
      layers.electrons.object.visible = u.uOpacity.value > 0.002;
    }
    const hitsOpacity = clamp(state[K.hits], 0, 2) * b * 0.55;
    for (let i = 0; i < HIT_LAYERS.length; i++) {
      const l = layers[HIT_LAYERS[i]];
      if (!l) continue;
      const u = l.object.material.uniforms;
      u.uTime.value = t;
      u.uOpacity.value = hitsOpacity * loadFade(HIT_LAYERS[i]);
      l.object.visible = u.uOpacity.value > 0.002;
    }
    if (layers.geometry) {
      const g = clamp(state[K.ecal], 0, 3) * b * loadFade('geometry');
      geometryMat.opacity = GEOMETRY_ALPHA * g;
      geometryLineMat.opacity = GEOMETRY_LINE_ALPHA * g;
      layers.geometry.object.visible = g > 0.01;
    }

    // Collision flash and the steady glow at the vertex. The flash never fills the screen,
    // even when the camera starts inside the collision (join).
    const camDist = camera.position.distanceTo(flash.getWorldPosition(tmp));
    const ft = t;
    const flashI = ft < 0 ? 0 : ft < 0.06 ? ft / 0.06 : Math.exp(-(ft - 0.06) / 0.18);
    flash.material.opacity = ev * flashI * (1 - solo);
    const fs = Math.min(0.4 + 2.6 * (1 - Math.exp(-ft / 0.1)), camDist * 0.6);
    flash.scale.set(fs, fs, 1);
    flash.visible = flash.material.opacity > 0.003;
    const gs = Math.min(0.55, camDist * 0.35);
    vertexGlow.scale.set(gs, gs, 1);
    const soloBeat = still ? 0 : solo * Math.exp(-(now % 4.6) / 0.3);   // the lone track's pulse leaves the vertex
    vertexGlow.material.opacity = ev * (0.42 * smooth(0.05, 0.5, t) + 0.5 * soloBeat);
    vertexGlow.visible = vertexGlow.material.opacity > 0.003;

    // HGCAL.
    if (hgcal) {
      const a = now - hgcal.loadedAt;
      const hf = smooth(0, 0.8, a) * fade * clamp(state[K.bright], 0, 1);
      if (a < 0.8) moving = true;
      setFade(hgcal.layerFade, clamp(state[K.hgcal], 0, 1) * hf);
      setFade(hgcal.moduleFade, clamp(state[K.module], 0, 1) * hf);
      const ex = clamp(state[K.explode], 0, 1);
      if (Math.abs(ex - lastExplode) > 1e-4) { lastExplode = ex; hgcal.module.setExplode(ex); }
      const mr = clamp(state[K.mrot], 0, 1);
      if (Math.abs(mr - lastMrot) > 1e-4) { lastMrot = mr; modulePivot.quaternion.slerpQuaternions(MODULE_Q, MODULE_Q_EXPLODED, smooth(0, 1, mr)); }
      // The sensor-hit animation runs only on the exploded module; update() says when it changed.
      if (!still && hgcal.module.group.visible && hgcal.module.update(dt)) moving = true;
    }

    return moving;
  }

  // --- loop -------------------------------------------------------------------------------------
  let raf = 0, last = 0, lost = false, wasMoving = true, lastDraw = 0;
  function frame(ms) {
    raf = 0;
    if (disposed || lost || document.hidden) return;
    raf = requestAnimationFrame(frame);
    now = ms / 1000;
    const dt = last ? Math.min(0.05, now - last) : 0.016;
    last = now;
    try {
      const moving = update(dt);
      // Idle views cost nothing: render only while something changes, plus one settling frame
      // (a long frame can skip past the end of a fade). A slow drift alone does not need 60-120
      // frames a second: it is drawn at about 30, which saves battery on long reads.
      if (moving || needsRender || wasMoving || (drifting && now - lastDraw > 0.026)) {
        needsRender = false;
        lastDraw = now;
        renderer.render(scene, camera);
      }
      wasMoving = moving;
    } catch (err) {
      warn('render failed', err);
      cancelAnimationFrame(raf);
      raf = 0;
      disposed = true;
    }
  }
  function start() {
    if (!raf && !disposed && !lost && !document.hidden) { last = 0; needsRender = true; raf = requestAnimationFrame(frame); }
  }
  const onVisibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start(); };
  const onLost = e => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; };
  const onRestored = () => { lost = false; start(); };
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  start();

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    window.removeEventListener('pointermove', onPointer);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach(x => { if (x.map) x.map.dispose(); x.dispose(); });
    });
    glowTex.dispose();
    if (hgcal) { hgcal.layer.dispose?.(); hgcal.module.dispose?.(); }
    if (envTexture) envTexture.dispose();
    renderer.dispose();
  }

  // Resolve once the renderer runs and the tracks (the part people look at first) are in, but
  // never wait longer than a moment on a slow connection: the rest streams in and fades up.
  await Promise.race([tracksReady, new Promise(r => setTimeout(r, 2500))]);

  function setPaused(p) {
    const next = !!p || reducedMotion;
    if (disposed || next === still) return;
    still = next;
    if (still) {
      // Land where things were heading: a flight ends at its view, a replay shows its last frame.
      if (tr.active) setState(def);
      pendingReplay = false;
      replayStart = -1;
      joinPending = false;
    }
    needsRender = true;
    start();
  }

  return { setView, replay, setPaused, dispose };
}
