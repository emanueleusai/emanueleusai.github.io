// One HGCAL endcap, as CMSSW describes it (DD4hep geometry, scenario v18; the numbers are in
// hgcal-geom.js, generated from cms-sw/cmssw). Loaded by scene.js when the hardware page needs it.
//
// 47 layers. CE-E (26 layers): 13 cassettes, each a copper cooling plate with a layer of silicon
// modules on either side, between lead absorbers clad in steel and copper. CE-H (21 layers): each a
// steel absorber, a steel cover, a layer of modules and a copper cooling plate; the first 7 are all
// silicon, the other 14 have silicon near the beam and scintillator tiles farther out. Every
// module sits where CMSSW places it, including the partial modules at the edges (their outlines
// come from CMSSW's own HGCalWaferMask), and every tile block is CMSSW's.
//
// Frame: meters, beam along z, the endcap's middle at z = 0 and its front (the side that faces the
// collision point) toward -z. scene.js turns it around and puts it on the detector's far side.
//
// Everything that moves per layer (the layers pulled apart) is done in the vertex shader, from a
// small per-layer texture and a per-vertex layer id, so the whole endcap stays a handful of draw
// calls. The cutaway is not a clipping plane: every part is built with the pieces inside the
// removed quadrant last, and the cut view simply draws fewer of them. Nothing discards fragments
// unless a layer is fading (then a dithered copy of the material is swapped in), so the GPU's
// early depth test keeps the 47 stacked layers cheap.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hexOutline, slabGeometry, layerTextures, DIM, MM, TEX_SPAN } from './hexaboard.js';
import { TAU, clamp01, GeoBuilder, patch, DITHER_GLSL, canvasTex, disposeTree } from './kit.js';
import { WAFER, LAYERS as GEO, SLABS, WAFERS, SHAPES, TILES, ENVELOPE } from './hgcal-geom.js';

export const Z0 = 4.19;                 // m from the collision point to the endcap's middle
const N = GEO.length;
const NE = GEO.filter(g => g.sec === 'EE').length;
const SIDES = 36;                       // the polyhedral plates: 36 flat sides
const COS_A = Math.cos(Math.PI / SIDES);
const SKIN = 0.00025;                   // m: slabs that touch are drawn this much apart (no coplanar faces)
const DPHI = TAU / TILES.nPhi;          // scintillator tiles: 1.25 degrees
const KE = 7, KH = 1.9;                 // how far apart the layers of CE-E and CE-H are pulled (in gaps)
const COLORS = {
  copper: 0xb8794a, lead: 0x4a525e, steel: 0x8e98a6, cover: 0xa9b2be,
  capSi: '#2fb866', capSc: '#2f8fd8', capCu: '#a86a3c', capPb: '#454c57', capSteel: '#8a95a3', capCover: '#aab3bf',
  ringE: '#62e8b0', ringSc: '#4db8ff',
};
// What a view can set (scene.js interpolates these between views). cut: the cutaway (a quadrant
// removed); exE, exH: CE-E and CE-H pulled apart; absE, absH: how solid their absorbers are;
// showH: how much of CE-H shows; dimE, dimH: brightness; glowE, glowH: how strongly the boards glow.
export const PARAMS = { cut: 1, exE: 0, exH: 0, absE: 0.3, absH: 0.3, showH: 1, dimE: 1, dimH: 1, glowE: 1, glowH: 1 };

// --- the layer table, from the CMSSW numbers -------------------------------------------------------
function layerTable() {
  const L = GEO.map((g, i) => {
    const zf = g.z0 * MM - Z0, zb = g.z1 * MM - Z0;
    let rSi = g.rOut * MM;
    for (let k = g.t[0]; k < g.t[1]; k++) rSi = Math.min(rSi, TILES.rMin[TILES.blocks[k][0] - 1] * MM);
    return {
      i, sec: g.sec === 'EE' ? 0 : 1, mix: g.t[1] > g.t[0], blk: g.blk, zf, zb,
      rIn: g.rIn * MM, rOut: g.rOut * MM, rSi, face: g.face, rot: g.rot ? -Math.PI / 6 : 0,
      wedges: g.sec === 'EE' ? 6 : 12, slabs: [],
    };
  });
  for (const [li, kind, z0, z1, r0, r1, sides] of SLABS) {
    L[li].slabs.push({ kind, z0: z0 * MM - Z0, z1: z1 * MM - Z0, r0: r0 * MM, r1: r1 * MM, sides });
  }
  // the steel back disk closes the endcap
  const bp = ENVELOPE.HGCalBackPlate;
  L[N - 1].slabs.push({ kind: 'back', z0: bp[0][0] * MM - Z0, z1: bp[1][0] * MM - Z0, r0: bp[0][1] * MM, r1: bp[0][2] * MM, sides: 0 });
  return L;
}

