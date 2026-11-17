// Illustrations for the Teaching page, one for each of three courses. Textbook physics, not CMS data:
//   wave (PH106, electricity and magnetism): a plane electromagnetic wave travelling upward;
//   top  (PH302, classical mechanics): a heavy symmetric top, integrated from its equations of motion;
//   atom (PH253, modern physics): the electron cloud of a hydrogen atom, sampled from |psi|^2.
// Each is built around the origin with y up and is a few meters tall (the scene's scale), to stand
// on the portrait stage beside the text. Loaded on demand by scene.js. Plain ES module, three.js r161.
import * as THREE from 'three';
import { TAU, clamp, clamp01, lerp, smooth, ease, rng, glowLines, textSprite, sizeSprite, labelBoost, canvasTex, fadeable, setFade, disposeTree } from './kit.js';

const lin = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const WHITE = lin('#dfe8f5'), YELLOW = lin('#ffd23f'), BLUE = lin('#4db8ff');
const now = () => performance.now() / 1000;
// Line widths and point sizes are given in CSS pixels at a 900 px tall window.
function pixels(renderer, vp) {
  renderer.getDrawingBufferSize(vp);
  const ratio = renderer.getPixelRatio();
  return ratio * clamp(vp.y / ratio / 900, 0.75, 1.4);
}
// Glow lines that are simply there (no drawing-on, no pulse).
function steadyLines(segments, opts) {
  const l = glowLines(segments, { rest: 1, ...opts });
  l.uniforms.uTime.value = 1e3;
  l.uniforms.uFlat.value = 1;
  return l;
}
const put = (array, i, x, y, z) => { array[i * 3] = x; array[i * 3 + 1] = y; array[i * 3 + 2] = z; };

