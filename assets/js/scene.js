// Live CMS event display behind every page (three.js r161, plain ES module, no build step).
//
// The models are a real CMS collision event exported from the iSpy event display (models/*.glb,
// meters, beam along z): charged-particle tracks (yellow), ECAL energy deposits in the barrel and
// endcaps (EB/EE, green), HCAL barrel deposits (HB, blue), two reconstructed electrons, and the ECAL
// barrel geometry drawn as faint glass. The hardware views add a procedural HGCAL layer and module
// from hexaboard.js, loaded on first use. The research views group the event's tracks into jets
// (a real anti-kT clustering, run here on the track data) and add an illustration, which is not
// CMS data, of how b jets and top-quark jets are tagged.
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
  jets: ['#ff8a4c', '#b98cff', '#5ad1ff', '#ff6fa8'],   // jets found in the event, hardest first (site.css: --jet-1, --jet-2)
  toyB: '#ff6b6b', toyW: ['#5ad1ff', '#b98cff'],        // illustration: the b jet and the two jets from the W
  toyCone: '#dfe8f5', toyFlight: '#ffd9d9',
  geometry: new THREE.Color(0.498, 0.8, 1),         // ECAL barrel material in the original export (linear)
};

// Collision replay timeline, in seconds. Particles leave the vertex at SPEED m/s (slowed down a lot).
const SPEED = 3.4;
const STAGGER = [0.12, 0.3];      // each track starts at 0.12 s + up to 0.3 s of random stagger
const HIT_GROW = 0.55;            // energy deposits grow out of their inner face
const ELECTRON_START = 1.95;      // the two reconstructed electrons are drawn last, faster
const ELECTRON_SPEED = 5.5;
const REPLAY_END = 3.2;           // everything is idle after this
const LOOP_DIP = 0.6;             // s: the dip to dark through which a view enters or loops
const FINAL = 1e4;                // "replay finished" clock value

// Jets (research views). Anti-kT with R = 0.4 on the charged-particle tracks; the jets above
// JET_MIN_PT (GeV of track momentum) are colored and get a cone. After the replay, the tracks take
// their jet's color in the order in which the algorithm merged them.
const JET_R = 0.4;
const JET_MIN_PT = 30;
const CLUSTER_START = 0.35;       // s after the replay ends
const CLUSTER_TIME = 2.6;         // s from the first merge to the last
const JET_DIM = 0.3;              // brightness left to the tracks outside those jets
const TRACKER = { r: 1.29, z: 3.17 };   // where the tracks end and the calorimeters begin (m)

// Illustration for the research page (not CMS data): the jet of a fast top quark, t -> b W, W -> q q'.
// A top quark with pT = 650 GeV; the three quarks' momenta (GeV) and their offsets from its direction
// in (eta, phi) follow from the decay kinematics (m_t = 172.5 GeV, m_W = 80.4 GeV). The b hadron
// flies `flight` meters before it decays, so some of the b jet's tracks start at a second vertex.
const TOY = {
  vertex: [0, 0, -0.036], eta: -0.2, phi: 1.13, R: 0.8, subR: 0.2, flight: 0.006,
  quarks: [
    { pt: 270, deta: 0.205, dphi: -0.141, b: true },
    { pt: 236, deta: -0.066, dphi: 0.247 },
    { pt: 155, deta: -0.257, dphi: -0.129 },
  ],
  decayAt: 1.25,                  // s on the illustration's clock: the b hadron decays
  conesAt: 1.7,                   // the three cores are outlined, then the wide jet around them
  end: 3.6,
};

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
// angle about the beam axis (rad) and spin its speed (rad/s); steady: the event does not roll
// with the page scroll; shift: placement on the stage of wide screens (see COLUMN); fit: aspect
// below which narrow screens pull back (default FIT); bright: overall brightness. from, pullOut:
// an entrance (the camera cuts to the `from` pose, the event replays, and the camera takes pullOut
// seconds to reach the view); loop: the entrance repeats every so many seconds. jets (0..1): the
// tracks take their jet's color and the jet cones show. toy (0..1): the illustrated top-quark jet.
// lift: on narrow screens, how far above the center the subject sits (fraction of the viewport
// height), so that it shows in the gap above a section's text.
// Hardware close-ups only: fog (0..1, see FOG), explode (the module's layers apart, 0..1) and mrot
// (the module laid back for the exploded view, 0..1).
// ---------------------------------------------------------------------------------------------
const L = (event, ecal, hits, hgcal = 0, module = 0) => ({ event, ecal, hits, hgcal, module });
const TOY_VERTEX = new THREE.Vector3().fromArray(TOY.vertex);
const direction = (eta, phi) => new THREE.Vector3(Math.cos(phi), Math.sin(phi), Math.sinh(eta)).normalize();

