// Helpers shared by the 3D scene (scene.js) and the objects it loads on demand (hgcal.js,
// cassette.js, transformer.js, physics.js): math, merged-geometry building, solids of revolution,
// shader patching, fades and canvas textures. Plain ES module, three.js r161.
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const clamp01 = x => clamp(x, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const ease = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

// Small deterministic PRNG, so that everything random looks the same on every visit.
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function gauss(random) {
  let u = 0;
  while (u < 1e-9) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * random());
}

// --- merged geometry ---------------------------------------------------------------------------
// Accumulates vertices with any set of attributes. set(name, value) fixes an attribute for the
// vertices that follow; vertex(p, n, uv) adds one and returns its index.
export class GeoBuilder {
  constructor(sizes = {}) {
    this.sizes = { position: 3, normal: 3, uv: 2, ...sizes };
    this.data = {};
    this.cur = {};
    for (const [k, n] of Object.entries(this.sizes)) { this.data[k] = []; this.cur[k] = new Array(n).fill(0); }
    this.index = [];
    this.count = 0;
  }
  set(name, value) { this.cur[name] = Array.isArray(value) ? value : [value]; return this; }
  vertex(p, n = [0, 0, 1], uv = [0, 0]) {
    const d = this.data;
    d.position.push(p[0], p[1], p[2]);
    d.normal.push(n[0], n[1], n[2]);
    d.uv.push(uv[0], uv[1]);
    for (const k in this.sizes) {
      if (k === 'position' || k === 'normal' || k === 'uv') continue;
      const v = this.cur[k];
      for (let i = 0; i < this.sizes[k]; i++) d[k].push(v[i] ?? 0);
    }
    return this.count++;
  }
  tri(a, b, c) { this.index.push(a, b, c); }
  quad(a, b, c, d) { this.index.push(a, b, c, a, c, d); }
  build() {
    const g = new THREE.BufferGeometry();
    for (const [k, n] of Object.entries(this.sizes)) g.setAttribute(k, new THREE.Float32BufferAttribute(this.data[k], n));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// A solid annular sector about the z axis: r in [r0, r1], z in [z0, z1], phi in [p0, p1], with a
// front face (z0, normal -z), a back face, outer and inner walls, and two end walls when the
// sector is not a full ring.
export function sectorSolid(b, { r0, r1, z0, z1, p0 = 0, p1 = TAU, segs = 96, uv = [0.5, 0.5] }) {
  const full = Math.abs(p1 - p0 - TAU) < 1e-6;
  const ang = i => p0 + ((p1 - p0) * i) / segs;
  const P = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];
  for (let i = 0; i < segs; i++) {
    const a0 = ang(i), a1 = ang(i + 1);
    let v = [P(r0, a0, z0), P(r1, a0, z0), P(r1, a1, z0), P(r0, a1, z0)].map(p => b.vertex(p, [0, 0, -1], uv));
    b.quad(v[0], v[3], v[2], v[1]);
    v = [P(r0, a0, z1), P(r1, a0, z1), P(r1, a1, z1), P(r0, a1, z1)].map(p => b.vertex(p, [0, 0, 1], uv));
    b.quad(v[0], v[1], v[2], v[3]);
    for (const [r, s] of [[r1, 1], [r0, -1]]) {
      const n0 = [s * Math.cos(a0), s * Math.sin(a0), 0], n1 = [s * Math.cos(a1), s * Math.sin(a1), 0];
      const w0 = b.vertex(P(r, a0, z0), n0, uv), w1 = b.vertex(P(r, a1, z0), n1, uv);
      const w2 = b.vertex(P(r, a1, z1), n1, uv), w3 = b.vertex(P(r, a0, z1), n0, uv);
      if (s > 0) b.quad(w0, w1, w2, w3); else b.quad(w0, w3, w2, w1);
    }
  }
  if (full) return;
  for (const [a, s] of [[p0, -1], [p1, 1]]) {
    const n = [-Math.sin(a) * s, Math.cos(a) * s, 0];
    const v0 = b.vertex(P(r0, a, z0), n, uv), v1 = b.vertex(P(r1, a, z0), n, uv);
    const v2 = b.vertex(P(r1, a, z1), n, uv), v3 = b.vertex(P(r0, a, z1), n, uv);
    if (s > 0) b.quad(v0, v3, v2, v1); else b.quad(v0, v1, v2, v3);
  }
}

// --- shader patching -----------------------------------------------------------------------------
// Adds code to a built-in material: vhead and fhead (declarations), project (replaces
// project_vertex; must define mvPosition and gl_Position), vbegin (after begin_vertex), fstart
// (start of the fragment main), fcolor (after color_fragment), femissive (after
// emissivemap_fragment).
export function patch(material, key, { uniforms = {}, vhead = '', project = null, vbegin = '', fhead = '', fstart = '', fcolor = '', femissive = '' }) {
  material.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${vhead}`);
    if (project) sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', project);
    if (vbegin) sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${vbegin}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${fhead}`);
    if (fstart) sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${fstart}`);
    if (fcolor) sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${fcolor}`);
    if (femissive) sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${femissive}`);
  };
  material.customProgramCacheKey = () => `${key}|${JSON.stringify(material.defines || {})}`;
  return material;
}

// Screen-door transparency: a fragment survives if its noise value is below alpha. It needs no
// sorting and keeps depth writes, so solid objects can fade in and out without showing their
// insides. The noise is interleaved gradient noise.
export const DITHER_GLSL = /* glsl */`
  float ditherIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`;

// Makes every built-in material under `group` fade with one shared uniform: returns
// { group, set(f) }. Materials that carry their own patch are left alone (they fade themselves).
export function dithered(group, key = 'fade') {
  const uniform = { value: 1 };
  const seen = new Set();
  group.traverse(o => {
    for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      if (seen.has(m) || m.isShaderMaterial || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) continue;
      seen.add(m);
      patch(m, `${key}-dither`, {
        uniforms: { uFadeA: uniform },
        fhead: `uniform float uFadeA;\n${DITHER_GLSL}`,
        fstart: 'if (uFadeA < 0.999 && ditherIGN(gl_FragCoord.xy) >= uFadeA) discard;',
      });
    }
  });
  let last = -1;
  return {
    group,
    uniform,
    set(f) {
      if (Math.abs(f - last) < 1e-3) return;
      last = f;
      uniform.value = f;
      group.visible = f > 0.004;
    },
  };
}

// Opacity control for objects whose materials are built elsewhere and blend well (the single
// module): opaque materials become transparent only while partly faded, and then stop writing
// depth, so that a half-faded object never hides what is behind it.
export function fadeable(group) {
  const mats = new Set();
  group.traverse(o => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => mats.add(x)); });
  return { group, f: -1, mats: [...mats].map(m => ({ m, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite })) };
}
export function setTransparent(entry, on) {
  for (let i = 0; i < entry.mats.length; i++) {
    const r = entry.mats[i];
    const t = r.transparent || on;
    if (t !== r.m.transparent) { r.m.transparent = t; r.m.needsUpdate = true; }
    r.m.depthWrite = r.depthWrite && !on;
  }
}
export function setFade(entry, f) {
  if (!entry || Math.abs(f - entry.f) < 1e-3) return;
  entry.f = f;
  entry.group.visible = f > 0.003;
  for (let i = 0; i < entry.mats.length; i++) entry.mats[i].m.opacity = entry.mats[i].opacity * f;
  setTransparent(entry, f < 0.995);
}

// Canvas helper for procedural textures.
export function canvasTex(w, h, draw, { srgb = true, repeat = false, anisotropy = 8, mipmaps = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = mipmaps;
  t.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  return t;
}

// Releases the geometries, materials and textures under an object.
export function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      for (const k of ['map', 'emissiveMap', 'alphaMap']) if (m[k]) m[k].dispose();
      m.dispose();
    }
  });
}

// --- glowing lines -------------------------------------------------------------------------------
// Screen-space lines with a soft glow, for the illustrations (additive, a fixed width in pixels).
// Each segment is one instanced quad from iA to iB. iColor: rgb and strength. iTime: (start, dur,
// t0, t1): the stroke the segment belongs to draws itself from t = 0 to 1 over `dur` seconds from
// `start` (on the material's clock, uTime), and the segment covers t0..t1 of it. A segment is
// brightest as it is drawn and then settles to uRest of that; with uLoop > 0 it brightens again
// every uLoop seconds. uFlat (0..1) replaces the brightening by a constant (for still pictures).
const LINE_VERT = /* glsl */`
  attribute vec3 iA;
  attribute vec3 iB;
  attribute vec4 iColor;
  attribute vec4 iTime;
  uniform vec2 uViewport;
  uniform float uWidth;
  varying float vY;
  varying float vT;
  varying vec4 vColor;
  varying vec2 vWhen;
  void main() {
    vec4 a = projectionMatrix * modelViewMatrix * vec4(iA, 1.0);
    vec4 b = projectionMatrix * modelViewMatrix * vec4(iB, 1.0);
    vec2 d = (b.xy / b.w - a.xy / a.w) * uViewport;
    float len = length(d);
    vec2 n = len > 1e-4 ? vec2(-d.y, d.x) / len : vec2(0.0, 1.0);
    vec4 p = mix(a, b, position.x);
    p.xy += n * position.y * uWidth * 2.0 / uViewport * p.w;
    gl_Position = p;
    vY = position.y;
    vT = mix(iTime.z, iTime.w, position.x);
    vColor = iColor;
    vWhen = iTime.xy;
  }`;
const LINE_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uWidth;
  uniform float uCore;
  uniform float uRest;
  uniform float uLoop;
  uniform float uFlat;
  uniform float uOpacity;
  varying float vY;
  varying float vT;
  varying vec4 vColor;
  varying vec2 vWhen;
  void main() {
    float g = clamp((uTime - vWhen.x) / max(vWhen.y, 1e-3), 0.0, 1.0);
    if (vT > g) discard;
    float age = max(uTime - vWhen.x - vWhen.y * vT, 0.0);
    if (uLoop > 0.0) age = mod(age, uLoop);
    float lit = mix(uRest + (1.0 - uRest) * exp(-age * 1.8), uRest + (1.0 - uRest) * 0.35, uFlat);
    float y = abs(vY) * uWidth;
    float shape = smoothstep(uCore + 0.6, uCore - 0.6, y) + 0.45 * exp(-y * y / (0.18 * uWidth * uWidth));
    float alpha = min(shape, 1.0) * vColor.a * lit * uOpacity;
    gl_FragColor = vec4(vColor.rgb, alpha);
    #include <colorspace_fragment>
  }`;