// ---------------------------------------------------------------------------------------------
// PH106: a plane electromagnetic wave. It travels along +y; the electric field (yellow) points
// along x and the magnetic field (blue) along -z when E points along +x, so that E x B points the
// way the wave travels. The two fields are in phase.
// ---------------------------------------------------------------------------------------------
export function createWave({ renderer, clock = now }) {
  const group = new THREE.Group();
  group.name = 'wave';
  const HALF = 3.6, LAMBDA = 2.4, AMP = 1.2;     // half-length, wavelength and amplitude as drawn (m)
  const PERIOD = 3.4;                             // s for one wavelength to pass
  const K = TAU / LAMBDA;
  const ARROWS = 37, CURVE = 144;
  const FIELDS = [{ color: YELLOW, hex: '#ffd23f', u: [1, 0, 0], name: 'E' }, { color: BLUE, hex: '#4db8ff', u: [0, 0, -1], name: 'B' }];
  const edge = y => smooth(0, 1.1, HALF - Math.abs(y));      // the wave fades out toward its two ends
  const yArrow = i => -HALF + 2 * HALF * i / (ARROWS - 1), yCurve = j => -HALF + 2 * HALF * j / CURVE;
  const blank = (color, alpha) => ({ a: [0, 0, 0], b: [0, 0, 0], color, alpha });

  // The direction of travel.
  const top = HALF + 0.5;
  const axis = steadyLines([
    { a: [0, -HALF - 0.3, 0], b: [0, top, 0], color: WHITE, alpha: 0.32 },
    { a: [0, top, 0], b: [0.1, top - 0.24, 0], color: WHITE, alpha: 0.5 },
    { a: [0, top, 0], b: [-0.1, top - 0.24, 0], color: WHITE, alpha: 0.5 },
  ], { width: 3, core: 0.5 });
  // The field vectors (a shaft and two barbs each) and the curves through their tips.
  const arrowSegs = [], curveSegs = [];
  for (const f of FIELDS) {
    for (let i = 0; i < ARROWS; i++) for (let k = 0; k < 3; k++) arrowSegs.push(blank(f.color, 0.75 * edge(yArrow(i))));
    for (let j = 0; j < CURVE; j++) curveSegs.push(blank(f.color, 0.95 * edge(yCurve(j + 0.5))));
  }
  const arrows = steadyLines(arrowSegs, { width: 2.8, core: 0.45 });
  const curves = steadyLines(curveSegs, { width: 4.6, core: 0.85 });
  const lines = [axis, arrows, curves];
  for (const l of lines) { l.mesh.renderOrder = 6; group.add(l.mesh); }
  // A faint sheet between the axis and each curve.
  const sheetMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const sheets = FIELDS.map(f => {
    const pos = new Float32Array((CURVE + 1) * 6), col = new Float32Array((CURVE + 1) * 6), index = [];
    for (let j = 0; j <= CURVE; j++) {
      const y = yCurve(j), e = edge(y);
      put(pos, 2 * j, 0, y, 0); put(pos, 2 * j + 1, 0, y, 0);
      put(col, 2 * j, f.color[0] * e, f.color[1] * e, f.color[2] * e); put(col, 2 * j + 1, f.color[0] * e, f.color[1] * e, f.color[2] * e);
      if (j < CURVE) index.push(2 * j, 2 * j + 1, 2 * j + 2, 2 * j + 1, 2 * j + 3, 2 * j + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(index);
    const mesh = new THREE.Mesh(g, sheetMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    group.add(mesh);
    return { pos, attr: g.attributes.position };
  });
  // The fields' names ride on a crest.
  const labels = FIELDS.map(f => {
    const s = textSprite(f.name, { height: 0.46, color: f.hex, weight: 700 });
    group.add(s);
    return s;
  });

  // turns: how many wavelengths have passed.
  function place(turns) {
    const phase = TAU * (turns % 1);
    let s = 0, c = 0;
    FIELDS.forEach((f, fi) => {
      const [ux, , uz] = f.u;
      for (let i = 0; i < ARROWS; i++) {
        const y = yArrow(i), v = AMP * Math.sin(K * y - phase);
        const h = Math.min(0.13, 0.45 * Math.abs(v)) * Math.sign(v), w = 0.42 * Math.abs(h);
        const tx = ux * v, tz = uz * v, bx = ux * (v - h), bz = uz * (v - h);
        put(arrows.start, s, 0, y, 0); put(arrows.end, s++, tx, y, tz);
        put(arrows.start, s, tx, y, tz); put(arrows.end, s++, bx, y + w, bz);
        put(arrows.start, s, tx, y, tz); put(arrows.end, s++, bx, y - w, bz);
      }
      const sheet = sheets[fi];
      let px = 0, py = 0, pz = 0;
      for (let j = 0; j <= CURVE; j++) {
        const y = yCurve(j), v = AMP * Math.sin(K * y - phase), x = ux * v, z = uz * v;
        put(sheet.pos, 2 * j + 1, x, y, z);
        if (j > 0) { put(curves.start, c, px, py, pz); put(curves.end, c++, x, y, z); }
        px = x; py = y; pz = z;
      }
      sheet.attr.needsUpdate = true;
    });
    arrows.update(); curves.update();
    // One crest, followed on its way up through the middle two wavelengths.
    const yc = ((turns + 0.25) * LAMBDA + LAMBDA) % (2 * LAMBDA) - LAMBDA;
    const a = smooth(0, 0.5, LAMBDA - Math.abs(yc));
    FIELDS.forEach((f, fi) => {
      labels[fi].position.set(f.u[0] * (AMP + 0.34), yc, f.u[2] * (AMP + 0.34));
      labels[fi].userData.a = a;
    });
  }

  const vp = new THREE.Vector2();
  function update(p, fade, dt, still) {
    const f = clamp01(fade);
    group.visible = f > 0.004;
    if (!group.visible) return 0;
    place(still ? 0.31 : clock() / PERIOD);
    const px = pixels(renderer, vp);
    for (const l of lines) { l.resize(vp, px); l.uniforms.uOpacity.value = f; }
    sheetMat.opacity = 0.085 * f;
    for (const s of labels) s.material.opacity = f * s.userData.a;
    return still ? 0 : 2;
  }
  update({}, 0, 0, true);
  return { group, update, dispose() { disposeTree(group); } };
}

// ---------------------------------------------------------------------------------------------
// PH302: a heavy symmetric top with its point fixed. Euler angles: th (tilt from the vertical),
// ph (precession about the vertical) and ps (spin about its own axis). The momenta conjugate to
// ph and ps are conserved, which leaves one equation of motion, for th:
//   I1 th'' = I1 ph'^2 sin th cos th - p_ps ph' sin th + M g l sin th,
//   ph' = (p_ph - p_ps cos th) / (I1 sin^2 th),   ps' = p_ps / I3 - ph' cos th.
// The top is let go with its axis at rest, so its axis falls, swings around and comes back up to
// where it started, tracing a curve with cusps between two circles (nutation).
// ---------------------------------------------------------------------------------------------
export function createTop({ renderer }) {
  const group = new THREE.Group();
  group.name = 'top';
  const I1 = 1, I3 = 0.2, MGL = 1;                // units: I1 = M g l = 1
  const TH0 = 0.42, TH1 = 0.62;                   // the two circles the axis moves between (rad)
  // The spin that makes the axis, let go at TH0, turn back at TH1 (from energy conservation).
  const PPS = Math.sqrt(2 * I1 * MGL * Math.sin(TH1) ** 2 / (Math.cos(TH0) - Math.cos(TH1)));
  const PPH = PPS * Math.cos(TH0);
  const SPEED = 1.3;                              // the top's seconds per second on screen
  const H = 1 / 240;                              // integration step (s)
  const LEN = 3.0;                                // from the point to the end of the stem (m)
  const TRAIL = 440, TRAIL_DT = 1 / 30;           // the path of the stem's end: samples kept, and their spacing (s)

  const s = { th: TH0, w: 0, ph: 0, ps: 0 };
  const phDot = th => (PPH - PPS * Math.cos(th)) / (I1 * Math.sin(th) ** 2);
  const thAcc = th => { const pd = phDot(th), sn = Math.sin(th); return pd * pd * sn * Math.cos(th) - (PPS * pd * sn - MGL * sn) / I1; };
  const psDot = th => PPS / I3 - phDot(th) * Math.cos(th);
  function step(h) {                              // one Runge-Kutta (RK4) step
    const a1 = s.w, b1 = thAcc(s.th);
    const t2 = s.th + 0.5 * h * a1, a2 = s.w + 0.5 * h * b1, b2 = thAcc(t2);
    const t3 = s.th + 0.5 * h * a2, a3 = s.w + 0.5 * h * b2, b3 = thAcc(t3);
    const t4 = s.th + h * a3, a4 = s.w + h * b3, b4 = thAcc(t4);
    s.ph += h / 6 * (phDot(s.th) + 2 * phDot(t2) + 2 * phDot(t3) + phDot(t4));
    s.ps += h / 6 * (psDot(s.th) + 2 * psDot(t2) + 2 * psDot(t3) + psDot(t4));
    s.th += h / 6 * (a1 + 2 * a2 + 2 * a3 + a4);
    s.w += h / 6 * (b1 + 2 * b2 + 2 * b3 + b4);
    if (s.ps > 1e4) s.ps -= TAU * Math.floor(s.ps / TAU);
    if (s.ph > 1e4) s.ph -= TAU * Math.floor(s.ph / TAU);
  }
  const tip = () => { const sn = Math.sin(s.th); return [LEN * sn * Math.cos(s.ph), LEN * Math.cos(s.th), LEN * sn * Math.sin(s.ph)]; };

  // --- the top and its stand ---------------------------------------------------------------------
  const solid = new THREE.Group();
  const stripes = canvasTex(512, 64, (ctx, w, h) => {
    // White except for dark wedges on the body (they show the spin); the map multiplies the brass.
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#4a3a22';
    for (let k = 0; k < 4; k++) ctx.fillRect((k + 0.3) * w / 4, h * 0.3, w / 4 * 0.38, h * 0.62);
  }, { repeat: true });
  const profile = [[0, 0], [0.05, 0.1], [0.5, 0.78], [0.96, 1.04], [1.06, 1.2], [0.96, 1.36], [0.34, 1.46], [0.11, 1.62], [0.085, 2.76], [0.15, 2.82], [0.13, 2.95], [0, LEN]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const brass = new THREE.MeshStandardMaterial({ color: '#d2a244', metalness: 1, roughness: 0.3, map: stripes });
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 72), brass);
  const steel = new THREE.MeshStandardMaterial({ color: '#5b6675', metalness: 0.9, roughness: 0.42 });
  const stand = new THREE.Group();
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.13, 2.5, 40), steel); column.position.y = -1.33;
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.09, 0.1, 40), steel); cup.position.y = -0.05;
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.9, 0.12, 64), steel); foot.position.y = -2.64;
  stand.add(column, cup, foot);
  solid.add(body, stand);
  group.add(solid);
  const fade = fadeable(solid);

  // --- guides and the path of the stem's end ---------------------------------------------------
  const guideSegs = [];
  for (const th of [TH0, TH1]) {
    const r = LEN * Math.sin(th), y = LEN * Math.cos(th);
    for (let k = 0; k < 72; k++) {
      const a = TAU * k / 72, b = TAU * (k + 1) / 72;
      guideSegs.push({ a: [r * Math.cos(a), y, r * Math.sin(a)], b: [r * Math.cos(b), y, r * Math.sin(b)], color: WHITE, alpha: 0.28 });
    }
  }
  for (let k = 0; k < 12; k++) guideSegs.push({ a: [0, 0.3 * k, 0], b: [0, 0.3 * k + 0.16, 0], color: WHITE, alpha: 0.22 });   // the vertical, dashed
  const guides = steadyLines(guideSegs, { width: 2.4, core: 0.4, depthTest: true });
  const trail = steadyLines(Array.from({ length: TRAIL }, () => ({ a: [0, 0, 0], b: [0, 0, 0], color: YELLOW, alpha: 0 })), { width: 5.2, core: 1.0, depthTest: true });
  for (const l of [guides, trail]) { l.mesh.renderOrder = 6; group.add(l.mesh); }
  const path = [];                                // the last TRAIL + 1 positions of the stem's end
  function sample() { path.push(tip()); if (path.length > TRAIL + 1) path.shift(); }
  function drawTrail() {
    const n = path.length - 1;
    for (let i = 0; i < n; i++) {
      const a = path[i], b = path[i + 1];
      put(trail.start, i, a[0], a[1], a[2]); put(trail.end, i, b[0], b[1], b[2]);
      trail.color[i * 4 + 3] = Math.pow((i + 1 + TRAIL - n) / TRAIL, 1.4);
    }
    trail.setCount(n);
    trail.update('iA', 'iB', 'iColor');
  }
  let acc = 0, sinceSample = 0;
  function advance(seconds) {
    acc += seconds;
    while (acc >= H) {
      step(H); acc -= H; sinceSample += H;
      if (sinceSample >= TRAIL_DT) { sinceSample -= TRAIL_DT; sample(); }
    }
  }
  sample();
  advance(TRAIL * TRAIL_DT);                      // it has been spinning for a while when it first shows

  const qY = new THREE.Quaternion(), qZ = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  function pose() {
    // The axis at (sin th cos ph, cos th, sin th sin ph); spin and precession turn the same way.
    body.quaternion.setFromAxisAngle(Y, -s.ph).multiply(qZ.setFromAxisAngle(Z, -s.th)).multiply(qY.setFromAxisAngle(Y, -s.ps));
  }

  const vp = new THREE.Vector2();
  function update(p, f0, dt, still) {
    const f = clamp01(f0);
    group.visible = f > 0.004;
    setFade(fade, f);
    if (!group.visible) return 0;
    if (!still) advance(dt * SPEED);
    pose();
    drawTrail();
    const px = pixels(renderer, vp);
    for (const l of [guides, trail]) { l.resize(vp, px); l.uniforms.uOpacity.value = f; }
    return still ? 0 : 2;
  }
  update({}, 0, 0, true);
  return { group, update, dispose() { disposeTree(group); } };
}

