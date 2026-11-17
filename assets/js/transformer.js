// Illustration for the Research page: a transformer classifying a jet. Not a model of any real
// network: it shows the idea. Each particle of the jet becomes a token; in each attention layer
// every token looks at the others (first its neighbours, then the particles of its own core, then
// the three cores as a whole); the tokens are pooled into one, which gives a score to each kind of
// jet. Loaded on demand by scene.js. Plain ES module, three.js r161.
//
// Frame: the jet's collision point at the origin, y along the jet, x across, z toward the viewer.
import * as THREE from 'three';
import { clamp01, smooth, glowLines, glowDots, strokeSegments, textSprite, disposeTree } from './kit.js';

const PLANES = 4;                    // token layers: the embedding and the output of each of 3 attention layers
const Y0 = 2.0, DY = 0.58;           // height of the first layer above the collision point, and spacing (m)
const HALF = 0.95;                   // half-size of a layer
const Y_CLASS = Y0 + (PLANES - 1) * DY + 0.6;
const Y_BARS = Y_CLASS + 0.42;
const CLASSES = [['top quark', 0.92], ['W boson', 0.06], ['quark or gluon', 0.03]];
const BAR_LEN = 1.15, BAR_H = 0.085, BAR_GAP = 0.25;

// Timeline (s, from the moment the illustration appears). The jet's own tracks are drawn first.
const T_FEED = 2.0, T_ATT = 3.0, STEP = 1.25, T_POOL = T_ATT + 3 * STEP, T_OUT = T_POOL + 0.6, T_END = T_OUT + 0.9;
const LOOP = T_END - T_ATT + 0.4;    // the pulse runs up through the layers again this often

const lin = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const WHITE = lin('#dfe8f5'), FRAME = lin('#4db8ff'), YELLOW = lin('#ffd23f');