// segments: [{ a, b, color: [r, g, b], alpha = 1, start = 0, dur = 0, t0 = 0, t1 = 1 }]. Returns
// { mesh, uniforms, start, end, color, update() }: the arrays can be rewritten (then call update).
export function glowLines(segments, { width = 5, core = 0.8, rest = 1, loop = 0, capacity = segments.length, depthTest = false } = {}) {
  const n = capacity;
  const start = new Float32Array(n * 3), end = new Float32Array(n * 3), color = new Float32Array(n * 4), time = new Float32Array(n * 4);
  segments.forEach((s, i) => {
    start.set(s.a, i * 3); end.set(s.b, i * 3);
    color.set([s.color[0], s.color[1], s.color[2], s.alpha ?? 1], i * 4);
    time.set([s.start ?? 0, s.dur ?? 0, s.t0 ?? 0, s.t1 ?? 1], i * 4);
  });
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
  const attr = { iA: new THREE.InstancedBufferAttribute(start, 3), iB: new THREE.InstancedBufferAttribute(end, 3),
    iColor: new THREE.InstancedBufferAttribute(color, 4), iTime: new THREE.InstancedBufferAttribute(time, 4) };
  for (const k in attr) g.setAttribute(k, attr[k]);
  g.instanceCount = segments.length;
  const uniforms = {
    uTime: { value: 0 }, uViewport: { value: new THREE.Vector2(1, 1) }, uWidth: { value: width }, uCore: { value: core },
    uRest: { value: rest }, uLoop: { value: loop }, uFlat: { value: 0 }, uOpacity: { value: 1 },
  };
  const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, uniforms, transparent: true, depthWrite: false, depthTest,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  mesh.frustumCulled = false;
  return {
    mesh, uniforms, start, end, color, time, width, core,
    setCount(k) { g.instanceCount = k; },
    update(...names) { for (const k of names.length ? names : ['iA', 'iB']) attr[k].needsUpdate = true; },
    // drawing-buffer size and pixel ratio: widths are given in CSS pixels
    resize(vp, px) { uniforms.uViewport.value.copy(vp); uniforms.uWidth.value = width * px; uniforms.uCore.value = core * px; },
  };
}
// A polyline as glowing segments: pts is [[x, y, z], ...]; the stroke draws itself along its length.
export function strokeSegments(pts, { color, alpha = 1, start = 0, dur = 0 }) {
  const out = [], len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const total = len[len.length - 1] || 1;
  for (let i = 1; i < pts.length; i++) out.push({ a: pts[i - 1], b: pts[i], color, alpha, start, dur, t0: len[i - 1] / total, t1: len[i] / total });
  return out;
}