// ---------------------------------------------------------------------------------------------
// PH253: the electron cloud of a hydrogen atom. Each dot is a position drawn from |psi_nlm|^2 for
// a state with m = 0 (the symmetry axis is y); its color is the sign of psi there. The cloud
// passes from one state to the next: every dot keeps its rank in radius and in polar angle (and
// its azimuth), so the cloud flows without its dots crossing. Each state is drawn at its own
// scale, shown by a scale bar (the Bohr radius is 0.0529 nm).
// ---------------------------------------------------------------------------------------------
const STATES = [[2, 1, '2p'], [3, 1, '3p'], [3, 2, '3d'], [4, 2, '4d'], [4, 3, '4f']];
const STILL_STATE = 2;
// Radial function R_nl(r), r in Bohr radii, and the Legendre polynomial P_l(c) (neither normalized).
function radial(n, l, r) {
  const x = 2 * r / n, k = n - l - 1, al = 2 * l + 1;
  let L0 = 1, L1 = 1 + al - x;
  if (k === 0) L1 = 1;
  for (let j = 1; j < k; j++) { const L2 = ((2 * j + 1 + al - x) * L1 - (j + al) * L0) / (j + 1); L0 = L1; L1 = L2; }
  return Math.pow(x, l) * Math.exp(-x / 2) * L1;
}
function legendre(l, c) {
  let P0 = 1, P1 = c;
  if (l === 0) return 1;
  for (let j = 1; j < l; j++) { const P2 = ((2 * j + 1) * c * P1 - j * P0) / (j + 1); P0 = P1; P1 = P2; }
  return P1;
}
// The inverse of the cumulative distribution of density(x) on [a, b]: u in [0, 1] -> x.
function quantiles(density, a, b, bins) {
  const cdf = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) cdf[i + 1] = cdf[i] + density(a + (b - a) * (i + 0.5) / bins);
  const total = cdf[bins];
  return u => {
    const target = u * total;
    let lo = 0, hi = bins;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cdf[mid] <= target) lo = mid; else hi = mid; }
    const span = cdf[lo + 1] - cdf[lo];
    return a + (b - a) * (lo + (span > 0 ? (target - cdf[lo]) / span : 0.5)) / bins;
  };
}