// createTransformer({ renderer, tips, clock }) -> { group, update(p, fade, dt, still), dispose() }.
// tips: the ends of the jet's tracks, [{ p: [x, y, z], color: [r, g, b], q: core index, w: weight }].
// clock: the scene's time (s).
export function createTransformer({ renderer, tips, clock = () => performance.now() / 1000 }) {
  const group = new THREE.Group();
  group.name = 'transformer';
  const n = tips.length;

  // Token positions in a layer: the particles as seen along the jet, spread out a little so that
  // no two tokens sit on top of each other.
  const pos = tips.map(t => [t.p[0], t.p[2]]);
  const rMax = Math.max(1e-6, ...pos.map(p => Math.hypot(p[0], p[1])));
  for (const p of pos) { p[0] *= 0.78 * HALF / rMax; p[1] *= 0.78 * HALF / rMax; }
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = pos[j][0] - pos[i][0], dz = pos[j][1] - pos[i][1], d = Math.hypot(dx, dz) || 1e-4, min = 0.16;
      if (d < min) {
        const k = (min - d) / d / 2;
        pos[i][0] -= dx * k; pos[i][1] -= dz * k; pos[j][0] += dx * k; pos[j][1] += dz * k;
      }
    }
  }
  for (const p of pos) { p[0] = Math.max(-0.86 * HALF, Math.min(0.86 * HALF, p[0])); p[1] = Math.max(-0.86 * HALF, Math.min(0.86 * HALF, p[1])); }
  const at = (i, l) => [pos[i][0], Y0 + l * DY, pos[i][1]];
  // The leading particle of each core.
  const cores = [...new Set(tips.map(t => t.q))];
  const leader = {};
  for (const q of cores) leader[q] = tips.map((t, i) => [t.w, i]).filter(([, i]) => tips[i].q === q).sort((a, b) => b[0] - a[0])[0][1];
  const leaders = cores.map(q => leader[q]);

  // --- lines -----------------------------------------------------------------------------------
  const thin = [], bold = [];
  // the layers' frames
  for (let l = 0; l < PLANES; l++) {
    const y = Y0 + l * DY, h = HALF;
    thin.push(...strokeSegments([[-h, y, -h], [h, y, -h], [h, y, h], [-h, y, h], [-h, y, -h]], { color: FRAME, alpha: 0.3, start: 0.2 + 0.15 * l, dur: 0.8 }));
  }
  // from each track to its token
  tips.forEach((t, i) => thin.push(...strokeSegments([t.p, at(i, 0)], { color: t.color, alpha: 0.7, start: T_FEED + 0.02 * i, dur: 0.6 })));
  // attention, layer by layer
  const pair = (l, i, j, color, alpha, into, jitter = 0.25) => into.push(...strokeSegments([at(i, l), at(j, l)], {
    color, alpha, start: T_ATT + l * STEP + jitter * ((i * 7 + j * 13) % 10) / 10, dur: 0.35 }));
  // 1: each token and its two nearest neighbours
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const near = pos.map((p, j) => [Math.hypot(p[0] - pos[i][0], p[1] - pos[i][1]), j]).filter(([, j]) => j !== i).sort((a, b) => a[0] - b[0]).slice(0, 2);
    for (const [, j] of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!seen.has(key)) { seen.add(key); pair(0, i, j, WHITE, 0.3, thin); }
    }
  }
  // 2: the particles of one core
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (tips[i].q === tips[j].q) pair(1, i, j, tips[i].color, 0.3, thin);
  // 3: each particle and its core's leader, and the three leaders together
  for (let i = 0; i < n; i++) if (leader[tips[i].q] !== i) pair(2, i, leader[tips[i].q], tips[i].color, 0.32, thin);
  for (let a = 0; a < leaders.length; a++) for (let b = a + 1; b < leaders.length; b++) pair(2, leaders[a], leaders[b], YELLOW, 0.95, bold, 0);
  // each token carries on to the next layer
  for (let l = 0; l + 1 < PLANES; l++) for (let i = 0; i < n; i++) {
    thin.push(...strokeSegments([at(i, l), at(i, l + 1)], { color: tips[i].color, alpha: 0.4, start: T_ATT + l * STEP + 0.55, dur: 0.4 }));
  }
  // pooling: every token of the last layer into one
  const cls = [0, Y_CLASS, 0];
  for (let i = 0; i < n; i++) {
    const lead = leaders.includes(i);
    (lead ? bold : thin).push(...strokeSegments([at(i, PLANES - 1), cls], { color: lead ? YELLOW : tips[i].color, alpha: lead ? 0.9 : 0.3, start: T_POOL, dur: 0.45 }));
  }
  bold.push(...strokeSegments([cls, [0, Y_BARS - 0.14, 0]], { color: YELLOW, alpha: 0.9, start: T_POOL + 0.45, dur: 0.2 }));
  const lines = [glowLines(thin, { width: 3.6, core: 0.55, rest: 0.42, loop: LOOP }), glowLines(bold, { width: 5.5, core: 1.0, rest: 0.6, loop: LOOP })];
  for (const l of lines) { l.mesh.renderOrder = 6; group.add(l.mesh); }

  // --- tokens ----------------------------------------------------------------------------------
  const dots = [];
  for (let l = 0; l < PLANES; l++) for (let i = 0; i < n; i++) {
    const lead = leaders.includes(i);
    dots.push({ p: at(i, l), color: tips[i].color, size: l === PLANES - 1 ? (lead ? 15 : 7) : 9.5,
      when: l === 0 ? T_FEED + 0.02 * i + 0.55 : T_ATT + (l - 1) * STEP + 0.95 });
  }
  dots.push({ p: cls, color: YELLOW, size: 22, when: T_POOL + 0.45 });
  const tokens = glowDots(dots, { dim: 0.1, loop: LOOP });
  tokens.points.renderOrder = 7;
  group.add(tokens.points);

  // --- the layers' faint sheets ----------------------------------------------------------------
  const sheetMat = new THREE.MeshBasicMaterial({ color: '#4db8ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const sheetGeo = new THREE.PlaneGeometry(2 * HALF, 2 * HALF).rotateX(-Math.PI / 2);
  for (let l = 0; l < PLANES; l++) {
    const m = new THREE.Mesh(sheetGeo, sheetMat);
    m.position.y = Y0 + l * DY;
    m.renderOrder = 5;
    group.add(m);
  }

  // --- the scores ------------------------------------------------------------------------------
  // (Sprites, so that the bars and their labels face the viewer whatever the camera does.)
  const bars = CLASSES.map(([name, score], k) => {
    const y = Y_BARS + (CLASSES.length - 1 - k) * BAR_GAP;
    const mat = new THREE.SpriteMaterial({ color: k === 0 ? '#ffd23f' : '#8fa3bd', transparent: true, opacity: 0, depthWrite: false, depthTest: false });
    const bar = new THREE.Sprite(mat);
    bar.center.set(0, 0.5);
    bar.position.set(0.06, y, 0);
    bar.scale.set(1e-3, BAR_H, 1);
    bar.renderOrder = 8;
    const label = textSprite(name, { height: 0.24, anchor: 'r', color: k === 0 ? '#ffffff' : '#b9c6d8' });
    label.position.set(-0.04, y, 0);
    label.material.opacity = 0;
    group.add(bar, label);
    return { bar, mat, label, score };
  });

  // --- state -----------------------------------------------------------------------------------
  const vp = new THREE.Vector2();
  let t = 0, t0 = 0, shown = false;
  function update(p, fade, dt, still) {
    const f = clamp01(fade);
    group.visible = f > 0.004;
    if (!group.visible) { shown = false; return 0; }
    if (!shown) { shown = true; t0 = clock(); }   // it plays from the start each time it appears
    t = still ? 1e3 : clock() - t0;
    renderer.getDrawingBufferSize(vp);
    const px = renderer.getPixelRatio() * Math.max(0.75, Math.min(1.4, vp.y / renderer.getPixelRatio() / 900));
    for (const l of lines) {
      l.resize(vp, px);
      l.uniforms.uTime.value = t; l.uniforms.uOpacity.value = f; l.uniforms.uFlat.value = still ? 1 : 0;
    }
    tokens.resize(px);
    tokens.uniforms.uTime.value = t; tokens.uniforms.uOpacity.value = f; tokens.uniforms.uFlat.value = still ? 1 : 0;
    sheetMat.opacity = 0.045 * f * smooth(0.2, 1.4, t);
    const grow = smooth(T_OUT, T_OUT + 0.7, t), named = smooth(T_OUT - 0.3, T_OUT + 0.2, t);
    for (const b of bars) {
      b.bar.scale.x = Math.max(1e-3, BAR_LEN * b.score * grow);
      b.mat.opacity = f * grow;
      b.label.material.opacity = f * named;
    }
    // Drawn at the full rate while it builds up; afterwards the pulses only need the slow rate.
    return still ? 0 : t < T_END + 0.5 ? 2 : 1;
  }

  function dispose() {
    disposeTree(group);
  }

  update({}, 0, 0, true);
  return { group, update, dispose };
}