// --- soft points ---------------------------------------------------------------------------------
// Round additive dots. Attributes: position, color (rgb), aSize (pixels at uScale = 1), aWhen (the
// time, on uTime, at which the dot lights up; before it shows at uDim of its brightness).
const DOT_VERT = /* glsl */`
  attribute float aSize;
  attribute float aWhen;
  uniform float uPx;
  uniform float uTime;
  uniform float uDim;
  uniform float uLoop;
  uniform float uFlat;
  varying vec3 vColor;
  varying float vLit;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float age = uTime - aWhen;
    float on = smoothstep(0.0, 0.25, age);
    float pulse = exp(-(uLoop > 0.0 ? mod(max(age, 0.0), uLoop) : max(age, 0.0)) * 1.6);
    vLit = mix(uDim, 0.7 + 0.3 * mix(pulse, 0.4, uFlat), on);
    gl_PointSize = aSize * uPx * (0.85 + 0.35 * on * mix(pulse, 0.3, uFlat));
    vColor = color;
  }`;
const DOT_FRAG = /* glsl */`
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vLit;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    float a = (smoothstep(0.42, 0.2, r2) + 0.5 * exp(-r2 * 3.2)) * vLit * uOpacity;
    gl_FragColor = vec4(vColor, min(a, 1.0));
    #include <colorspace_fragment>
  }`;