// Every silicon module: position and outline in the endcap frame (m), layer, board type.
function waferTable(LAYERS) {
  const raw = Uint8Array.from(atob(WAFERS), c => c.charCodeAt(0));
  const S3 = Math.sqrt(3), pitch = WAFER.size + WAFER.sep;
  const shift = { 2: [0, 1], 3: [0, -1], 5: [1, 0], 6: [-1, 0] };
  const out = [];
  for (const l of LAYERS) {
    const g = GEO[l.i];
    const [sx, sy] = shift[g.orient] || [0, 0];
    const xo = (sx * pitch) / S3, yo = (sy * pitch) / S3;
    const c = Math.cos(l.rot), s = Math.sin(l.rot);
    const toWorld = (px, py) => [(c * px - s * py) * MM, (s * px + c * py) * MM];
    for (let k = g.w[0]; k < g.w[1]; k++) {
      const u = (raw[k * 4] << 24) >> 24, v = (raw[k * 4 + 1] << 24) >> 24;
      const thick = raw[k * 4 + 2] >> 5, part = raw[k * 4 + 2] & 31, place = raw[k * 4 + 3] >> 4;
      const lx = xo + (-2 * u + v) * WAFER.delx, ly = yo + 2 * v * WAFER.dy;
      const [x, y] = toWorld(lx, ly);
      let poly = null;
      if (part) {
        const a = SHAPES[`${part}_${place}`];
        poly = [];
        for (let j = 0; j < a.length; j += 2) poly.push(toWorld(lx + a[j], ly + a[j + 1]));
        let area = 0;
        for (let j = 0; j < poly.length; j++) {
          const p = poly[j], q = poly[(j + 1) % poly.length];
          area += p[0] * q[1] - q[0] * p[1];
        }
        if (area < 0) poly.reverse();          // counter-clockwise
      }
      out.push({ l, x, y, hd: thick === 0 || thick === 3, part, orient: place % 6, poly });
    }
  }
  return out;
}

// --- solids: annular sectors with a round or 36-sided outline ----------------------------------------
// DD4hep's polyhedra give the distance to the flat sides; flats are centred on multiples of 10 degrees.
const polyR = (apothem, a) => apothem / Math.cos(a - Math.round(a / (TAU / SIDES)) * (TAU / SIDES));
function sectorAngles(p0, p1, sides) {
  const out = [p0];
  if (sides) {
    const step = TAU / SIDES;
    for (let k = Math.floor(p0 / step - 0.5); ; k++) {
      const a = (k + 0.5) * step;
      if (a >= p1 - 1e-9) break;
      if (a > p0 + 1e-9) out.push(a);
    }
  } else {
    const n = Math.max(2, Math.ceil((p1 - p0) / (TAU / 144)));
    for (let i = 1; i < n; i++) out.push(p0 + ((p1 - p0) * i) / n);
  }
  out.push(p1);
  return out;
}
// A slab: r from r0 to r1 (r1 is the corner radius when it has sides), z from z0 to z1, phi from p0 to p1.
function slabSector(b, { r0, r1, z0, z1, p0, p1, sides = 0, uv = [0.5, 0.5] }) {
  const A = sectorAngles(p0, p1, sides);
  const ap = r1 * COS_A;                // outer apothem; the inner boundary uses r0 as its apothem
  const R1 = a => (sides ? polyR(ap, a) : r1), R0 = a => (sides ? polyR(r0, a) : r0);
  const full = Math.abs(p1 - p0 - TAU) < 1e-6;
  const P = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];
  const flatN = (a, s) => { const f = Math.round(a / (TAU / SIDES)) * (TAU / SIDES); return [s * Math.cos(f), s * Math.sin(f), 0]; };
  for (let i = 0; i + 1 < A.length; i++) {
    const a0 = A[i], a1 = A[i + 1];
    // front (z0, facing the collision point) and back
    let v = [P(R0(a0), a0, z0), P(R1(a0), a0, z0), P(R1(a1), a1, z0), P(R0(a1), a1, z0)].map(p => b.vertex(p, [0, 0, -1], uv));
    b.quad(v[0], v[3], v[2], v[1]);
    v = [P(R0(a0), a0, z1), P(R1(a0), a0, z1), P(R1(a1), a1, z1), P(R0(a1), a1, z1)].map(p => b.vertex(p, [0, 0, 1], uv));
    b.quad(v[0], v[1], v[2], v[3]);
    // outer and inner walls (flat normals on the polygon sides)
    for (const [R, s] of [[R1, 1], [R0, -1]]) {
      const n0 = sides ? flatN((a0 + a1) / 2, s) : [s * Math.cos(a0), s * Math.sin(a0), 0];
      const n1 = sides ? n0 : [s * Math.cos(a1), s * Math.sin(a1), 0];
      const w0 = b.vertex(P(R(a0), a0, z0), n0, uv), w1 = b.vertex(P(R(a1), a1, z0), n1, uv);
      const w2 = b.vertex(P(R(a1), a1, z1), n1, uv), w3 = b.vertex(P(R(a0), a0, z1), n0, uv);
      if (s > 0) b.quad(w0, w1, w2, w3); else b.quad(w0, w3, w2, w1);
    }
  }
  if (!full) {
    for (const [a, s] of [[p0, -1], [p1, 1]]) {
      const n = [-Math.sin(a) * s, Math.cos(a) * s, 0], c = Math.cos(a), si = Math.sin(a);
      const ra = R0(a), rb = R1(a);
      const v0 = b.vertex([ra * c, ra * si, z0], n, uv), v1 = b.vertex([rb * c, rb * si, z0], n, uv);
      const v2 = b.vertex([rb * c, rb * si, z1], n, uv), v3 = b.vertex([ra * c, ra * si, z1], n, uv);
      if (s > 0) b.quad(v0, v3, v2, v1); else b.quad(v0, v1, v2, v3);
    }
  }
}