const ATOM_VERT = /* glsl */`
  attribute vec3 aFrom;      // radius (m), polar angle, sign of psi: the state the cloud leaves
  attribute vec3 aTo;        // the same for the state it goes to
  attribute vec2 aDot;       // azimuth, and a random number
  uniform float uMix;
  uniform float uPx;
  uniform float uSize;
  uniform vec3 uPlus;
  uniform vec3 uMinus;
  varying vec3 vColor;
  void main() {
    float m = clamp(uMix * 1.35 - 0.35 * aDot.y, 0.0, 1.0);     // the dots do not all leave at once
    m = m * m * (3.0 - 2.0 * m);
    float r = mix(aFrom.x, aTo.x, m), th = mix(aFrom.y, aTo.y, m), sn = sin(th);
    vec4 mv = modelViewMatrix * vec4(r * sn * cos(aDot.x), r * cos(th), r * sn * sin(aDot.x), 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPx * (0.75 + 0.5 * aDot.y);
    vColor = mix(uMinus, uPlus, 0.5 + 0.5 * mix(aFrom.z, aTo.z, m));
  }`;
const ATOM_FRAG = /* glsl */`
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColor, (1.0 - r2) * (1.0 - r2) * uOpacity);
    #include <colorspace_fragment>
  }`;

