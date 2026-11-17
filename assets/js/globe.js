// The globe on the CV page: the places of the CV on a dotted-land globe, joined in the order of
// the career. The land and the borders are Natural Earth data (geo-data.js); the routes between
// places are schematic. Loaded on demand by scene.js. Plain ES module, three.js r161.
//
// The globe is centered on the origin with y as its polar axis; (lat, lon) sits at
// r (cos lat sin lon, sin lat, cos lat cos lon), so a camera at polar angle 90 deg - lat and
// azimuth lon looks straight down at that point.
import * as THREE from 'three';
import { clamp01, smooth, glowLines, strokeSegments, textSprite, sizeSprite, labelBoost, disposeTree } from './kit.js';
import { LAND, BORDERS } from './geo-data.js';

const D2R = Math.PI / 180;
const R = 3;                        // the globe's radius in the scene (m)
const ll = (lat, lon, r = R, out = new THREE.Vector3()) =>
  out.set(r * Math.cos(lat * D2R) * Math.sin(lon * D2R), r * Math.sin(lat * D2R), r * Math.cos(lat * D2R) * Math.cos(lon * D2R));
const lin = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const COLOR = { study: '#4db8ff', work: '#ffd23f', land: '#53647f', border: '#41536f', deep: '#0b1424', rim: '#3f7fd9' };

// The places of the CV: where it is, what its label says, which kind it is, and when it appears
// (s after the globe does). side and rise place the label: to the left ('l') or right ('r') of the
// place or centered on it ('c'), and this many meters above it.
export const CAREER = {
  sites: {
    turin: { lat: 45.0703, lon: 7.6869, name: 'Turin', note: '2006–2012', kind: 'study', at: 0.4, side: 'r', rise: -0.3 },
    helsinki: { lat: 60.1699, lon: 24.9384, name: 'Helsinki', note: 'exchange', kind: 'study', at: 1.7, side: 'r', rise: 0.12 },
    hamburg: { lat: 53.5753, lon: 9.8795, name: 'Hamburg', note: '2013–2017', kind: 'study', at: 3.1, side: 'l', rise: 0.4 },
    providence: { lat: 41.8268, lon: -71.4025, name: 'Providence', note: '2018–2022', kind: 'work', at: 5.1, side: 'r', rise: -0.3 },
    tuscaloosa: { lat: 33.2098, lon: -87.5692, name: 'Tuscaloosa', note: 'since 2022', kind: 'work', at: 6.7, side: 'c', rise: -0.6 },
  },
  // [from, to, start (s), seconds to draw, kind, strength]
  routes: [
    ['turin', 'helsinki', 0.8, 1.0, 'study', 0.55],
    ['turin', 'hamburg', 2.1, 1.1, 'study', 1],
    ['hamburg', 'providence', 3.6, 1.6, 'work', 1],
    ['providence', 'tuscaloosa', 5.6, 1.2, 'work', 1],
  ],
};
const LOOP = 9;                     // the routes brighten again this often (s)
const NAME_H = 0.3, NOTE_H = 0.235; // height of a label's two lines (m)
const ANCHOR = { l: 'r', r: 'l', c: 'c' };      // which end of a label's text sits at its place
const SIDE = { l: -1, r: 1, c: 0 };

// --- decoding the map data -------------------------------------------------------------------------
function b64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function polylines(s) {
  const a = new Int16Array(b64(s).buffer), lines = [];
  let cur = [];
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === 32767) { if (cur.length > 1) lines.push(cur); cur = []; continue; }
    cur.push([a[i] / 100, a[i + 1] / 100]);
  }
  return lines;
}
function landAt(bits, lat, lon) {
  const i = Math.min(LAND.w - 1, Math.floor(((lon + 180) / 360) * LAND.w)), j = Math.min(LAND.h - 1, Math.floor(((90 - lat) / 180) * LAND.h));
  const k = j * LAND.w + i;
  return (bits[k >> 3] >> (k & 7)) & 1;
}

// --- shaders ---------------------------------------------------------------------------------------
const DOT_VERT = /* glsl */`
  attribute float aB;
  uniform float uSize;       // the dots' diameter (m)
  uniform float uScale;      // drawing-buffer pixels per meter at a distance of 1 m
  uniform float uMaxPx;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelViewMatrix) * position);
    vA = smoothstep(0.02, 0.3, dot(n, normalize(-mv.xyz))) * aB;      // dim toward the limb
    gl_PointSize = clamp(uSize * uScale / -mv.z, 1.0, uMaxPx);
    gl_Position = projectionMatrix * mv;
  }`;