// --- shader additions shared by every part of the endcap ----------------------------------------------
const VHEAD = /* glsl */`
  attribute float aLayer;
  uniform sampler2D uLayerTex;     // per layer: z offset, alpha, absorber alpha, cap alpha
  #ifndef HG_ACH
  #define HG_ACH hgD.g
  #endif
  varying float vHgA;
  varying float vHgH;
`;
const VPROJ = /* glsl */`
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  #endif
  vec4 hgD = texelFetch(uLayerTex, ivec2(int(aLayer + 0.5), 0), 0);
  mvPosition.z += hgD.r;
  vHgA = HG_ACH;
  vHgH = step(${NE - 0.5}, aLayer);
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
  if (vHgA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);    // a hidden layer costs nothing to draw
`;
const FHEAD = /* glsl */`
  varying float vHgA;
  varying float vHgH;
  uniform vec2 uDim;
  uniform vec2 uGlow;
  ${DITHER_GLSL}
`;
const FSTART = `
  #ifdef HG_DITHER
  if (ditherIGN(gl_FragCoord.xy) >= vHgA) discard;
  #endif`;
const FCOLOR = `
  diffuseColor.rgb *= mix(uDim.x, uDim.y, vHgH);
  #ifdef HG_ALPHA
  diffuseColor.a *= vHgA;
  #endif`;
const FEMISSIVE = 'totalEmissiveRadiance *= mix(uGlow.x, uGlow.y, vHgH);';

function tileTextures() {
  const draw = glow => (ctx, w, h) => {
    ctx.fillStyle = glow ? '#000' : '#0a1420';
    ctx.fillRect(0, 0, w, h);
    const m = w * 0.06;
    const g = ctx.createLinearGradient(m, m, w - m, h - m);
    g.addColorStop(0, glow ? '#0d3a66' : '#2a7fd0');
    g.addColorStop(1, glow ? '#08264a' : '#1b5ea6');
    ctx.fillStyle = g;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(m, m, w - 2 * m, h - 2 * m, w * 0.06); else ctx.rect(m, m, w - 2 * m, h - 2 * m);
    ctx.fill();
    ctx.strokeStyle = glow ? 'rgba(77,184,255,0.55)' : 'rgba(190,225,255,0.55)';
    ctx.lineWidth = w * 0.025;
    ctx.stroke();
    ctx.fillStyle = glow ? 'rgba(77,184,255,0.35)' : 'rgba(10,30,60,0.6)';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.09, 0, TAU);
    ctx.fill();
  };
  return {
    map: canvasTex(128, 128, draw(false), { repeat: true }),
    emissive: canvasTex(128, 128, draw(true), { repeat: true }),
  };
}

