// One CE-E cassette of the HGCAL: a 60-degree wedge with a copper cooling plate, the silicon
// modules on it (full hexagons, and partial ones along the edges), their electronics and the
// services (optical fibres, power, CO2 cooling). Loaded by scene.js when the hardware page needs it.
//
// The layout is schematic; the modules are this site's hexaboards. The electronics follow the
// cassette's integration drawings: "trains" run along the lines of modules parallel to the wedge's
// edges. A low-density train is an inner wagon, an engine and an outer wagon (long, narrow
// connection boards; the engine carries the link chips and the optical link), and the two lines
// next to the axis meet in a V. High-density trains are wider wagons over the modules near the
// beam, with their engines where the two kinds of module meet. Every low-density module carries
// two mezzanines, one on each side of its wagon. The services follow the trains out to the rim.
//
// Frame: meters. The wedge lies in the xy plane around the beam axis (the origin), pointing up
// (+y), modules on the +z side.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hexOutline, slabGeometry, layerTextures, DIM, MM, SQ3 } from './hexaboard.js';
import { clamp01, smooth, GeoBuilder, sectorSolid, canvasTex, dithered, disposeTree } from './kit.js';

const P0 = Math.PI / 3, P1 = (2 * Math.PI) / 3;   // wedge edges
const R_IN = 0.33, R_OUT = 1.56;
const MOD_T = 0.004, PLATE_T = 0.006;
// What a view can set: elec (0..1) the electronics in place, serv (0..1) the services in place,
// pick (0 or 1) one module taken out (scene.js shows the detailed module in its place).
export const PARAMS = { elec: 1, serv: 1, pick: 0 };
// Where the picked module sits: the full low-density module nearest to this point (m).
const PICK_NEAR = [0.09, 1.02];
export const CENTER = [0, 0.97, 0];               // the middle of the wedge

// Clip a polygon by the half-plane n.p >= c (Sutherland-Hodgman).
function clipHalf(poly, nx, ny, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c, db = nx * b[0] + ny * b[1] - c;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
const area = poly => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };

// createCassette() -> { group, update(p, fade, dt, still), pickSite, dispose() }. p holds PARAMS;
// fade (0..1) is the cassette's overall presence. update returns true while something on it moves
// on its own (the coolant in the CO2 loop).
export function createCassette() {
  const group = new THREE.Group();
  group.name = 'hgcal-cassette';

  // --- copper cooling plate ---------------------------------------------------------------------
  const pb = new GeoBuilder();
  sectorSolid(pb, { r0: R_IN, r1: R_OUT, z0: -PLATE_T, z1: 0, p0: P0, p1: P1, segs: 48 });
  group.add(new THREE.Mesh(pb.build(), new THREE.MeshStandardMaterial({ color: 0xb8794a, metalness: 0.85, roughness: 0.38, envMapIntensity: 0.9 })));

  // --- modules: full ones instanced, partial ones (cut by the wedge edges) merged ----------------
  const pitch = DIM.base * MM + 0.0025, RC = DIM.base * MM / SQ3;
  const outline = hexOutline(DIM.base).map(([x, y]) => [x * MM, y * MM]);
  const n1 = [-Math.sin(P0), Math.cos(P0)], n2 = [Math.sin(P1), -Math.cos(P1)];
  const margin = 0.002;
  const full = { HD: [], LD: [] }, part = { HD: [], LD: [] };
  const fullArea = area(outline);
  for (let j = 0; j < 12; j++) {
    for (let i = -8; i <= 8; i++) {
      const x = (i + (j % 2 ? 0.5 : 0)) * pitch, y = j * pitch * (SQ3 / 2) + 0.36;
      const r = Math.hypot(x, y);
      if (r - RC < R_IN + 0.01 || r + RC > R_OUT - 0.01) continue;
      let poly = outline.map(([a, b]) => [a + x, b + y]);
      poly = clipHalf(poly, n1[0], n1[1], margin);
      poly = clipHalf(poly, n2[0], n2[1], margin);
      if (poly.length < 3) continue;
      const fr = area(poly) / fullArea;
      if (fr < 0.3) continue;
      const kind = r < 0.7 ? 'HD' : 'LD';
      if (fr > 0.995) full[kind].push({ x, y, r, j, kind });
      else part[kind].push({ x, y, r, j, kind, poly: poly.map(([a, b]) => [(a - x) / MM, (b - y) / MM]) });
    }
  }
  const all = [...full.HD, ...full.LD, ...part.HD, ...part.LD];
  const rMin = Math.min(...all.map(s => s.r)), rMax = Math.max(...all.map(s => s.r));
  const picked = full.LD.slice().sort((a, b) => Math.hypot(a.x - PICK_NEAR[0], a.y - PICK_NEAR[1]) - Math.hypot(b.x - PICK_NEAR[0], b.y - PICK_NEAR[1]))[0];

  const m4 = new THREE.Matrix4();
  let pickMesh = null, pickIndex = -1;
  for (const kind of ['HD', 'LD']) {
    const tex = layerTextures(kind, '#62e8b0', 0.12, 8);
    const mk = () => new THREE.MeshStandardMaterial({ map: tex.map, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.5, emissive: 0xffffff, emissiveMap: tex.emissive, emissiveIntensity: 1 });
    if (full[kind].length) {
      const geo = slabGeometry(hexOutline(DIM.base), [], MOD_T / MM, [0.01, 0.5]);
      const mesh = new THREE.InstancedMesh(geo, mk(), full[kind].length);
      full[kind].forEach((s, k) => {
        m4.makeTranslation(s.x, s.y, 0);
        mesh.setMatrixAt(k, m4);
        if (s === picked) { pickMesh = mesh; pickIndex = k; }
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    if (part[kind].length) {
      const geos = part[kind].map(s => {
        const g = slabGeometry(s.poly, [], MOD_T / MM, [0.01, 0.5]);
        g.translate(s.x, s.y, 0);
        return g;
      });
      const mesh = new THREE.Mesh(mergeGeometries(geos), mk());
      mesh.frustumCulled = false;
      group.add(mesh);
      for (const g of geos) g.dispose();
    }
  }

  // --- electronics: mezzanines, wagons and engines ----------------------------------------------
  const elec = new THREE.Group();
  group.add(elec);
  const stdMat = (color, metal = 0.12, rough = 0.6) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: 0.45 });
  const MAT = {
    wagon: stdMat(0xbe9a70), hdWagon: stdMat(0x17557b), engine: stdMat(0xd42b2b), hdEngine: stdMat(0x7a30dd),
    mezzA: stdMat(0xc02fd4), mezzB: stdMat(0x2438d6), chip: stdMat(0xdfe3e8, 0.35, 0.4), conn: stdMat(0xf2eee4, 0.2, 0.6),
  };
  const S3 = SQ3 / 2;
  const UL = [-0.5, S3], UR = [0.5, S3];                 // the two directions the trains run in (outward)
  const inWedge = (x, y, m) => n1[0] * x + n1[1] * y >= m && n2[0] * x + n2[1] * y >= m;
  const clipWedge = (pts, m = 0.004) => clipHalf(clipHalf(pts, n1[0], n1[1], m), n2[0], n2[1], m);
  const extrude = (pts, t) => new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), { depth: t, bevelEnabled: false });
  const stripPts = (a, b, w) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy), nx = (-dy / l) * w / 2, ny = (dx / l) * w / 2;
    return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  };
  // a V of two strips from the corner c: one arm la long toward the upper left, one lb long toward the upper right
  const veePts = (c, la, lb, w) => {
    const h = w / 2, A = [c[0] - 0.5 * la, c[1] + S3 * la], B = [c[0] + 0.5 * lb, c[1] + S3 * lb];
    return [[A[0] - S3 * h, A[1] - 0.5 * h], [c[0], c[1] - w], [B[0] + S3 * h, B[1] - 0.5 * h], [B[0] - S3 * h, B[1] + 0.5 * h], [c[0], c[1] + w], [A[0] + S3 * h, A[1] + 0.5 * h]];
  };
  const part3 = (obj, x, y, z, order) => {
    obj.position.set(x, y, z);
    obj.userData.z = z;
    obj.userData.order = order;
    elec.add(obj);
    return obj;
  };
  const box = (parent, w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z + d / 2);
    parent.add(m);
    return m;
  };
  const W = 0.25 * pitch, WT = 0.001;                    // low-density wagon: width and thickness
  const zB = MOD_T + 0.003;                              // the boards sit 3 mm above the hexaboards
  const addBoard = (pts, mat, order) => {
    const cl = clipWedge(pts);
    if (cl.length < 3) return null;
    return part3(new THREE.Mesh(extrude(cl, WT), mat), 0, 0, zB, order);
  };

  // low-density modules by line: 'L' + n runs parallel to the left edge, 'R' + n to the right edge
  const modAt = new Map(all.map(s => [`${Math.round((s.x / pitch) * 2)},${s.j}`, s]));
  const at = (xu, j) => modAt.get(`${Math.round(xu * 2)},${j}`);
  const lines = new Map();
  for (const s of all) {
    if (s.kind !== 'LD') continue;
    const xu = s.x / pitch;
    const k = xu < -0.25 ? 'L' + Math.round(xu + s.j / 2) : 'R' + Math.round(xu - s.j / 2);
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push(s);
  }
  for (const l of lines.values()) l.sort((a, b) => a.j - b.j);
  const family = k => (k[0] === 'L' ? { d: UL, m: [S3, 0.5] } : { d: UR, m: [-S3, 0.5] });   // m: the side facing the axis

  // an engine: a small board with its chips; hd: the larger high-density one
  const engineAt = (x, y, d, hd, order) => {
    const g = new THREE.Group();
    g.rotation.z = Math.atan2(d[1], d[0]);
    const h = (pitch * (hd ? 0.36 : 0.3)) / 2, t = 0.0012;
    const shape = hd
      ? [[-h, -h * 0.5], [-h * 0.45, -h], [h * 0.6, -h], [h, -h * 0.4], [h, h * 0.5], [h * 0.4, h], [-h * 0.6, h], [-h, h * 0.45]]
      : [[-h, -h], [h, -h], [h, h * 0.5], [h * 0.55, h], [-h, h]];
    g.add(new THREE.Mesh(extrude(shape, t), hd ? MAT.hdEngine : MAT.engine));
    if (hd) {
      for (const cx of [-0.5, 0, 0.5]) for (const cy of [-0.38, 0.22]) box(g, 0.0085, 0.0085, 0.0012, MAT.chip, cx * h, cy * h, t);
      box(g, 0.012, 0.005, 0.0014, MAT.conn, -0.25 * h, 0.7 * h, t);
      box(g, 0.012, 0.005, 0.0014, MAT.conn, 0.25 * h, -0.78 * h, t);
    } else {
      for (const cx of [-0.42, 0.02, 0.46]) box(g, 0.0075, 0.0075, 0.0012, MAT.chip, cx * h, -0.4 * h, t);   // link chips
      box(g, 0.015, 0.0065, 0.0016, MAT.chip, 0.1 * h, 0.42 * h, t);                                       // optical transceiver
      box(g, 0.0035, 1.5 * h, 0.0014, MAT.conn, -0.84 * h, -0.1 * h, t);                                   // connectors to the wagons
      box(g, 0.0035, 1.1 * h, 0.0014, MAT.conn, 0.84 * h, -0.3 * h, t);
    }
    return part3(g, x, y, zB + 0.0006, order);
  };

  const trains = [];                                     // what the services follow
  const HD_ENGINE = new Set(['L-1', 'L0', 'R0', 'R1']);
  const TRAINS = ['L-1', 'L0', 'L1', 'V', 'R-2', 'R-1', 'R0', 'R1'];
  const C = at(-0.5, 5), E1 = at(0, 6);                  // the corner of the V and the vertex of the inner V
  TRAINS.forEach((key, idx) => {
    const o = idx / TRAINS.length;
    if (key === 'V') {
      if (!C || !E1) return;
      const c = [C.x, C.y], e = [E1.x, E1.y];
      const P = (s, v = 0) => [c[0] + (UL[0] * s + S3 * v) * pitch, c[1] + (UL[1] * s + 0.5 * v) * pitch];
      addBoard(veePts(c, 2.4 * pitch, 0.56 * pitch, W), MAT.wagon, 0.3 + o * 0.3);       // the long arm, its corner and the stub to the engine
      addBoard(veePts(e, 1.4 * pitch, 1.4 * pitch, W), MAT.wagon, 0.34 + o * 0.3);       // the inner V
      const ex = c[0] + UR[0] * 0.66 * pitch, ey = c[1] + UR[1] * 0.66 * pitch;
      engineAt(ex, ey, UR, false, 0.7 + o * 0.25);
      trains.push({ key, P, n: 3, from: [ex, ey], enter: 0.3 });
      return;
    }
    const mods = lines.get(key);
    if (!mods || mods.length < 4) return;
    const { d, m } = family(key), p0 = [mods[0].x, mods[0].y], n = mods.length;
    const P = (s, v = 0) => [p0[0] + (d[0] * s + m[0] * v) * pitch, p0[1] + (d[1] * s + m[1] * v) * pitch];
    addBoard(stripPts(P(-0.38), P(1.66), W), MAT.wagon, 0.3 + o * 0.3);
    addBoard(stripPts(P(1.84), P(n - 1 + 0.4), W), MAT.wagon, 0.34 + o * 0.3);
    engineAt(...P(1.75), d, false, 0.7 + o * 0.25);
    const t = { key, P, n, from: P(1.75), enter: 2.0 };
    if (HD_ENGINE.has(key)) { engineAt(...P(-0.6), d, true, 0.74 + o * 0.25); t.hdFrom = P(-0.6); }
    trains.push(t);
  });
  const train = key => trains.find(t => t.key === key);

  // two mezzanines on each low-density module, one on each side of its wagon; the ones a wagon corner
  // or the wedge's edge leaves no room for are left out
  const mezzPts = (s, d, m, side) => [[-0.3, -0.105], [0.3, -0.105], [0.3, 0.02], [0.2, 0.105], [-0.2, 0.105], [-0.3, 0.02]].map(([u, v]) => {
    const vv = side * (0.31 + v);
    return [s.x + (d[0] * u + m[0] * vv) * pitch, s.y + (d[1] * u + m[1] * vv) * pitch];
  });
  for (const [k, mods] of lines) {
    const { d, m } = family(k);
    for (const [side, mat] of [[1, MAT.mezzA], [-1, MAT.mezzB]]) {
      const geos = [];
      for (const s of mods) {
        if (side > 0 && (s === C || s === E1)) continue;
        const pts = mezzPts(s, d, m, side);
        if (!pts.every(([x, y]) => inWedge(x, y, 0.005))) continue;
        geos.push(extrude(pts, 0.0012));
      }
      if (geos.length) part3(new THREE.Mesh(mergeGeometries(geos), mat), 0, 0, zB - 0.0004, ((mods[0].r - rMin) / (rMax - rMin + 1e-6)) * 0.2);
      for (const g of geos) g.dispose();
    }
  }

  // high-density wagons: one wide board over a chain of modules, from its engine toward the beam
  const hexPts = (cx, cy, k) => outline.map(([a, b]) => [cx + a * k, cy + b * k]);
  const hdWagon = (t, chain, order) => {
    if (!t || !t.hdFrom) return;
    const geos = [];
    const add = pts => { const cl = clipWedge(pts, 0.006); if (cl.length >= 3) geos.push(extrude(cl, WT)); };
    for (const [from, mods] of chain) {
      let prev = from;
      for (const s of mods) {
        if (!s) continue;
        add(stripPts(prev, [s.x, s.y], 0.42 * pitch));
        add(hexPts(s.x, s.y, 0.66));
        prev = [s.x, s.y];
      }
    }
    if (!geos.length) return;
    part3(new THREE.Mesh(mergeGeometries(geos), MAT.hdWagon), 0, 0, zB, order);
    for (const g of geos) g.dispose();
  };
  const xy = s => (s ? [s.x, s.y] : null);
  const hdL = train('L0'), hdR = train('R0'), hdLe = train('L-1'), hdRe = train('R1');
  if (hdL) hdWagon(hdL, [[hdL.P(-0.8), [at(-1, 2), at(-0.5, 1)]], [xy(at(-0.5, 1)), [at(0, 2)]]], 0.36);
  if (hdR) hdWagon(hdR, [[hdR.P(-0.8), [at(1, 2), at(0.5, 1)]]], 0.4);
  if (hdLe) hdWagon(hdLe, [[hdLe.P(-0.8), [at(-1.5, 1)]]], 0.44);
  if (hdRe) hdWagon(hdRe, [[hdRe.P(-0.8), [at(1.5, 1)]]], 0.48);

  // --- services: optical fibres and power follow the trains out to the rim; the CO2 loop ---------
  const serv = new THREE.Group();
  group.add(serv);
  const fibreMat = new THREE.MeshBasicMaterial({ color: 0xffa62b });
  const powerMat = new THREE.MeshStandardMaterial({ color: 0x2f3742, roughness: 0.6, metalness: 0.2 });
  const flow = canvasTex(64, 4, (ctx, w, h) => { const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#08131f'); g.addColorStop(0.6, '#bfe8ff'); g.addColorStop(1, '#08131f'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }, { repeat: true });
  flow.repeat.set(30, 1);
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x9fb3c8, metalness: 0.7, roughness: 0.3, emissive: 0x6cc8ff, emissiveMap: flow, emissiveIntensity: 1.6 });
  const tubes = [];
  const tube = (pts, r, mat) => {
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), false, 'catmullrom', 0.05);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, pts.length * 12), r, 8, false), mat);
    serv.add(m);
    tubes.push(m);
  };
  const zS = zB + 0.0034;
  // a service line of a train: from `from`, into the channel beside the wagon (v: its side), out past the rim
  const serviceLine = (t, from, enter, v, r, mat) => {
    let out = t.n;
    while (Math.hypot(...t.P(out, v)) < R_OUT + 0.02 && out < 12) out += 0.05;
    const pts = [];
    if (from) pts.push([from[0], from[1], zS + 0.0022]);
    pts.push([...t.P(enter, v), zS], [...t.P((enter + out) / 2, v), zS], [...t.P(out, v), zS + 0.002], [...t.P(out + 1.25, v), zS + 0.008]);
    tube(pts, r, mat);
  };
  for (const t of trains) {
    serviceLine(t, t.from, t.enter, 0.15, 0.0032, fibreMat);
    if (t.hdFrom) serviceLine(t, t.hdFrom, -0.36, 0.195, 0.0032, fibreMat);
    serviceLine(t, null, t.key === 'V' ? 0.35 : -0.3, -0.166, 0.0042, powerMat);
  }
  // the CO2 loop: in along one edge, round the outer arc, out along the other (on the plate's back)
  const loop = [];
  for (let k = 0; k <= 8; k++) { const r = R_IN + 0.04 + (R_OUT - R_IN - 0.08) * (k / 8); loop.push([r * Math.cos(P1 - 0.03), r * Math.sin(P1 - 0.03), -PLATE_T - 0.01]); }
  for (let k = 1; k < 16; k++) { const a = P1 - 0.03 - (P1 - P0 - 0.06) * (k / 16), r = R_OUT - 0.04; loop.push([r * Math.cos(a), r * Math.sin(a), -PLATE_T - 0.01]); }
  for (let k = 8; k >= 0; k--) { const r = R_IN + 0.04 + (R_OUT - R_IN - 0.08) * (k / 8); loop.push([r * Math.cos(P0 + 0.03), r * Math.sin(P0 + 0.03), -PLATE_T - 0.01]); }
  tube(loop, 0.009, pipeMat);

  // --- state -----------------------------------------------------------------------------------------
  const fader = dithered(group, 'cassette');
  const mHide = new THREE.Matrix4().makeScale(0, 0, 0), mShow = new THREE.Matrix4();
  if (picked) mShow.makeTranslation(picked.x, picked.y, 0);
  let lastElec = -1, lastServ = -1, lastPick = null;

  function update(p, fade, dt = 0, still = false) {
    fader.set(clamp01(fade));
    if (!group.visible) return false;
    const el = clamp01(p.elec), sv = clamp01(p.serv), pk = p.pick > 0.5;
    if (Math.abs(el - lastElec) > 1e-4) {
      lastElec = el;
      for (const m of elec.children) {
        const k = smooth(m.userData.order * 0.7, m.userData.order * 0.7 + 0.3, el);
        m.visible = k > 0.001;
        m.position.z = m.userData.z + (1 - k) * 0.25;
      }
    }
    if (Math.abs(sv - lastServ) > 1e-4) {
      lastServ = sv;
      serv.visible = sv > 0.001;
      for (const t of tubes) t.geometry.setDrawRange(0, Math.floor((t.geometry.index.count * smooth(0, 1, sv)) / 6) * 6);
    }
    if (pk !== lastPick && pickMesh) {
      lastPick = pk;
      pickMesh.setMatrixAt(pickIndex, pk ? mHide : mShow);
      pickMesh.instanceMatrix.needsUpdate = true;
    }
    if (still || sv < 0.5) return false;
    flow.offset.x = (flow.offset.x - dt * 0.6) % 1;      // the coolant flows
    return true;
  }

  function dispose() {
    disposeTree(group);
    flow.dispose();
    group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
  }

  return {
    group, update, dispose,
    // the middle of the picked module, in the cassette's frame
    pickSite: picked ? [picked.x, picked.y, MOD_T / 2] : [PICK_NEAR[0], PICK_NEAR[1], MOD_T / 2],
  };
}