// dots: [{ p, color: [r, g, b], size, when = 0 }] -> { points, uniforms, resize(px) }
export function glowDots(dots, { dim = 0.12, loop = 0 } = {}) {
  const P = [], C = [], S = [], W = [];
  for (const d of dots) { P.push(...d.p); C.push(...d.color); S.push(d.size); W.push(d.when ?? 0); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(S, 1));
  g.setAttribute('aWhen', new THREE.Float32BufferAttribute(W, 1));
  const uniforms = { uPx: { value: 1 }, uTime: { value: 0 }, uDim: { value: dim }, uLoop: { value: loop }, uFlat: { value: 0 }, uOpacity: { value: 1 } };
  const points = new THREE.Points(g, new THREE.ShaderMaterial({
    vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, uniforms, vertexColors: true, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  }));
  points.frustumCulled = false;
  return { points, uniforms, resize(px) { uniforms.uPx.value = px; } };
}

// --- text labels ---------------------------------------------------------------------------------
// A line of text as a sprite, `height` scene units tall. anchor: 'l', 'c' or 'r' (which end of the
// text sits at the sprite's position). The text is redrawn once the page's fonts have loaded.
export function textSprite(text, { height = 0.2, color = '#e9eef6', weight = 600, anchor = 'c', mono = false } = {}) {
  const PX = 64;                                   // canvas pixels per line of text
  const font = `${weight} ${Math.round(PX * 0.62)}px ${mono ? '"JetBrains Mono", ui-monospace, monospace' : 'Inter, system-ui, sans-serif'}`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 1 }));
  sprite.center.set(anchor === 'l' ? 0 : anchor === 'r' ? 1 : 0.5, 0.5);
  const draw = () => {
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    c.width = w; c.height = PX;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 4, PX / 2 + 2);
    tex.needsUpdate = true;
    sprite.scale.set(height * w / PX, height, 1);
  };
  draw();
  if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(draw).catch(() => {});
  sprite.renderOrder = 10;
  return sprite;
}
// Sets a text sprite's height (scene units), keeping its proportions.
export function sizeSprite(sprite, height) {
  sprite.scale.set(sprite.scale.x / sprite.scale.y * height, height, 1);
}
// How much larger than `height` (scene units) a label `distance` from the camera has to be drawn
// to stand at least `minPx` CSS pixels tall (on small screens, where the camera pulls back).
export function labelBoost(camera, renderer, distance, height, minPx) {
  const cssHeight = renderer.domElement.height / renderer.getPixelRatio();
  const px = camera.projectionMatrix.elements[5] * cssHeight * 0.5 / distance * height;
  return clamp(minPx / px, 1, 1.7);
}