export function createAtom({ renderer, camera, clock = now }) {
  const group = new THREE.Group();
  group.name = 'atom';
  const DOTS = 22000;
  const RADIUS = 2.7;                 // m on screen for the radius that holds 95% of the cloud
  const HOLD = 4.4, MORPH = 2.6;      // s a state is shown, and the passage to the next
  const HALF_NM = 0.5 / 0.0529177;    // half a nanometer, in Bohr radii

  // The same random numbers serve every state: a dot keeps its rank in r and in cos(theta).
  const random = rng(253);
  const uR = new Float32Array(DOTS), uC = new Float32Array(DOTS), dot = new Float32Array(DOTS * 2);
  for (let i = 0; i < DOTS; i++) { uR[i] = random(); uC[i] = random(); dot[2 * i] = random() * TAU; dot[2 * i + 1] = random(); }
  const states = STATES.map(([n, l, name]) => {
    const rMax = 3.2 * n * n + 10;
    const qR = quantiles(r => { const R = radial(n, l, r); return r * r * R * R; }, 0, rMax, 4096);
    const qC = quantiles(c => { const P = legendre(l, c); return P * P; }, -1, 1, 2048);
    const scale = RADIUS / qR(0.95);
    const data = new Float32Array(DOTS * 3);
    for (let i = 0; i < DOTS; i++) {
      const r = qR(uR[i]), c = qC(uC[i]);
      data[3 * i] = r * scale; data[3 * i + 1] = Math.acos(clamp(c, -1, 1));
      data[3 * i + 2] = radial(n, l, r) * legendre(l, c) >= 0 ? 1 : -1;
    }
    const label = textSprite(`${name}:  n = ${n},  ℓ = ${l},  m = 0`, { height: 0.34, color: '#e9eef6', weight: 500 });
    label.position.set(0, -4.35, 0);
    label.material.opacity = 0;
    group.add(label);
    return { data, bar: HALF_NM * scale, label };
  });

  const geometry = new THREE.BufferGeometry();
  const from = new THREE.BufferAttribute(new Float32Array(DOTS * 3), 3), to = new THREE.BufferAttribute(new Float32Array(DOTS * 3), 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DOTS * 3), 3));   // unused: the shader places the dots
  geometry.setAttribute('aFrom', from);
  geometry.setAttribute('aTo', to);
  geometry.setAttribute('aDot', new THREE.BufferAttribute(dot, 2));
  const uniforms = {
    uMix: { value: 0 }, uPx: { value: 1 }, uSize: { value: 3.4 }, uOpacity: { value: 0 },
    uPlus: { value: new THREE.Color('#5ad1ff') }, uMinus: { value: new THREE.Color('#ffa64d') },
  };
  const cloud = new THREE.Points(geometry, new THREE.ShaderMaterial({
    vertexShader: ATOM_VERT, fragmentShader: ATOM_FRAG, uniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  }));
  cloud.frustumCulled = false;
  cloud.renderOrder = 6;
  group.add(cloud);

  // The scale bar and its label.
  const BAR_Y = -4.95;
  const bar = steadyLines([0, 1, 2].map(() => ({ a: [0, 0, 0], b: [0, 0, 0], color: WHITE, alpha: 0.75 })), { width: 3, core: 0.55 });
  bar.mesh.renderOrder = 6;
  const barLabel = textSprite('0.5 nm', { height: 0.3, color: '#b9c6d8', weight: 500 });
  barLabel.position.set(0, BAR_Y - 0.36, 0);
  group.add(bar.mesh, barLabel);
  // The bar lies across the line of sight, so that its length on screen is true.
  const across = new THREE.Vector3(1, 0, 0);
  function setBar(len) {
    if (camera) { across.setFromMatrixColumn(camera.matrixWorld, 0).setY(0); if (across.lengthSq() > 1e-6) across.normalize(); else across.set(1, 0, 0); }
    const x = across.x * len / 2, z = across.z * len / 2;
    put(bar.start, 0, -x, BAR_Y, -z); put(bar.end, 0, x, BAR_Y, z);
    put(bar.start, 1, -x, BAR_Y - 0.09, -z); put(bar.end, 1, -x, BAR_Y + 0.09, -z);
    put(bar.start, 2, x, BAR_Y - 0.09, z); put(bar.end, 2, x, BAR_Y + 0.09, z);
    bar.update();
  }

  let loaded = -1;                    // the state in aFrom (aTo holds the next one)
  function load(k) {
    if (k === loaded) return;
    loaded = k;
    from.array.set(states[k].data); to.array.set(states[(k + 1) % states.length].data);
    from.needsUpdate = to.needsUpdate = true;
  }

  const vp = new THREE.Vector2();
  let t0 = 0, shown = false;
  function update(p, fade, dt, still) {
    const f = clamp01(fade);
    group.visible = f > 0.004;
    if (!group.visible) { shown = false; return 0; }
    if (!shown) { shown = true; t0 = clock(); }             // it starts from the first state each time it appears
    const t = still ? 0 : clock() - t0, cycle = HOLD + MORPH;
    const k = still ? STILL_STATE : Math.floor(t / cycle) % states.length;
    const m = still ? 0 : clamp01((t % cycle - HOLD) / MORPH);
    load(k);
    const a = states[k], b = states[(k + 1) % states.length];
    uniforms.uMix.value = m;
    uniforms.uPx.value = pixels(renderer, vp);
    uniforms.uOpacity.value = 0.5 * f;
    cloud.rotation.y = still ? 0.4 : 0.11 * t;
    const big = camera ? labelBoost(camera, renderer, camera.position.length(), 0.34, 21) : 1;      // legible on phones
    for (const s of states) { s.label.material.opacity = 0; sizeSprite(s.label, 0.34 * big); }
    sizeSprite(barLabel, 0.3 * big);
    a.label.material.opacity = f * (1 - smooth(0.05, 0.4, m));
    b.label.material.opacity = Math.max(b.label.material.opacity, f * smooth(0.6, 0.95, m));
    setBar(lerp(a.bar, b.bar, ease(m)));
    bar.resize(vp, uniforms.uPx.value);
    bar.uniforms.uOpacity.value = f;
    barLabel.material.opacity = f;
    return still ? 0 : m > 0 ? 2 : 1;
  }
  update({}, 0, 0, true);
  return { group, update, dispose() { disposeTree(group); } };
}