const VIEWS = {
  // Home: the camera starts at the collision point and pulls out while the event replays, then
  // drifts; every `loop` seconds it does so again.
  home: {
    target: [0, 0, 0], dist: 14.5, polar: 1.12, azimuth: 0.62, fov: 38,
    roll: -0.9, orbit: 0.025, spin: 0, shift: 0.97, bright: 1, layers: L(1, 1, 1), fit: 0.91,
    from: { dist: 0.28, polar: 1.34, azimuth: 1.4, fov: 62 }, pullOut: 3.8, loop: 15,
  },
  // Research: the two jets found in the event, then (as sections scroll past) the illustration of
  // b tagging at the collision point and of top tagging, and the side view of the real event.
  research: {
    target: [0, 0, -0.9], dist: 19, polar: 1.2, azimuth: 2.2, fov: 30,
    roll: -0.63, orbit: 0.012, spin: 0, shift: 0.95, bright: 1, layers: L(1, 1.2, 0.9), jets: 1, fit: 0.95,
  },
  // (The targets of the two illustration views, and the close-up's direction, follow from the
  // illustration's geometry: see below the table.)
  'research-btag': {
    target: TOY.vertex, dist: 0.04, polar: 1.25, azimuth: 0.5, fov: 34,
    roll: -0.63, orbit: 0, spin: 0, shift: 0.9, bright: 1, layers: L(0, 0.2, 0), toy: 1, steady: true, fit: 0.9, lift: 0.29,
  },
  'research-top': {
    target: TOY.vertex, dist: 6.2, polar: 1.25, azimuth: 0.5, fov: 34,
    roll: -0.63, orbit: 0, spin: 0, shift: 0.9, bright: 1, layers: L(0, 0.2, 0), toy: 1, steady: true, fit: 0.9, lift: 0.25,
  },
  'research-side': {
    target: [0, 0, -0.25], dist: 19.5, polar: 1.5, azimuth: Math.PI / 2, fov: 32,
    roll: -0.63, orbit: 0, spin: 0.006, shift: 1.04, bright: 1, layers: L(0.9, 1.6, 1), jets: 1, fit: 0.85,
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
  // Teaching: looking along the beam line. The event turns slowly on its own, but not with the
  // page scroll (steady).
  teaching: {
    target: [0, 0, 0], dist: 15, polar: Math.PI / 2, azimuth: 0, fov: 26,
    roll: -1.5, orbit: 0, spin: 0.02, shift: 0.95, bright: 1, layers: L(1, 1.4, 0.9), steady: true, fit: 0.99,
  },
  join: {
    target: [0, 0.05, -0.2], dist: 17.5, polar: 1.17, azimuth: -0.78, fov: 34,
    roll: -1.45, orbit: 0.03, spin: 0, shift: 0.9, bright: 1, layers: L(1, 0.55, 1), fit: 0.91,
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
// The illustration's views. Wide: centered on the jet. Close-up: the b hadron's flight from the
// collision point to the second vertex and the tracks that start there, seen side-on, from the
// direction that puts the other two bundles of tracks to one side and as far away as possible.
{
  const wide = VIEWS['research-top'], close = VIEWS['research-btag'];
  const world = v => v.applyAxisAngle(new THREE.Vector3(0, 0, 1), wide.roll);   // the event frame, rolled
  const at = (deta, dphi) => world(direction(TOY.eta + deta, TOY.phi + dphi));
  const b = TOY.quarks.find(q => q.b);
  const axis = at(0, 0), bAxis = at(b.deta, b.dphi);
  wide.target = TOY_VERTEX.clone().addScaledVector(axis, 0.7).toArray();
  // In the (eta, phi) plane: the mean direction from the b quark to the other two quarks.
  const away = new THREE.Vector2();
  for (const q of TOY.quarks) if (q !== b) away.add(new THREE.Vector2(q.deta - b.deta, q.dphi - b.dphi).normalize());
  away.normalize();
  const side = at(0.01, 0).sub(axis).normalize().multiplyScalar(away.x).add(at(0, 0.01).sub(axis).normalize().multiplyScalar(away.y));
  const eye = new THREE.Vector3().crossVectors(bAxis, side).normalize();
  if (eye.dot(new THREE.Vector3().setFromSphericalCoords(1, wide.polar, wide.azimuth)) < 0) eye.negate();
  const sph = new THREE.Spherical().setFromVector3(eye);
  Object.assign(close, { target: TOY_VERTEX.clone().addScaledVector(bAxis, TOY.flight * 1.5).toArray(), polar: sph.phi, azimuth: sph.theta });
}
const HARDWARE = new Set(['hardware', 'hardware-module', 'hardware-exploded']);
// If the hardware cannot be built (hexaboard.js failed to load), every hardware view shows the
// endcap pose with the event at full strength instead of an empty close-up.
const HARDWARE_FALLBACK = { ...VIEWS.hardware, layers: L(0.85, 0.9, 0.9), orbit: 0.02 };
const HIT_LAYERS = ['eb', 'ee', 'hb'];

// State vector interpolated between views (dist is stored as a logarithm so zooms feel even).
const K = { tx: 0, ty: 1, tz: 2, dist: 3, polar: 4, azimuth: 5, fov: 6, shift: 7, event: 8, ecal: 9,
  hits: 10, hgcal: 11, module: 12, bright: 13, explode: 14, solo: 15, roll: 16, fog: 17, fit: 18, mrot: 19,
  jets: 20, toy: 21, lift: 22 };
const NK = 23;
const ANGLES = [K.azimuth, K.roll];

function viewVector(def, out = new Float64Array(NK)) {
  out[K.tx] = def.target[0]; out[K.ty] = def.target[1]; out[K.tz] = def.target[2];
  out[K.dist] = Math.log(def.dist); out[K.polar] = def.polar; out[K.azimuth] = def.azimuth;
  out[K.fov] = def.fov; out[K.shift] = def.shift; out[K.bright] = def.bright;
  out[K.event] = def.layers.event; out[K.ecal] = def.layers.ecal; out[K.hits] = def.layers.hits;
  out[K.hgcal] = def.layers.hgcal; out[K.module] = def.layers.module;
  out[K.explode] = def.explode || 0; out[K.solo] = def.solo || 0; out[K.roll] = def.roll;
  out[K.fog] = def.fog || 0; out[K.fit] = def.fit || FIT; out[K.mrot] = def.mrot || 0;
  out[K.jets] = def.jets || 0; out[K.toy] = def.toy || 0; out[K.lift] = def.lift || 0;
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
attribute vec4 iTint;          // the track's jet color (linear rgb) and when it takes it (s); < 0: no jet
uniform float uTint;           // how much of the jet coloring shows (0..1)
uniform float uTintTime;       // clustering clock (s)
uniform float uDim;            // brightness of tracks outside the jets once the coloring is on
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
varying vec4 vTint;            // rgb, amount
varying float vKeep;

void main() {
  vTint = vec4(iTint.rgb, iTint.w < 0.0 ? 0.0 : uTint * smoothstep(0.0, 0.3, uTintTime - iTint.w));
  vKeep = iTint.w < 0.0 ? mix(1.0, uDim, uTint) : 1.0;
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
uniform float uHeadLen;        // length of the bright head behind the growing tip (m)
varying float vAcross;
varying float vArc;
varying float vTip;
varying float vSolo;
varying vec4 vTint;
varying float vKeep;

void main() {
  float d = abs(vAcross) * uHalf;
  float head = uHead * exp(-max(vTip - vArc, 0.0) / uHeadLen);
  float keep = mix(1.0, vSolo, uSoloMix) * vKeep;
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
  gl_FragColor = vec4(mix(mix(uColor, vTint.rgb, vTint.a), uHeadColor, min(head, 1.0)), clamp(a, 0.0, 1.0));
#else
  float aa = 0.8 / uPx;
  float core = 1.0 - smoothstep(uCoreW - aa, uCoreW + aa, d);
  float a = uOpacity * keep * core;
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(mix(uCore, mix(vTint.rgb, vec3(1.0), 0.3), vTint.a), uHeadColor, min(head, 1.0)), clamp(a, 0.0, 1.0));
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

// Jet cones: a faint sheet, brighter toward its silhouette and at its rim, invisible near the
// vertex (so a close-up of the collision point is not veiled). It grows from the vertex outward.
const CONE_VERT = /* glsl */`
attribute float aV;            // 0 at the vertex, 1 at the rim
varying float vV;
varying float vEdge;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vEdge = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  vV = aV;
  gl_Position = projectionMatrix * mv;
}`;

const CONE_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uGrow;           // 0..1: how far the cone has grown
varying float vV;
varying float vEdge;

void main() {
  if (vV > uGrow) discard;
  float body = 0.07 + 0.55 * vEdge * vEdge * vEdge;
  float rim = 0.55 * smoothstep(0.972, 0.99, vV);
  float front = uGrow < 0.999 ? 0.5 * smoothstep(uGrow - 0.05, uGrow, vV) : 0.0;
  float a = uOpacity * smoothstep(0.02, 0.32, vV) * (body + rim + front);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, min(a, 1.0));
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Jets
// ---------------------------------------------------------------------------------------------

// Anti-kT jet clustering (Cacciari, Salam, Soyez, 2008) with E-scheme recombination, on massless
// particles [{ pt, eta, phi }]. Returns the jets, hardest first, each with the indices of its
// particles, and for every particle the step at which the algorithm first merged it into a jet.
function antiKt(parts, R) {
  const objs = [];
  parts.forEach((p, i) => {
    if (!(p.pt > 0) || !Number.isFinite(p.eta)) return;
    objs.push({ px: p.pt * Math.cos(p.phi), py: p.pt * Math.sin(p.phi), pz: p.pt * Math.sinh(p.eta), e: p.pt * Math.cosh(p.eta),
      pt: p.pt, eta: p.eta, phi: p.phi, members: [i] });
  });
  const joined = new Array(parts.length).fill(-1);
  const jets = [];
  for (let step = 0; objs.length; step++) {
    let best = Infinity, a = -1, b = -1;
    for (let i = 0; i < objs.length; i++) {
      const oi = objs[i], ki = 1 / (oi.pt * oi.pt);
      if (ki < best) { best = ki; a = i; b = -1; }             // distance to the beam: oi is a jet
      for (let j = i + 1; j < objs.length; j++) {
        const oj = objs[j], deta = oi.eta - oj.eta;
        let dphi = Math.abs(oi.phi - oj.phi);
        if (dphi > Math.PI) dphi = TAU - dphi;
        const d = Math.min(ki, 1 / (oj.pt * oj.pt)) * (deta * deta + dphi * dphi) / (R * R);
        if (d < best) { best = d; a = i; b = j; }
      }
    }
    if (b < 0) {
      const jet = objs.splice(a, 1)[0];
      for (const m of jet.members) if (joined[m] < 0) joined[m] = step;
      jets.push(jet);
      continue;
    }
    const oi = objs[a], oj = objs[b];
    const members = oi.members.concat(oj.members);
    for (const m of members) if (joined[m] < 0) joined[m] = step;
    const px = oi.px + oj.px, py = oi.py + oj.py, pz = oi.pz + oj.pz, e = oi.e + oj.e, pt = Math.hypot(px, py);
    objs.splice(b, 1);                                          // b > a
    objs.splice(a, 1);
    objs.push({ px, py, pz, e, pt, eta: Math.asinh(pz / pt), phi: Math.atan2(py, px), members });
  }
  jets.sort((p, q) => q.pt - p.pt);
  return { jets, joined };
}

// A jet cone: every direction at distance R from the axis in (eta, phi), from the vertex out to
// where the tracker ends (the barrel radius or the endcap plane).
function coneMesh(apex, eta, phi, R, color, segments = 64) {
  const rim = [];
  for (let k = 0; k < segments; k++) {
    const a = k / segments * TAU;
    const d = direction(eta + R * Math.cos(a), phi + R * Math.sin(a));
    const st = Math.hypot(d.x, d.y);
    const toBarrel = st > 1e-6 ? TRACKER.r / st : Infinity;
    const toEndcap = Math.abs(d.z) > 1e-6 ? (Math.sign(d.z) * TRACKER.z - apex.z) / d.z : Infinity;
    rim.push(apex.clone().addScaledVector(d, Math.min(toBarrel, toEndcap)));
  }
  const normals = rim.map((p, k) => {
    const t = rim[(k + 1) % segments].clone().sub(rim[(k + segments - 1) % segments]);
    return t.cross(p.clone().sub(apex)).normalize();
  });
  const P = new Float32Array(segments * 9), N = new Float32Array(segments * 9), V = new Float32Array(segments * 3);
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % segments;
    apex.toArray(P, k * 9); rim[k].toArray(P, k * 9 + 3); rim[k1].toArray(P, k * 9 + 6);
    normals[k].toArray(N, k * 9); normals[k].toArray(N, k * 9 + 3); normals[k1].toArray(N, k * 9 + 6);
    V[k * 3 + 1] = V[k * 3 + 2] = 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('aV', new THREE.BufferAttribute(V, 1));
  g.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({
    vertexShader: CONE_VERT, fragmentShader: CONE_FRAG,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 }, uGrow: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(g, material);
}

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

// chains: [{ pts, arc0?, index?, tint? }]; arc0 continues an earlier track's arc length (404
// extension); tint is the track's jet color and timing, [r, g, b, s] (see iTint).
const NO_TINT = [0, 0, 0, -1];
function buildRibbons(chains, delays) {
  let nSeg = 0;
  for (const c of chains) nSeg += c.pts.length / 3 - 1;
  const start = new Float32Array(nSeg * 3), end = new Float32Array(nSeg * 3), data = new Float32Array(nSeg * 4);
  const tint = new Float32Array(nSeg * 4);
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
      tint.set(c.tint || NO_TINT, s * 4);
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
  g.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 4));
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
    uTint: { value: 0 }, uTintTime: { value: 0 }, uDim: { value: 1 }, uHeadLen: { value: 0.16 },
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
  let entrancePending = false;          // the camera waits at a view's entrance pose for the replay
  let loopAt = 0;                       // when a looping view replays its entrance (s); 0 = not scheduled
  let jetStart = -1;                    // when the tracks start to take their jets' colors (s); -1 = done
  let toyStart = -1;                    // when the illustration starts to draw itself (s); -1 = done
  const replayTime = () => (replayStart >= 0 ? now - replayStart : (pendingReplay ? 0 : FINAL));
  const jetTime = () => (still || jetStart < 0 ? FINAL : now - jetStart);
  const toyTime = () => (still || toyStart < 0 ? FINAL : now - toyStart);

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
  const toyMat = ribbonMaterials({ color: COLOR.track, core: COLOR.trackCore, speed: SPEED, coreW: 0.75, sigma: 1.9, glow: 0.38, head: 0.85, half: 5 });
  toyMat.uniforms.uTint.value = 1;          // every track of the illustration has its jet's color
  toyMat.uniforms.uTintTime.value = FINAL;

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

  // Jets: cluster the tracks (direction at the start of each track, transverse momentum from the
  // event file), color the tracks of every jet above JET_MIN_PT and outline it with a cone.
  const jetCones = [];                  // [{ mesh, t0, t1 }]: each cone grows between t0 and t1 on the clustering clock
  function addJets(chains, pt) {
    const parts = chains.map((c, i) => {
      const q = c.pts, dx = q[3] - q[0], dy = q[4] - q[1], dz = q[5] - q[2];
      return { pt: pt[i], eta: Math.asinh(dz / Math.max(1e-9, Math.hypot(dx, dy))), phi: Math.atan2(dy, dx) };
    });
    const { jets, joined } = antiKt(parts, JET_R);
    const picked = jets.filter(j => j.pt > JET_MIN_PT).slice(0, COLOR.jets.length);
    if (!picked.length) return;
    // The order in which the algorithm merged the tracks of those jets, spread over CLUSTER_TIME.
    const order = picked.flatMap(j => j.members).sort((a, b) => joined[a] - joined[b]);
    const when = new Map(order.map((i, k) => [i, CLUSTER_TIME * k / Math.max(1, order.length - 1)]));
    const group = new THREE.Group();
    picked.forEach((jet, ji) => {
      const color = new THREE.Color(COLOR.jets[ji]);
      let z = 0, w = 0, t0 = Infinity, t1 = 0;
      for (const i of jet.members) {
        const t = when.get(i);
        chains[i].tint = [color.r, color.g, color.b, t];
        t0 = Math.min(t0, t); t1 = Math.max(t1, t);
        const q = chains[i].pts;
        if (Math.hypot(q[0], q[1]) < 0.005) { z += q[2] * pt[i]; w += pt[i]; }   // tracks from the collision point
      }
      const mesh = coneMesh(new THREE.Vector3(0, 0, w ? z / w : 0), jet.eta, jet.phi, JET_R, color);
      mesh.renderOrder = 2.6;
      group.add(mesh);
      jetCones.push({ mesh, t0, t1: t1 + 0.4 });
    });
    addLayer('jets', group, 2.6);
  }

  const tracksReady = load('Tracks_V3.glb').then(gltf => {
    const chains = extractChains(gltf.scene);
    const delays = chains.map(() => STAGGER[0] + random() * STAGGER[1]);
    const node = chains[0] && chains[0].node;
    const pt = node && node.userData && Array.isArray(node.userData.pt) && node.userData.pt.length === chains.length ? node.userData.pt : null;
    if (pt) {
      try { addJets(chains, pt); } catch (err) { warn('jets unavailable', err); }
    }
    const { group, lengths } = ribbons(chains, delays, trackMat, 3);
    addLayer('tracks', group, 3);
    // Lone track for the 404 view: the longest high-momentum track from the primary vertex.
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

  // --- illustration: the jet of a fast top quark (research views; not CMS data) -----------------
  // Three bundles of tracks (the b quark and the two quarks from the W boson), a cone around each
  // and a wide one around all three. Four tracks of the b jet start at a second vertex, where the
  // b hadron decayed after a short flight (drawn as a dotted line).
  const toy = (() => {
    const rand = rng(1725);
    const B = 3.8;                      // T: charged particles curl in the solenoid's field
    const chains = [], delays = [];
    function helix(origin, pt, eta, phi, q) {
      const R = pt / (0.3 * B), th0 = phi - q * Math.PI / 2, sinh = Math.sinh(eta);
      const cx = origin.x - R * Math.cos(th0), cy = origin.y - R * Math.sin(th0);
      const pts = [];
      for (let a = 0; a < 6; a += 0.03) {                     // a: arc length in the transverse plane (m)
        const th = th0 + q * a / R;
        const x = cx + R * Math.cos(th), y = cy + R * Math.sin(th), z = origin.z + a * sinh;
        if (Math.hypot(x, y) > TRACKER.r || Math.abs(z) > TRACKER.z) break;
        pts.push(x, y, z);
      }
      return new Float32Array(pts);
    }
    const group = new THREE.Group();
    const cones = [];
    let sv = TOY_VERTEX.clone(), wi = 0;
    for (const quark of TOY.quarks) {
      const eta = TOY.eta + quark.deta, phi = TOY.phi + quark.dphi;
      const color = new THREE.Color(quark.b ? COLOR.toyB : COLOR.toyW[wi++]);
      const tint = [color.r, color.g, color.b, 0];
      const add = (origin, pt, delta, angle, delay) => {
        const pts = helix(origin, Math.max(1.5, pt), eta + delta * Math.cos(angle), phi + delta * Math.sin(angle), rand() < 0.5 ? 1 : -1);
        if (pts.length >= 9) { chains.push({ pts, tint }); delays.push(delay); }
      };
      if (quark.b) {
        // A few tracks from the collision point, clear of the b hadron's line of flight, and its
        // decay products, which start at the second vertex (their angles are widened to be legible).
        [0.07, 0.05, 0.035].forEach((z, k) => add(TOY_VERTEX, z * quark.pt, 0.11 + 0.03 * k, (k + 0.3 * rand()) * TAU / 3 + 2.2, 0.1 + 0.2 * rand()));
        sv = TOY_VERTEX.clone().addScaledVector(direction(eta, phi), TOY.flight);
        [0.2, 0.13, 0.08, 0.05].forEach((z, k) => add(sv, z * quark.pt, 0.07 + 0.04 * k, (k + 0.4 * rand()) * TAU / 4 + 0.6, TOY.decayAt));
      } else {
        // Tracks from the collision point: fractions of the quark's momentum, the softer ones at wider angles.
        for (const z of [0.24, 0.16, 0.11, 0.08, 0.055, 0.04, 0.03, 0.02]) {
          add(TOY_VERTEX, z * quark.pt * (0.8 + 0.4 * rand()), Math.min(0.19, 0.035 / Math.sqrt(z) * (0.4 + 1.2 * rand())), rand() * TAU, 0.1 + 0.2 * rand());
        }
      }
      const mesh = coneMesh(TOY_VERTEX, eta, phi, TOY.subR, color);
      mesh.renderOrder = 2.6;
      group.add(mesh);
      cones.push({ mesh, t0: TOY.conesAt, t1: TOY.conesAt + 0.8, strength: 1 });
    }
    const wide = coneMesh(TOY_VERTEX, TOY.eta, TOY.phi, TOY.R, COLOR.toyCone);
    wide.renderOrder = 2.55;
    group.add(wide);
    cones.push({ mesh: wide, t0: TOY.conesAt + 0.7, t1: TOY.conesAt + 1.6, strength: 0.55 });
    group.add(ribbons(chains, delays, toyMat, 3).group);

    const N = 9;
    const dots = new Float32Array(N * 3);
    for (let k = 0; k < N; k++) TOY_VERTEX.clone().lerp(sv, (k + 1) / (N + 1)).toArray(dots, k * 3);
    const dotGeometry = new THREE.BufferGeometry();
    dotGeometry.setAttribute('position', new THREE.BufferAttribute(dots, 3));
    const flight = new THREE.Points(dotGeometry, new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, map: glowTex, color: COLOR.toyFlight, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    flight.frustumCulled = false;
    const glow = color => new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    const pvGlow = glow(COLOR.flash), svGlow = glow(COLOR.toyB);
    pvGlow.position.copy(TOY_VERTEX);
    svGlow.position.copy(sv);
    flight.renderOrder = pvGlow.renderOrder = svGlow.renderOrder = 5;
    group.add(flight, pvGlow, svGlow);
    group.visible = false;
    group.renderOrder = 3.2;
    eventRoot.add(group);
    return { group, cones, flight, dots: N, pvGlow, svGlow };
  })();

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
  const entranceFrom = new Float64Array(NK);

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
    for (const k of [K.event, K.ecal, K.hits, K.hgcal, K.module, K.explode, K.solo, K.mrot, K.jets, K.toy]) {
      if (t[k] < f[k] - 1e-3) win([k], 0, 0.55);
      else if (t[k] > f[k] + 1e-3) win([k], k === K.explode || k === K.mrot ? 0.4 : 0.3, 1);
    }
    // (Fog takes the whole flight: its log mapping already makes it set in late and lift early.)
    tr.dur = dur;
    tr.start = clock();
    tr.active = true;
    needsRender = true;
  }

  // Entrances (views with `from`): the camera cuts to the entrance pose, such as the collision
  // point, and pulls out to the view while the event replays.
  function entrancePose(d) {
    viewVector(d, entranceFrom);
    entranceFrom[K.dist] = Math.log(d.from.dist); entranceFrom[K.polar] = d.from.polar;
    entranceFrom[K.azimuth] = d.from.azimuth; entranceFrom[K.fov] = d.from.fov;
    return entranceFrom;
  }

  function startPullOut() {
    entrancePending = false;
    if (!def.from) return;
    state.set(entrancePose(def));
    startTransition(def, def.pullOut, entranceFrom);
    // A looping view dips to dark and starts again, so that the next replay begins `loop` seconds after this one.
    loopAt = def.loop ? clock() + def.loop - LOOP_DIP / 2 : 0;
  }

  function enterEntrance() {
    // Cut to the entrance pose (the camera would otherwise fly through the detector), then replay
    // the event while pulling out. The cut happens while the old picture is still dark.
    if (still || !def.from) { setState(def); return; }   // paused during the dip: no pull-out, no replay
    state.set(entrancePose(def));
    vel.fill(0);
    tr.active = false;
    entrancePending = true;
    replay();
  }

  let flightToken = 0;
  function setView(name, { instant = false } = {}) {
    if (disposed) return;
    const next = VIEWS[name] ? name : 'home';
    if (next === viewName) return;
    const prev = def;
    viewName = next;
    def = hgcalFailed && HARDWARE.has(next) ? HARDWARE_FALLBACK : VIEWS[next];
    const token = ++flightToken;       // cancels a flight still waiting for the hardware
    if (HARDWARE.has(next)) ensureHGCAL();
    needsRender = true;
    loopAt = 0;

    if (still) {
      // No flying: a quick dip to dark, swap, fade back in.
      if (instant) { setState(def); dip.active = false; fade = 1; return; }
      startDip(0.5, () => setState(def));
      return;
    }
    if (def.from) {
      if (instant) { enterEntrance(); return; }
      startDip(LOOP_DIP, enterEntrance);
      return;
    }
    dip.active = false;                 // (a cut-off dip fades back up in update)
    entrancePending = false;
    if (instant) { setState(def); startClocks(prev, 0.3); return; }
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
    startClocks(prev, tr.dur * 0.8);
  }

  // Arriving from a view that did not show them, the jets are clustered again and the
  // illustration draws itself again, starting as the camera arrives.
  function startClocks(prev, delay) {
    if (def.jets && !prev.jets) {
      // (Never before a replay that is still running has finished.)
      const afterReplay = replayStart >= 0 ? replayStart + REPLAY_END + CLUSTER_START : 0;
      jetStart = Math.max(clock() + delay, afterReplay);
    }
    if (def.toy && !prev.toy) toyStart = clock() + delay;
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
    if (def.jets) jetStart = replayStart + REPLAY_END + CLUSTER_START;   // the jets form once the event is complete
    if (entrancePending) startPullOut();
  }

  // Initial pose: the requested view; a view with an entrance starts at its entrance pose.
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
  if (def.from && !still) {
    state.set(entrancePose(def));
    entrancePending = true;
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
    for (const m of [trackMat, soloMat, electronMat, toyMat]) { m.uniforms.uViewport.value.copy(buf); m.uniforms.uPx.value = ratio; }
    toy.flight.material.size = 14 * ratio;
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

    // A looping view replays its entrance through a short dip to dark.
    if (loopAt && now >= loopAt && !still && !dip.active) {
      loopAt = 0;
      startDip(LOOP_DIP, enterEntrance);
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
      const goal = def.steady ? 0 : (window.scrollY || 0) * 0.00025;
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
    const drop = heroDrop() - (width > WIDE ? 0 : state[K.lift]);
    if (fov !== lastFov || shift !== lastShift || aspect !== lastAspect || near !== lastNear || drop !== lastDrop) {
      if (drop !== lastDrop) needsRender = true;
      lastFov = fov; lastShift = shift; lastAspect = aspect; lastNear = near; lastDrop = drop;
      camera.fov = fov;
      camera.aspect = aspect;
      camera.near = near;
      if (shift > 0.001 || Math.abs(drop) > 0.001) camera.setViewOffset(width, height, -shift * width, -drop * height, width, height);
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

    // Jets: the tracks take their jet's color in the order they were merged, the rest dim, and
    // the cones grow from the vertex.
    const jets = clamp(state[K.jets], 0, 1);
    const jt = jetTime();
    const dim = 1 - (1 - JET_DIM) * smooth(0, CLUSTER_TIME, jt);
    if (jets > 0.003 && jt < CLUSTER_TIME + 1.2) moving = true;
    if (layers.jets) {
      const o = ev * jets * (1 - solo) * loadFade('jets');
      layers.jets.object.visible = o > 0.003;
      for (let i = 0; i < jetCones.length; i++) {
        const c = jetCones[i], u = c.mesh.material.uniforms;
        u.uOpacity.value = o;
        u.uGrow.value = smooth(c.t0, c.t1, jt);
      }
    }

    if (layers.tracks) {
      const u = trackMat.uniforms;
      u.uTime.value = t;
      u.uTint.value = jets;
      u.uTintTime.value = jt;
      u.uDim.value = dim;
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
      u.uOpacity.value = ev * (1 - solo) * (1 + (dim - 1) * jets) * loadFade('electrons');
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

    // The illustrated top-quark jet. Close to the collision point everything slows down, so that
    // the tracks can be seen growing; from far away they grow at the event's own speed.
    const toyA = clamp(state[K.toy], 0, 1) * b;
    toy.group.visible = toyA > 0.003;
    if (toy.group.visible) {
      const tt = toyTime();
      if (tt < TOY.end) moving = true;
      const d0 = Math.exp(state[K.dist]);
      const speed = clamp(d0 * 1.4, 0.06, SPEED);
      const u = toyMat.uniforms;
      u.uTime.value = tt;
      u.uSpeed.value = speed;
      u.uHeadLen.value = 0.16 * speed / SPEED;
      u.uOpacity.value = toyA;
      for (let i = 0; i < toy.cones.length; i++) {
        const c = toy.cones[i], cu = c.mesh.material.uniforms;
        cu.uOpacity.value = toyA * c.strength;
        cu.uGrow.value = smooth(c.t0, c.t1, tt);
      }
      // The two vertices and the b hadron's flight between them only show from close by.
      const near = 1 - smooth(0.3, 2.2, d0);
      const pvDist = camera.position.distanceTo(toy.pvGlow.getWorldPosition(tmp));
      const ps = Math.min(0.55, pvDist * 0.3);
      toy.pvGlow.scale.set(ps, ps, 1);
      toy.pvGlow.material.opacity = toyA * 0.42 * smooth(0.05, 0.5, tt);
      const decayed = tt - TOY.decayAt;
      const ss = pvDist * (0.26 + 0.5 * (decayed > 0 ? Math.exp(-decayed / 0.25) : 0));
      toy.svGlow.scale.set(ss, ss, 1);
      toy.svGlow.material.opacity = decayed > 0 ? toyA * near * (0.7 + 0.3 * Math.exp(-decayed / 0.3)) : 0;
      toy.svGlow.visible = toy.svGlow.material.opacity > 0.003;
      toy.flight.geometry.setDrawRange(0, Math.round(toy.dots * smooth(0.5, TOY.decayAt, tt)));
      toy.flight.material.opacity = toyA * near * 0.9;
      toy.flight.visible = toy.flight.material.opacity > 0.003;
    }

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
      if (tr.active || entrancePending) setState(def);
      pendingReplay = false;
      replayStart = -1;
      entrancePending = false;
      loopAt = 0;
      jetStart = toyStart = -1;        // jets and illustration: complete
    } else if (def.loop && !dip.active) {
      startDip(LOOP_DIP, enterEntrance);   // a looping view starts over when the scene resumes
    }
    needsRender = true;
    start();
  }

  return { setView, replay, setPaused, dispose };
}