const DOT_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vA;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(uColor, vA * uOpacity * (1.0 - smoothstep(0.5, 1.0, r2)));
    #include <colorspace_fragment>
  }`;
const OCEAN_VERT = /* glsl */`
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const OCEAN_FRAG = /* glsl */`
  uniform vec3 uDeep;
  uniform vec3 uRim;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float f = 1.0 - max(dot(vN, vV), 0.0);
    float sun = max(dot(vN, normalize(vec3(-0.5, 0.65, 0.55))), 0.0);
    gl_FragColor = vec4(uDeep * (0.6 + 0.4 * sun) + uRim * pow(f, 3.0) * 0.9, uOpacity);
    #include <colorspace_fragment>
  }`;
const HALO_FRAG = /* glsl */`
  uniform vec3 uRim;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float d = max(-dot(vN, vV), 0.0);          // back faces: 0 at the halo's outer edge
    gl_FragColor = vec4(uRim, pow(smoothstep(0.0, 0.62, d), 2.2) * 0.55 * uOpacity);
    #include <colorspace_fragment>
  }`;

// createGlobe({ renderer, camera, clock }, data) -> { group, update(p, fade, dt, still), dispose() }
export function createGlobe({ renderer, camera, clock = () => performance.now() / 1000 }, data = CAREER) {
  const group = new THREE.Group();           // placed by the scene
  group.name = 'globe';
  const globe = new THREE.Group();           // sways a little
  group.add(globe);

  // Ocean and atmosphere. The ocean writes depth, so whatever is on the far side stays hidden.
  const sea = { uDeep: { value: new THREE.Color(COLOR.deep) }, uRim: { value: new THREE.Color(COLOR.rim) }, uOpacity: { value: 0 } };
  const ocean = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), new THREE.ShaderMaterial({ vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG, uniforms: sea, transparent: true }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.09, 72, 48), new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERT, fragmentShader: HALO_FRAG, uniforms: sea, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  }));
  halo.renderOrder = 0; ocean.renderOrder = 1;
  globe.add(halo, ocean);

  // Land: dots on an equal-area grid.
  const STEP = 0.8;                          // degrees between rows
  const dotU = { uSize: { value: 0.0083 * R }, uScale: { value: 500 }, uMaxPx: { value: 9 }, uColor: { value: new THREE.Color(COLOR.land) }, uOpacity: { value: 0 } };
  {
    const bits = b64(LAND.bits), P = [], B = [], v = new THREE.Vector3();
    for (let lat = -90 + STEP / 2; lat < 90; lat += STEP) {
      const n = Math.max(1, Math.round((360 / STEP) * Math.cos(lat * D2R)));
      for (let i = 0; i < n; i++) {
        const lon = -180 + ((i + 0.5) * 360) / n;
        if (!landAt(bits, lat, lon)) continue;
        ll(lat, lon, R * 1.0015, v);
        P.push(v.x, v.y, v.z);
        B.push(0.7 + 0.3 * Math.abs(Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453 % 1));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(B, 1));
    const land = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, uniforms: dotU, transparent: true, depthWrite: false }));
    land.renderOrder = 3;
    globe.add(land);
  }
  // Country borders.
  const borderMat = new THREE.LineBasicMaterial({ color: COLOR.border, transparent: true, opacity: 0, depthWrite: false });
  {
    const P = [], a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const line of polylines(BORDERS)) for (let i = 0; i + 1 < line.length; i++) {
      ll(line[i][1], line[i][0], R * 1.0012, a); ll(line[i + 1][1], line[i + 1][0], R * 1.0012, b);
      P.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const borders = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(P, 3)), borderMat);
    borders.renderOrder = 2;
    globe.add(borders);
  }

  // Routes: great-circle arcs lifted off the surface, each drawing itself from its start.
  const segs = [];
  {
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), p = new THREE.Vector3(), N = 64;
    for (const [from, to, start, dur, kind, strength] of data.routes) {
      const a = data.sites[from], b = data.sites[to];
      ll(a.lat, a.lon, 1, pa); ll(b.lat, b.lon, 1, pb);
      const w = pa.angleTo(pb), lift = 0.03 + 0.2 * (w / Math.PI), pts = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        p.copy(pa).multiplyScalar(Math.sin((1 - t) * w)).addScaledVector(pb, Math.sin(t * w)).divideScalar(Math.sin(w));
        pts.push(p.multiplyScalar(R * (1.003 + lift * Math.sin(Math.PI * t))).toArray());
      }
      segs.push(...strokeSegments(pts, { color: lin(COLOR[kind]), alpha: strength, start, dur }));
    }
  }
  const routes = glowLines(segs, { width: 4.6, core: 0.9, rest: 0.62, loop: LOOP, depthTest: true });
  routes.mesh.renderOrder = 4;
  globe.add(routes.mesh);

  // Places: a dot and a pulsing ring, kept a constant size on screen, and a two-line label.
  const ringGeo = new THREE.RingGeometry(0.72, 1, 48), discGeo = new THREE.CircleGeometry(0.42, 32);
  const sites = Object.values(data.sites).map(s => {
    const g = new THREE.Group();
    ll(s.lat, s.lon, R * 1.0022, g.position);
    g.lookAt(ll(s.lat, s.lon, R * 2));
    const mk = geo => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLOR[s.kind], transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    const disc = mk(discGeo), ring = mk(ringGeo);
    disc.renderOrder = ring.renderOrder = 5;
    g.add(disc, ring);
    const name = textSprite(s.name, { height: NAME_H, color: '#f2f5fa', weight: 600, anchor: ANCHOR[s.side] });
    const note = textSprite(s.note, { height: NOTE_H, color: '#aeb9cb', weight: 500, anchor: ANCHOR[s.side] });
    name.center.y = 0.05; note.center.y = 0.95;         // the name above the label's line, the note below it
    name.material.opacity = note.material.opacity = 0;
    globe.add(g, name, note);
    return { s, g, disc, ring, name, note, n: g.position.clone().normalize() };
  });

  const vp = new THREE.Vector2(), cam = new THREE.Vector3(), toCam = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  const world = new THREE.Vector3(), q = new THREE.Quaternion(), qInv = new THREE.Quaternion();
  let t0 = 0, shown = false;
  function update(p, fade, dt, still) {
    const f = clamp01(fade);
    group.visible = f > 0.004;
    if (!group.visible) { shown = false; return 0; }
    if (!shown) { shown = true; t0 = clock(); }           // the journey is drawn again each time the globe appears
    const t = still ? 1e3 : clock() - t0;
    globe.rotation.y = still ? 0 : 0.085 * Math.sin(0.19 * t);

    renderer.getDrawingBufferSize(vp);
    const ratio = renderer.getPixelRatio();
    sea.uOpacity.value = f;
    dotU.uOpacity.value = f;
    dotU.uScale.value = camera.projectionMatrix.elements[5] * vp.y * 0.5;
    dotU.uMaxPx.value = 9 * ratio;
    borderMat.opacity = 0.55 * f;
    routes.resize(vp, ratio * Math.max(0.75, Math.min(1.4, vp.y / ratio / 900)));
    routes.uniforms.uTime.value = t; routes.uniforms.uOpacity.value = f; routes.uniforms.uFlat.value = still ? 1 : 0;

    // The camera's position and screen axes, in the globe's own (swaying) frame.
    globe.getWorldQuaternion(q); qInv.copy(q).invert();
    camera.getWorldPosition(cam).applyQuaternion(qInv);
    right.setFromMatrixColumn(camera.matrixWorld, 0).applyQuaternion(qInv);
    up.setFromMatrixColumn(camera.matrixWorld, 1).applyQuaternion(qInv);
    const big = labelBoost(camera, renderer, cam.length(), NAME_H, 21);      // labels stay legible on phones
    for (const x of sites) {
      sizeSprite(x.name, NAME_H * big); sizeSprite(x.note, NOTE_H * big);
      const on = smooth(x.s.at, x.s.at + 0.5, t);
      toCam.copy(cam).sub(x.g.position);
      const d = toCam.length();
      const facing = smooth(0.0, 0.2, x.n.dot(toCam.normalize()));
      x.g.scale.setScalar(d * 0.0044);
      const pulse = still ? 0.35 : (t * 0.55 + x.s.lon * 0.01) % 1;
      x.ring.scale.setScalar(1 + pulse * 1.6);
      x.ring.material.opacity = f * on * (1 - pulse) * 0.8;
      x.disc.material.opacity = f * on;
      // The label: beside the place, a constant distance away on screen.
      world.copy(x.g.position).addScaledVector(right, SIDE[x.s.side] * d * 0.0085).addScaledVector(up, (x.s.rise || 0) * big);
      x.name.position.copy(world); x.note.position.copy(world);
      x.name.material.opacity = x.note.material.opacity = f * on * facing;
    }
    return still ? 0 : t < 8.5 ? 2 : 1;
  }
  update({}, 0, 0, true);
  return { group, update, dispose() { disposeTree(group); } };
}