// The removed quadrant of the cutaway: phi in (90, 180) degrees, i.e. x < 0 and y > 0.
const CUT0 = Math.PI / 2, CUT1 = Math.PI;
// Split [p0, p1] into the parts outside and inside the removed quadrant.
function splitRange(p0, p1) {
  const kept = [], cut = [];
  const a = Math.max(p0, CUT0), b = Math.min(p1, CUT1);
  if (b - a > 1e-6) {
    cut.push([a, b]);
    if (a - p0 > 1e-6) kept.push([p0, a]);
    if (p1 - b > 1e-6) kept.push([b, p1]);
  } else kept.push([p0, p1]);
  return { kept, cut };
}

// createEndcap({ renderer }) -> { group, update(p, fade), compile(camera, scene), dispose() }.
// p holds PARAMS; fade (0..1) is the endcap's overall presence.
export function createEndcap({ renderer }) {
  if (!renderer.capabilities.isWebGL2) throw new Error('the HGCAL model needs WebGL 2');
  const LAYERS = layerTable();
  const group = new THREE.Group();
  group.name = 'hgcal-endcap';

  // Per-layer state lives in a small float texture read by the vertex shader (texelFetch), which
  // compiles far better than dynamically indexed uniform arrays.
  const zArr = new Float32Array(N), aArr = new Float32Array(N), absA = new Float32Array(N), capA = new Float32Array(N), capB = new Float32Array(N);
  const layerData = new Float32Array(N * 4);
  const layerTex = new THREE.DataTexture(layerData, N, 1, THREE.RGBAFormat, THREE.FloatType);
  layerTex.minFilter = layerTex.magFilter = THREE.NearestFilter;
  layerTex.needsUpdate = true;
  const U = {
    uLayerTex: { value: layerTex },
    uDim: { value: new THREE.Vector2(1, 1) }, uGlow: { value: new THREE.Vector2(1, 1) },
  };

  // Each mesh gets an opaque material and a dithered twin, used only while its layers fade.
  const meshes = [];   // { mesh, solid, twin, alpha (array), kept }
  const hg = (mat, defines) => {
    mat.defines = { ...(mat.defines || {}), ...defines };
    return patch(mat, 'hgcal', { uniforms: U, vhead: VHEAD, project: VPROJ, fhead: FHEAD, fstart: FSTART, fcolor: FCOLOR, femissive: FEMISSIVE });
  };
  const add = (mesh, alpha = aArr, { kept = null, dither = true, defines = {} } = {}) => {
    const ach = alpha === absA ? 'hgD.b' : alpha === capA ? 'hgD.a' : alpha === capB ? 'min(hgD.a, hgD.b)' : 'hgD.g';
    const solid = hg(mesh.material, { ...defines, HG_ACH: ach });
    const twin = dither ? hg(mesh.material.clone(), { ...defines, HG_ACH: ach, HG_DITHER: '' }) : null;
    mesh.material = solid;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push({ mesh, solid, twin, alpha, kept });
    return mesh;
  };

  // --- silicon modules ---------------------------------------------------------------------------
  const wafers = waferTable(LAYERS);
  const RC = (WAFER.size / Math.sqrt(3)) * MM;     // module circumradius
  for (const s of wafers) s.inCut = s.x - RC < 0 && s.y + RC > 0;
  const modT = l => l.zb - l.zf - 2 * SKIN;
  const qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const rand = (() => { let a = 7; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
  const texOf = { HD: layerTextures('HD', '#62e8b0', 0.12, 8), LD: layerTextures('LD', '#62e8b0', 0.12, 8) };
  const boardMat = (tex, extra = {}) => new THREE.MeshStandardMaterial({
    map: tex.map, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.45,
    emissive: 0xffffff, emissiveMap: tex.emissive, emissiveIntensity: 1, ...extra,
  });

  // full modules: one instanced slab per board type; 1 mm thick, scaled to each layer's module
  const slab = mergeVertices(slabGeometry(hexOutline(DIM.base), [], 1, [0.01, 0.5]));
  slab.translate(0, 0, -0.0005);
  {
    // the back of a module is its baseplate: no board picture there
    const nor = slab.attributes.normal, uv = slab.attributes.uv;
    for (let i = 0; i < nor.count; i++) if (nor.getZ(i) < -0.5) uv.setXY(i, 0.01, 0.5);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qz = new THREE.Quaternion(), qr = new THREE.Quaternion();
  const p3 = new THREE.Vector3(), sc3 = new THREE.Vector3();
  const col = new THREE.Color();
  for (const kind of ['HD', 'LD']) {
    const list = wafers.filter(s => !s.part && s.hd === (kind === 'HD')).sort((a, b) => a.inCut - b.inCut);
    const kept = list.filter(s => !s.inCut).length;
    const geo = slab.clone();
    const aLayer = new Float32Array(list.length);
    const mesh = new THREE.InstancedMesh(geo, boardMat(texOf[kind]), list.length);
    list.forEach((s, k) => {
      const l = s.l;
      qz.setFromAxisAngle(zAxis, s.orient * (Math.PI / 3));
      qr.setFromAxisAngle(zAxis, l.rot);
      q.copy(qr);
      if (l.face > 0) q.multiply(qFlip);         // the board faces the collision point
      q.multiply(qz);
      p3.set(s.x, s.y, (l.zf + l.zb) / 2);
      sc3.set(1, 1, modT(l) / 0.001);
      m4.compose(p3, q, sc3);
      mesh.setMatrixAt(k, m4);
      const b = 0.86 + rand() * 0.2, warm = rand() < 0.18 ? 0.06 : 0;
      col.setRGB(b * (1 + warm), b, b * (1 - warm * 1.5));
      mesh.setColorAt(k, col);
      aLayer[k] = l.i;
    });
    geo.setAttribute('aLayer', new THREE.InstancedBufferAttribute(aLayer, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    add(mesh, aArr, { kept });
  }
  slab.dispose();

  // Partial modules: built in place, merged per board type. Their texture coordinates follow the
  // board frame that a full module at that site would have.
  const span = TEX_SPAN * MM;
  for (const kind of ['HD', 'LD']) {
    const list = wafers.filter(s => s.part && s.hd === (kind === 'HD')).sort((a, b) => a.inCut - b.inCut);
    if (!list.length) continue;
    const pb = new GeoBuilder({ aLayer: 1, color: 3 });
    let kept = 0;
    for (const s of list) {
      const l = s.l;
      const th = s.orient * (Math.PI / 3), c = Math.cos(th), sn = Math.sin(th);
      const cr = Math.cos(-l.rot), sr = Math.sin(-l.rot);
      // endcap offset -> board frame: undo the layer rotation, the flip about y, then the board rotation
      const uvOf = ([px, py]) => {
        const dx = px - s.x, dy = py - s.y;
        let ux = cr * dx - sr * dy;
        const uy = sr * dx + cr * dy;
        if (l.face > 0) ux = -ux;
        return [(c * ux + sn * uy) / span + 0.5, (-sn * ux + c * uy) / span + 0.5];
      };
      const b = 0.86 + rand() * 0.2;
      pb.set('aLayer', l.i).set('color', [b, b, b]);
      const z0 = l.zf + SKIN, z1 = l.zb - SKIN, n = s.poly.length;
      const boardFront = l.face > 0;              // which side shows the board
      const front = s.poly.map(p => pb.vertex([p[0], p[1], z0], [0, 0, -1], boardFront ? uvOf(p) : [0.01, 0.5]));
      for (let k = 1; k < n - 1; k++) pb.tri(front[0], front[k + 1], front[k]);
      const back = s.poly.map(p => pb.vertex([p[0], p[1], z1], [0, 0, 1], boardFront ? [0.01, 0.5] : uvOf(p)));
      for (let k = 1; k < n - 1; k++) pb.tri(back[0], back[k], back[k + 1]);
      for (let k = 0; k < n; k++) {
        const a = s.poly[k], bb = s.poly[(k + 1) % n];
        const ex = bb[0] - a[0], ey = bb[1] - a[1], el = Math.hypot(ex, ey) || 1;
        const nn = [ey / el, -ex / el, 0];
        const v0 = pb.vertex([a[0], a[1], z0], nn, [0.01, 0.5]), v1 = pb.vertex([bb[0], bb[1], z0], nn, [0.01, 0.5]);
        const v2 = pb.vertex([bb[0], bb[1], z1], nn, [0.01, 0.5]), v3 = pb.vertex([a[0], a[1], z1], nn, [0.01, 0.5]);
        pb.quad(v0, v1, v2, v3);
      }
      if (!s.inCut) kept = pb.index.length;
    }
    add(new THREE.Mesh(pb.build(), boardMat(texOf[kind], { vertexColors: true })), aArr, { kept });
  }

  // --- cooling plates and covers (per cassette), absorbers, tiles, outline rings -------------------
  const plates = new GeoBuilder({ aLayer: 1, color: 3 });
  const covers = new GeoBuilder({ aLayer: 1, color: 3 });   // drawn with the absorbers: see-through, hidden when pulled apart
  const absorb = new GeoBuilder({ aLayer: 1, color: 3 });
  const tiles = new GeoBuilder({ aLayer: 1 });
  const rings = new GeoBuilder({ aLayer: 1, color: 3 });
  const GAP = 0.004;   // m between cassettes
  const keptIndex = {};
  const cCu = new THREE.Color(COLORS.copper), cPb = new THREE.Color(COLORS.lead), cSt = new THREE.Color(COLORS.steel), cCov = new THREE.Color(COLORS.cover);
  const ringE = new THREE.Color(COLORS.ringE), ringSc = new THREE.Color(COLORS.ringSc);
  const rgb = c => [c.r, c.g, c.b];
  for (const part of ['kept', 'cut']) {
    for (const l of LAYERS) {
      const dW = TAU / l.wedges;
      for (const sl of l.slabs) {
        const z0 = sl.z0 + SKIN, z1 = sl.z1 - SKIN;
        if (sl.kind === 'cu' || sl.kind === 'cover') {
          // these belong to the cassettes: one sector each, with a small gap between them
          const pl = sl.kind === 'cu' ? plates : covers;
          pl.set('aLayer', l.i).set('color', rgb(sl.kind === 'cu' ? cCu : cCov));
          const g = GAP / 2 / Math.max(sl.r0, 0.3);
          for (let w = 0; w < l.wedges; w++) {
            for (const [p0, p1] of splitRange(w * dW + g, (w + 1) * dW - g)[part]) {
              slabSector(pl, { r0: sl.r0, r1: sl.r1, z0, z1, p0, p1, sides: sl.sides });
            }
          }
        } else {
          absorb.set('aLayer', l.i).set('color', rgb(sl.kind === 'pb' ? cPb : cSt));
          for (const [p0, p1] of splitRange(0, TAU)[part]) slabSector(absorb, { r0: sl.r0, r1: sl.r1, z0, z1, p0, p1, sides: sl.sides });
        }
      }
      // scintillator tile blocks: one texture repeat per tile (u: phi bins, v: rings)
      const g = GEO[l.i];
      tiles.set('aLayer', l.i);
      for (let k = g.t[0]; k < g.t[1]; k++) {
        const [r1, r2, f1, f2] = TILES.blocks[k];
        const p0 = (f1 - 1) * DPHI, p1 = f2 * DPHI;
        const inCut = p0 >= CUT0 - 1e-6 && p1 <= CUT1 + 1e-6;
        if ((part === 'cut') !== inCut) continue;
        const z0 = l.zf + SKIN, z1 = l.zb - SKIN;
        const nb = f2 - f1 + 1;
        const P = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];
        for (let f = 0; f < nb; f += 4) {
          const m = Math.min(4, nb - f);
          const a0 = p0 + f * DPHI, a1 = a0 + m * DPHI;
          for (let j = r1; j <= r2; j++) {
            const ra = TILES.rMin[j - 1] * MM, rb = TILES.rMax[j - 1] * MM;
            const vv = [[ra, a0, 0, j - 1], [rb, a0, 0, j], [rb, a1, m, j], [ra, a1, m, j - 1]]
              .map(([r, a, u, w]) => tiles.vertex(P(r, a, z0), [0, 0, -1], [u, w]));
            tiles.quad(vv[0], vv[3], vv[2], vv[1]);
          }
          const R0 = TILES.rMin[r1 - 1] * MM, R1 = TILES.rMax[r2 - 1] * MM;
          const bk = [[R0, a0], [R1, a0], [R1, a1], [R0, a1]].map(([r, a]) => tiles.vertex(P(r, a, z1), [0, 0, 1], [0.03, 0.03]));
          tiles.quad(bk[0], bk[1], bk[2], bk[3]);
          for (const [r, s] of [[R1, 1], [R0, -1]]) {
            const n0 = [s * Math.cos(a0), s * Math.sin(a0), 0], n1 = [s * Math.cos(a1), s * Math.sin(a1), 0];
            const w0 = tiles.vertex(P(r, a0, z0), n0, [0.03, 0.03]), w1 = tiles.vertex(P(r, a1, z0), n1, [0.03, 0.03]);
            const w2 = tiles.vertex(P(r, a1, z1), n1, [0.03, 0.03]), w3 = tiles.vertex(P(r, a0, z1), n0, [0.03, 0.03]);
            if (s > 0) tiles.quad(w0, w1, w2, w3); else tiles.quad(w0, w3, w2, w1);
          }
        }
      }
      // outline rings at the outer edge of each layer, and at the silicon/scintillator boundary
      rings.set('aLayer', l.i);
      const lines = [[l.rOut + 0.004, l.mix ? ringSc : ringE]];
      if (l.mix) lines.push([l.rSi, ringE]);
      for (const [p0, p1] of splitRange(0, TAU)[part]) {
        const segs = Math.max(3, Math.round((192 * (p1 - p0)) / TAU));
        for (const [R, c] of lines) {
          rings.set('color', rgb(c));
          for (let i = 0; i < segs; i++) {
            const a0 = p0 + ((p1 - p0) * i) / segs, a1 = p0 + ((p1 - p0) * (i + 1)) / segs;
            const v0 = rings.vertex([R * Math.cos(a0), R * Math.sin(a0), l.zf - 0.0006]);
            const v1 = rings.vertex([R * Math.cos(a1), R * Math.sin(a1), l.zf - 0.0006]);
            rings.index.push(v0, v1);
          }
        }
      }
    }
    if (part === 'kept') {
      keptIndex.plates = plates.index.length; keptIndex.abs = absorb.index.length; keptIndex.covers = covers.index.length;
      keptIndex.tiles = tiles.index.length; keptIndex.rings = rings.index.length;
    }
  }
  add(new THREE.Mesh(plates.build(), new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0.8, roughness: 0.42, envMapIntensity: 0.7, emissive: 0x1c0e06, emissiveIntensity: 1,
  })), aArr, { kept: keptIndex.plates });
  add(new THREE.Mesh(covers.build(), new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0.75, roughness: 0.5, envMapIntensity: 0.7,
  })), absA, { kept: keptIndex.covers });
  const tt = tileTextures();
  add(new THREE.Mesh(tiles.build(), new THREE.MeshStandardMaterial({
    map: tt.map, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.4, emissive: 0xffffff, emissiveMap: tt.emissive, emissiveIntensity: 1,
  })), aArr, { kept: keptIndex.tiles });
  const ringMesh = add(new THREE.LineSegments(rings.build(), new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
  })), aArr, { kept: keptIndex.rings, dither: false, defines: { HG_ALPHA: '' } });
  ringMesh.renderOrder = 2;
  add(new THREE.Mesh(absorb.build(), new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0.75, roughness: 0.48, envMapIntensity: 0.75,
  })), absA, { kept: keptIndex.abs });

  // --- section caps on the two cut faces (a drawing of the layers in section), only in the cutaway --
  const caps = new GeoBuilder({ aLayer: 1, color: 3 }), capsAbs = new GeoBuilder({ aLayer: 1, color: 3 });
  const band = (b, face, r0, r1, z0, z1, hex) => {
    const c = new THREE.Color(hex);
    b.set('color', [c.r, c.g, c.b]);
    // face 0: the half-plane x = 0, y > 0; face 1: y = 0, x < 0. Nudged into the kept side.
    const P = face ? (r, z) => [-r, -0.002, z] : (r, z) => [0.002, r, z];
    const a = b.vertex(P(r0, z0)), bb = b.vertex(P(r1, z0)), cc = b.vertex(P(r1, z1)), d = b.vertex(P(r0, z1));
    b.quad(a, bb, cc, d);
  };
  const capColor = { cu: COLORS.capCu, cover: COLORS.capCover, pb: COLORS.capPb, steel: COLORS.capSteel, back: COLORS.capSteel };
  for (const l of LAYERS) {
    caps.set('aLayer', l.i); capsAbs.set('aLayer', l.i);
    for (const face of [0, 1]) {
      band(caps, face, l.rIn, l.rSi, l.zf, l.zb, COLORS.capSi);
      if (l.mix) band(caps, face, l.rSi, l.rOut, l.zf, l.zb, COLORS.capSc);
      for (const sl of l.slabs) {
        // the cut faces sit on the middle of a flat side: there the radius is the apothem
        const r1 = sl.sides ? sl.r1 * COS_A : sl.r1;
        band(sl.kind === 'cu' ? caps : capsAbs, face, sl.r0, r1, sl.z0, sl.z1, capColor[sl.kind]);
      }
    }
  }
  // the absorber bands follow the absorbers: hidden when the layers are pulled apart
  const capMeshes = [
    add(new THREE.Mesh(caps.build(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })), capA),
    add(new THREE.Mesh(capsAbs.build(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })), capB),
  ];

  // --- state -----------------------------------------------------------------------------------------
  let cutOn = null;
  let lastKey = '';
  function update(p, fade) {
    const f = clamp01(fade);
    group.visible = f > 0.004;
    if (!group.visible) { lastKey = ''; return; }
    const key = `${f.toFixed(3)}|${p.cut > 0.5}|${p.exE.toFixed(4)}|${p.exH.toFixed(4)}|${p.absE.toFixed(3)}|${p.absH.toFixed(3)}|${p.showH.toFixed(3)}|${p.dimE.toFixed(3)}|${p.dimH.toFixed(3)}|${p.glowE.toFixed(3)}|${p.glowH.toFixed(3)}`;
    if (key === lastKey) return;
    lastKey = key;

    // the cutaway: draw only the parts outside the removed quadrant
    const cut = p.cut > 0.5;
    if (cut !== cutOn) {
      cutOn = cut;
      for (const m of meshes) {
        if (m.kept == null) continue;
        if (m.mesh.isInstancedMesh) m.mesh.count = cut ? m.kept : m.mesh.instanceMatrix.count;
        else m.mesh.geometry.setDrawRange(0, cut ? m.kept : Infinity);
      }
    }
    // per-layer offsets: the layers pulled apart (gaps scaled per section; the two layers of a CE-E
    // cassette move together)
    let shift = 0;
    for (let i = 0; i < N; i++) {
      if (i > 0 && LAYERS[i].blk !== LAYERS[i - 1].blk) {
        const gap = LAYERS[i].zf - LAYERS[i - 1].zf;
        shift += gap * (i < NE ? p.exE * KE : i === NE ? 0 : p.exH * KH);
      }
      zArr[i] = shift;
      aArr[i] = i < NE ? f : f * clamp01(p.showH);
      absA[i] = aArr[i] * clamp01(i < NE ? p.absE : p.absH);
      capA[i] = cut ? aArr[i] : 0;
      capB[i] = Math.min(capA[i], absA[i]);
      layerData[i * 4] = zArr[i]; layerData[i * 4 + 1] = aArr[i]; layerData[i * 4 + 2] = absA[i]; layerData[i * 4 + 3] = capA[i];
    }
    layerTex.needsUpdate = true;
    // dithered twins only while something is partly faded; hidden meshes are skipped entirely
    for (const m of meshes) {
      let lo = 1, hi = 0;
      for (let i = 0; i < N; i++) { const a = m.alpha[i]; if (a < lo) lo = a; if (a > hi) hi = a; }
      m.mesh.visible = hi > 0.004 && (!capMeshes.includes(m.mesh) || cut);
      if (m.twin) m.mesh.material = lo < 0.996 ? m.twin : m.solid;
    }
    U.uDim.value.set(p.dimE, p.dimH);
    U.uGlow.value.set(p.glowE, p.glowH);
  }

  // Compile both material variants off-screen, so that the first fade does not stall.
  async function compile(camera, scene) {
    const staging = new THREE.Scene();
    const parent = group.parent;
    staging.add(group);
    const was = group.visible;
    group.visible = true;
    const parallel = renderer.compileAsync && renderer.extensions.has('KHR_parallel_shader_compile');
    try {
      for (const twins of [true, false]) {
        for (const m of meshes) { m.mesh.visible = true; if (m.twin) m.mesh.material = twins ? m.twin : m.solid; }
        if (parallel) await renderer.compileAsync(staging, camera, scene);
        else renderer.compile(staging, camera, scene);
      }
    } catch { /* compiles on first draw instead */ }
    group.visible = was;
    lastKey = '';
    if (parent) parent.add(group); else staging.remove(group);
  }

  function dispose() {
    disposeTree(group);
    for (const m of meshes) { if (m.twin) m.twin.dispose(); if (m.mesh.isInstancedMesh) m.mesh.dispose(); }
    layerTex.dispose();
  }

  update(PARAMS, 0);
  return { group, update, compile, dispose, front: LAYERS[0].zf, back: LAYERS[N - 1].zb };
}
