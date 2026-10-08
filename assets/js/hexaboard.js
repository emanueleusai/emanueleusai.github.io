/* ==========================================================================
   hexaboard.js: a procedural CMS HGCAL silicon module and a detector layer.

   Everything is built in code: geometry from extruded outlines, textures
   painted on <canvas> (CanvasTexture), no external assets.

   Units are meters. A module lies in the XY plane, centered on the origin,
   with its front (the hexaboard and its chips) facing +z. The hexagon is
   "pointy-top": two corners on the ±y axis, flat edges facing ±x.

   Stack, back (-z) to front (+z), real thicknesses:
     baseplate      1.40 mm   copper-tungsten, dark metal
     Kapton         0.12 mm   gold-plated polyimide (bias contact + insulation)
     silicon sensor 0.32 mm   hexagonal cells (low-density layout, ~192 cells)
     hexaboard PCB  1.60 mm   wire-bond holes over the cell corners, gold pads
     HGCROC chips   1.30 mm   three readout chips (they lift as their own layer)

   export createModule(opts) -> { group, setExplode(t), update(dt), layers, dispose() }
   export createLayer(opts)  -> { group, count, dispose() }
   ========================================================================== */

import * as THREE from 'three';

const MM = 0.001;
const SQ3 = Math.sqrt(3);
const NOMINAL_SIZE = 0.167;            // m, flat-to-flat of the module (8-inch wafer)
const TEX_SPAN = 200;                  // mm covered by every board texture (square, centered)
const CHAMFER = 4.5;                   // mm cut at each of the six corners
const DIM = { base: 167.0, kapton: 166.8, sensor: 166.4, pcb: 165.8 };   // flat-to-flat, mm
const THK = { base: 1.4, kapton: 0.12, sensor: 0.32, pcb: 1.6, glue: 0.05, chip: 1.3 };
const HOLE_R = 1.2;                    // wire-bond hole radius, mm
const RING_R = 2.3;                    // gold bond-pad ring outer radius, mm

/* ---------- small utilities ---------- */

function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };

/* Pointy-top hexagon with chamfered corners, CCW, 12 points (mm). */
function hexOutline(flat, chamfer = CHAMFER) {
  const R = flat / SQ3;
  const V = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 3;
    V.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  const f = chamfer / R;
  const out = [];
  for (let k = 0; k < 6; k++) {
    const v = V[k], p = V[(k + 5) % 6], n = V[(k + 1) % 6];
    out.push([v[0] + (p[0] - v[0]) * f, v[1] + (p[1] - v[1]) * f]);
    out.push([v[0] + (n[0] - v[0]) * f, v[1] + (n[1] - v[1]) * f]);
  }
  return out;
}

/* Signed distance to the boundary of a convex CCW polygon (positive inside). */
function insetDist(poly, x, y) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    d = Math.min(d, (ex * (y - ay) - ey * (x - ax)) / len);
  }
  return d;
}

function circlePts(x, y, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return pts;
}

function inRect(rect, x, y, margin = 0) {
  const c = Math.cos(-rect.rot), s = Math.sin(-rect.rot);
  const dx = x - rect.x, dy = y - rect.y;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) < rect.w / 2 + margin && Math.abs(ly) < rect.h / 2 + margin;
}

function toBoard(rect, lx, ly) {
  const c = Math.cos(rect.rot), s = Math.sin(rect.rot);
  return [rect.x + lx * c - ly * s, rect.y + lx * s + ly * c];
}

/* ==========================================================================
   Board layout (mm): cells, wire-bond holes, components. Shared by the
   sensor texture, the PCB texture, the 3D parts and the wire bonds so that
   they all line up.
   ========================================================================== */

const layoutCache = new Map();

function boardLayout(kind = 'LD', seed = 11) {
  const key = kind + seed;
  if (layoutCache.has(key)) return layoutCache.get(key);
  const rand = mulberry32(seed);
  const LD = kind !== 'HD';
  // Cell circumradius: 192 cells (LD) or 432 cells (HD) on an 8-inch hexagon.
  const r = LD ? 6.93 : 4.62;
  const f = r * SQ3;
  const pcb = hexOutline(DIM.pcb);
  const sensor = hexOutline(DIM.sensor);

  /* --- components --- */
  const chips = [];
  const nChips = LD ? 3 : 6;
  for (let k = 0; k < nChips; k++) {
    const a = LD ? Math.PI / 2 + (k * 2 * Math.PI) / 3 : Math.PI / 6 + (k * Math.PI) / 3;
    const rc = LD ? 48 : 58;
    chips.push({ x: rc * Math.cos(a), y: rc * Math.sin(a), w: 16, h: 16, rot: a - Math.PI / 2 });
  }
  const connectors = LD
    ? [
        { x: 0, y: 22, w: 28, h: 5, rot: 0, tall: 3.0 },
        { x: 0, y: -8, w: 28, h: 5, rot: 0, tall: 3.0 },
        { x: -24, y: 7, w: 11, h: 4.2, rot: Math.PI / 2, tall: 2.6 },
      ]
    : [
        { x: 0, y: 13, w: 28, h: 5, rot: 0, tall: 4.2 },
        { x: 0, y: -13, w: 28, h: 5, rot: 0, tall: 4.2 },
        { x: -27, y: 0, w: 11, h: 4.2, rot: Math.PI / 2, tall: 3.4 },
      ];
  const ics = LD
    ? [
        { x: -24, y: 35, w: 5, h: 5, rot: 0 },
        { x: 24, y: 36, w: 5, h: 5, rot: 0 },
        { x: 36, y: -2, w: 4, h: 4, rot: Math.PI / 4 },
        { x: -38, y: -6, w: 4, h: 4, rot: 0 },
        { x: 0, y: -31, w: 6, h: 6, rot: Math.PI / 6 },
      ]
    : [
        { x: 30, y: 26, w: 5, h: 5, rot: 0 },
        { x: -30, y: -26, w: 5, h: 5, rot: 0 },
        { x: 0, y: 34, w: 4, h: 4, rot: Math.PI / 4 },
        { x: 0, y: -34, w: 6, h: 6, rot: Math.PI / 6 },
      ];
  const power = LD ? { x: 18, y: -61, w: 8, h: 11, rot: 0 } : { x: 66, y: -12, w: 8, h: 11, rot: 0 };
  const sticker = LD ? { x: -21, y: -56, w: 13, h: 9, rot: 0 } : { x: -64, y: 12, w: 13, h: 9, rot: Math.PI / 2 };
  const testPads = [];
  for (let i = 0; i < 4; i++) testPads.push({ x: -77.5, y: -7.5 + i * 5, w: 1.6, h: 3.0, rot: 0 });

  const keepouts = [
    ...chips.map((c) => ({ ...c, m: 2.6 })),
    ...connectors.map((c) => ({ ...c, m: 1.8 })),
    ...ics.map((c) => ({ ...c, m: 1.8 })),
    { ...power, m: 1.6 },
    { ...sticker, m: 1.2 },
    ...testPads.map((c) => ({ ...c, m: 1.0 })),
  ];
  const blocked = (x, y, extra = 0) => keepouts.some((k) => inRect(k, x, y, k.m + extra));

  /* --- sensor cells (flat-top hexagons, rotated 30° with respect to the wafer) --- */
  const cells = [];
  const nI = Math.ceil(100 / (1.5 * r)) + 1, nJ = Math.ceil(100 / f) + 1;
  for (let i = -nI; i <= nI; i++) {
    for (let j = -nJ; j <= nJ; j++) {
      const x = i * 1.5 * r, y = j * f + (Math.abs(i) % 2 ? f / 2 : 0);
      const d = insetDist(sensor, x, y);
      if (d > -r) cells.push({ x, y, d, full: d >= r, verts: [] });
    }
  }
  const vmap = new Map();
  const verts = [];
  cells.forEach((c, ci) => {
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const vx = c.x + r * Math.cos(a), vy = c.y + r * Math.sin(a);
      const key = Math.round(vx * 20) + ',' + Math.round(vy * 20);
      let v = vmap.get(key);
      if (!v) { v = { x: vx, y: vy, cells: [] }; vmap.set(key, v); verts.push(v); }
      v.cells.push(ci);
      c.verts.push(v);
    }
  });

  /* --- wire-bond holes: a greedy cover so every cell can be bonded through a nearby hole --- */
  const allowed = (v) => insetDist(pcb, v.x, v.y) > RING_R + 1.8 && !blocked(v.x, v.y, RING_R);
  const order = cells.map((_, i) => i).filter((i) => cells[i].d > -r * 0.4);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const covered = new Uint8Array(cells.length);
  const holes = [];
  for (const ci of order) {
    if (covered[ci]) continue;
    let best = null, bestScore = -1;
    for (const v of cells[ci].verts) {
      if (v.hole || !allowed(v)) continue;
      const score = v.cells.filter((k) => !covered[k] && cells[k].d > -r * 0.4).length + rand() * 0.9;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best) continue;
    best.hole = true;
    holes.push(best);
    for (const k of best.cells) covered[k] = 1;
  }
  // Bond pads: one per neighbouring cell, just inside the hole.
  for (const h of holes) {
    h.pads = h.cells
      .filter((ci) => cells[ci].d > -r * 0.6)
      .map((ci) => {
        const c = cells[ci];
        const dx = c.x - h.x, dy = c.y - h.y, l = Math.hypot(dx, dy);
        return { dx: dx / l, dy: dy / l };
      });
  }
  const nearHole = (x, y, dist) => holes.some((h) => (h.x - x) ** 2 + (h.y - y) ** 2 < dist * dist);

  /* --- vias near cell centers --- */
  const vias = [];
  for (const c of cells) {
    const x = c.x + (rand() - 0.5) * 2.4, y = c.y + (rand() - 0.5) * 2.4;
    if (insetDist(pcb, x, y) < 2.5 || nearHole(x, y, 3.4) || blocked(x, y, 0.6)) continue;
    vias.push({ x, y });
  }

  /* --- passives (3D boxes on the board and pads in the texture) --- */
  const passives = [];
  const freeSpot = (x, y, clear) =>
    insetDist(pcb, x, y) > 2.5 && !nearHole(x, y, RING_R + clear) && !blocked(x, y, 0.4) &&
    !passives.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < 2.6 * 2.6);
  const tryPassive = (x, y, rot, type) => {
    if (!freeSpot(x, y, 1.4)) return;
    const big = type === 'big';
    passives.push({
      x, y, rot,
      w: big ? 3.2 : type === 'small' ? 1.6 : 2.0,
      h: big ? 1.6 : type === 'small' ? 0.8 : 1.25,
      d: big ? 1.1 : type === 'small' ? 0.45 : 0.6,
      res: type === 'res',
    });
  };
  for (const c of chips) {
    for (let s = 0; s < 4; s++) {
      for (const t of [-5, -1.6, 1.8, 5.2]) {
        if (rand() < 0.3) continue;
        const ang = (s * Math.PI) / 2;
        const lx = Math.cos(ang) * (c.w / 2 + 2.2) - Math.sin(ang) * t;
        const ly = Math.sin(ang) * (c.w / 2 + 2.2) + Math.cos(ang) * t;
        const [x, y] = toBoard(c, lx, ly);
        tryPassive(x, y, c.rot + ang + Math.PI / 2, rand() < 0.25 ? 'res' : rand() < 0.5 ? 'small' : 'std');
      }
    }
  }
  for (const ic of ics) {
    for (let s = 0; s < 3; s++) {
      const ang = rand() * Math.PI * 2;
      tryPassive(ic.x + Math.cos(ang) * 5, ic.y + Math.sin(ang) * 5, ic.rot + (s % 2) * Math.PI / 2, rand() < 0.4 ? 'res' : 'std');
    }
  }
  tryPassive(power.x - 9, power.y + 1, Math.PI / 2, 'big');
  tryPassive(power.x - 9, power.y - 4, Math.PI / 2, 'big');
  tryPassive(power.x + 1, power.y + 9, 0, 'big');
  for (let n = 0; n < 160 && passives.length < (LD ? 70 : 60); n++) {
    const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * 80;
    const rot = Math.round(rand() * 5) * (Math.PI / 6);
    tryPassive(Math.cos(a) * rr, Math.sin(a) * rr, rot, rand() < 0.35 ? 'res' : rand() < 0.6 ? 'std' : 'small');
  }

  /* --- calibration-cell markers (large silkscreen circles) --- */
  const circles = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 + (LD ? 0 : Math.PI / 6);
    const tx = Math.cos(a) * (LD ? 62 : 40), ty = Math.sin(a) * (LD ? 62 : 40);
    let best = null, bd = Infinity;
    for (const c of cells) {
      const d = (c.x - tx) ** 2 + (c.y - ty) ** 2;
      if (d < bd && c.full && !blocked(c.x, c.y, 3)) { bd = d; best = c; }
    }
    if (best) circles.push({ x: best.x, y: best.y, r: r * 0.98 });
  }

  const layout = { kind: LD ? 'LD' : 'HD', r, cells, holes, vias, chips, connectors, ics, power, sticker, testPads, passives, circles, pcb, sensor };
  layoutCache.set(key, layout);
  return layout;
}

/* ==========================================================================
   Canvas painting
   ========================================================================== */

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/* A 2D context whose user space is board millimeters, y up, origin at the center. */
function boardContext(canvas) {
  const ctx = canvas.getContext('2d');
  const k = canvas.width / TEX_SPAN;
  ctx.setTransform(k, 0, 0, -k, canvas.width / 2, canvas.height / 2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return ctx;
}

function polyPath(ctx, pts, close = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

function addHex(ctx, x, y, r, rot = 0) {
  for (let k = 0; k <= 6; k++) {
    const a = rot + (k * Math.PI) / 3;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
}

function rectPath(ctx, rect, grow = 0) {
  const hw = rect.w / 2 + grow, hh = rect.h / 2 + grow;
  polyPath(ctx, [toBoard(rect, -hw, -hh), toBoard(rect, hw, -hh), toBoard(rect, hw, hh), toBoard(rect, -hw, hh)]);
}

/* Text in board coordinates, drawn in pixel space so tiny sizes stay crisp. */
function boardText(ctx, str, x, y, sizeMM, color, rot = 0, align = 'center') {
  const k = ctx.canvas.width / TEX_SPAN;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(ctx.canvas.width / 2 + x * k, ctx.canvas.height / 2 - y * k);
  ctx.rotate(-rot);
  ctx.font = `600 ${Math.max(4, sizeMM * k)}px "DejaVu Sans Mono", Menlo, Consolas, monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

/* A deterministic 2D "data matrix" pattern (no real data). */
function dataMatrix(ctx, x, y, size, n, color, rand) {
  const m = size / n;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const border = i === 0 || j === n - 1;
      const clock = (j === 0 && i % 2 === 0) || (i === n - 1 && j % 2 === 0);
      if (border || clock || (i > 0 && j > 0 && i < n - 1 && j < n - 1 && rand() < 0.5)) {
        ctx.fillRect(x + i * m, y + j * m, m * 1.02, m * 1.02);
      }
    }
  }
}

function mottle(ctx, rand, count, rMin, rMax, rgb, alpha) {
  for (let i = 0; i < count; i++) {
    const x = (rand() - 0.5) * TEX_SPAN, y = (rand() - 0.5) * TEX_SPAN;
    const r = rMin + rand() * (rMax - rMin);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${alpha * (0.4 + rand() * 0.6)})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}

/* Color palette and the matching roughness/metalness palette (G = roughness, B = metalness). */
const orm = (rough, metal) => `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
const PCB_PAL = {
  color: {
    edge: '#77744a', mask: '#126535', cellLine: 'rgba(120,214,120,0.5)', trace: 'rgba(110,205,110,0.28)',
    silk: 'rgba(236,242,232,0.7)', gold: '#d8b562', goldHi: '#f3dc96', goldLo: '#9c7a35', hole: '#10151b',
    pad: '#cfd2cc', via: '#173f26', viaRing: '#5aa56a', bga: '#bfc3bd', pasteDark: 'rgba(0,25,10,0.35)',
    sticker: '#f2f2ee', stickerInk: '#30343a',
  },
  orm: {
    edge: orm(0.85, 0), mask: orm(0.56, 0), cellLine: orm(0.5, 0.05), trace: orm(0.45, 0),
    silk: orm(0.8, 0), gold: orm(0.26, 0.55), goldHi: orm(0.22, 0.55), goldLo: orm(0.35, 0.5), hole: orm(0.9, 0),
    pad: orm(0.3, 0.5), via: orm(0.6, 0), viaRing: orm(0.4, 0.3), bga: orm(0.3, 0.5), pasteDark: orm(0.5, 0),
    sticker: orm(0.75, 0), stickerInk: orm(0.7, 0),
  },
};

/*
 * Paint the top of a hexaboard.
 *   mode 'color'  : the module's PCB (holes are real geometry; chips and connectors are 3D)
 *   mode 'orm'    : roughness / metalness for the module's PCB
 *   mode 'layer'  : a module seen from the front in the detector layer (chips painted, dark rim)
 */
function paintHexaboard(canvas, L, mode) {
  const isOrm = mode === 'orm';
  const isLayer = mode === 'layer';
  const P = isOrm ? PCB_PAL.orm : PCB_PAL.color;
  const rand = mulberry32(L.kind === 'LD' ? 101 : 202);
  const ctx = boardContext(canvas);
  const px = TEX_SPAN / canvas.width; // mm per pixel

  // Background beyond the board: the FR4 edge color (side walls sample it), or the dark module rim.
  ctx.fillStyle = isLayer ? '#16191c' : P.edge;
  ctx.fillRect(-TEX_SPAN, -TEX_SPAN, 2 * TEX_SPAN, 2 * TEX_SPAN);
  if (isLayer) {
    polyPath(ctx, hexOutline(DIM.base));
    ctx.fillStyle = '#34312d';
    ctx.fill();
    polyPath(ctx, hexOutline(DIM.kapton));
    ctx.fillStyle = '#8a6a32';
    ctx.fill();
    polyPath(ctx, hexOutline(DIM.sensor));
    ctx.fillStyle = '#2b333d';
    ctx.fill();
  }

  ctx.save();
  polyPath(ctx, L.pcb);
  ctx.clip();
  ctx.fillStyle = P.mask;
  ctx.fillRect(-TEX_SPAN, -TEX_SPAN, 2 * TEX_SPAN, 2 * TEX_SPAN);

  if (!isOrm) {
    // Copper pours under the solder mask: some cells a touch lighter or darker, plus soft mottling.
    for (const c of L.cells) {
      const v = rand();
      if (v > 0.32) continue;
      ctx.beginPath();
      addHex(ctx, c.x, c.y, L.r - 0.2);
      ctx.fillStyle = v < 0.16 ? 'rgba(6,40,18,0.22)' : 'rgba(120,200,120,0.10)';
      ctx.fill();
    }
    mottle(ctx, rand, 26, 18, 60, '120,220,120', 0.06);
    mottle(ctx, rand, 20, 14, 50, '0,30,12', 0.14);
  }

  // Hexagonal cell outlines (copper under the mask, they trace the sensor cells below).
  ctx.beginPath();
  for (const c of L.cells) addHex(ctx, c.x, c.y, L.r);
  ctx.strokeStyle = P.cellLine;
  ctx.lineWidth = Math.max(0.26, px * 1.1);
  ctx.stroke();

  // Calibration-cell circles.
  ctx.beginPath();
  for (const c of L.circles) { ctx.moveTo(c.x + c.r, c.y); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); }
  ctx.stroke();

  // Signal traces: fan-outs from each readout chip toward nearby bond holes, and buses to the connectors.
  ctx.strokeStyle = P.trace;
  ctx.lineWidth = Math.max(0.2, px * 0.9);
  ctx.beginPath();
  for (const chip of L.chips) {
    const near = L.holes
      .map((h) => ({ h, d: Math.hypot(h.x - chip.x, h.y - chip.y) }))
      .filter((o) => o.d < 36)
      .sort((a, b) => a.d - b.d)
      .slice(0, 16);
    near.forEach(({ h }, idx) => {
      const c = Math.cos(-chip.rot), s = Math.sin(-chip.rot);
      const lx = (h.x - chip.x) * c - (h.y - chip.y) * s, ly = (h.x - chip.x) * s + (h.y - chip.y) * c;
      let sx, sy, ox, oy;
      if (Math.abs(lx) > Math.abs(ly)) { sx = Math.sign(lx) * 8; sy = Math.max(-6.5, Math.min(6.5, ly * 0.45 + ((idx % 3) - 1) * 0.6)); ox = Math.sign(lx); oy = 0; }
      else { sy = Math.sign(ly) * 8; sx = Math.max(-6.5, Math.min(6.5, lx * 0.45 + ((idx % 3) - 1) * 0.6)); ox = 0; oy = Math.sign(ly); }
      const a = toBoard(chip, sx, sy), b = toBoard(chip, sx + ox * 2.8, sy + oy * 2.8);
      const dx = h.x - b[0], dy = h.y - b[1], dl = Math.hypot(dx, dy);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(h.x - (dx / dl) * RING_R, h.y - (dy / dl) * RING_R);
    });
  }
  // Buses: parallel lines with a 45° jog from each chip to the closest connector end.
  for (const chip of L.chips) {
    let best = null, bd = Infinity;
    for (const con of L.connectors) {
      for (const e of [-1, 1]) {
        const p = toBoard(con, (e * con.w) / 2, 0);
        const d = Math.hypot(p[0] - chip.x, p[1] - chip.y);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (!best) continue;
    const ax = chip.x, ay = chip.y, bx = best[0], by = best[1];
    const ddx = bx - ax, ddy = by - ay;
    const nx = -ddy / Math.hypot(ddx, ddy), ny = ddx / Math.hypot(ddx, ddy);
    for (let n = -3; n <= 3; n++) {
      const o = n * 0.5;
      let mx, my;
      if (Math.abs(ddx) > Math.abs(ddy)) { mx = bx - Math.sign(ddx) * Math.abs(ddy); my = ay; }
      else { mx = ax; my = by - Math.sign(ddy) * Math.abs(ddx); }
      ctx.moveTo(ax + nx * o, ay + ny * o);
      ctx.lineTo(mx + nx * o, my + ny * o);
      ctx.lineTo(bx + nx * o, by + ny * o);
    }
  }
  ctx.stroke();

  // Edge ground ring (thin gold line just inside the board edge).
  polyPath(ctx, hexOutline(DIM.pcb - 1.8, CHAMFER - 0.4));
  ctx.strokeStyle = P.gold;
  ctx.lineWidth = Math.max(0.45, px * 1.2);
  ctx.stroke();

  // Vias.
  for (const v of L.vias) {
    ctx.beginPath(); ctx.arc(v.x, v.y, 0.62, 0, Math.PI * 2); ctx.fillStyle = P.viaRing; ctx.fill();
    ctx.beginPath(); ctx.arc(v.x, v.y, 0.32, 0, Math.PI * 2); ctx.fillStyle = P.via; ctx.fill();
  }

  // Readout chips: BGA footprint on the module (chip is 3D), painted packages in the layer.
  for (const chip of L.chips) {
    if (isLayer) {
      rectPath(ctx, chip, 0.4); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      rectPath(ctx, chip); ctx.fillStyle = '#17191c'; ctx.fill();
      const lab = { ...chip, w: 6, h: 6 };
      const [lx, ly] = toBoard(chip, -3.6, 3.6);
      rectPath(ctx, { ...lab, x: lx, y: ly }); ctx.fillStyle = '#6f757c'; ctx.fill();
    } else {
      rectPath(ctx, chip, 0.3);
      ctx.fillStyle = P.pasteDark;
      ctx.fill();
      ctx.fillStyle = P.bga;
      ctx.beginPath();
      for (let i = 0; i < 15; i++) {
        for (let j = 0; j < 15; j++) {
          if (i > 4 && i < 10 && j > 4 && j < 10 && (i + j) % 2) continue;
          const [x, y] = toBoard(chip, -7 + i, -7 + j);
          ctx.moveTo(x + 0.27, y);
          ctx.arc(x, y, 0.27, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    // Silkscreen corner brackets and a pin-1 dot.
    ctx.strokeStyle = P.silk;
    ctx.lineWidth = Math.max(0.22, px);
    ctx.beginPath();
    const g = chip.w / 2 + 1.0, l = 2.6;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const a = toBoard(chip, sx * g, sy * (g - l)), b = toBoard(chip, sx * g, sy * g), c = toBoard(chip, sx * (g - l), sy * g);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]);
    }
    ctx.stroke();
    const [dx, dy] = toBoard(chip, -g - 0.9, g + 0.9);
    ctx.beginPath(); ctx.arc(dx, dy, 0.45, 0, Math.PI * 2); ctx.fillStyle = P.silk; ctx.fill();
    // Exposed test-pad clusters along two sides of each chip.
    ctx.fillStyle = P.pad;
    for (const side of [0, 1]) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 2; j++) {
          const along = -5.4 + i * 1.3, out = chip.w / 2 + 1.9 + j * 1.15;
          const [x, y] = side ? toBoard(chip, along, -out) : toBoard(chip, -out, along);
          if (L.holes.some((h) => (h.x - x) ** 2 + (h.y - y) ** 2 < (RING_R + 0.6) ** 2)) continue;
          ctx.fillRect(x - 0.33, y - 0.33, 0.66, 0.66);
        }
      }
    }
  }

  // Connectors: gold pad rows on the module, bodies in the layer.
  for (const con of L.connectors) {
    if (isLayer) {
      rectPath(ctx, con); ctx.fillStyle = '#cdbb92'; ctx.fill();
      rectPath(ctx, { ...con, w: con.w - 2, h: con.h * 0.34 }); ctx.fillStyle = '#3a342a'; ctx.fill();
    } else {
      ctx.fillStyle = P.gold;
      const n = Math.round(con.w / 0.8);
      for (let i = 0; i < n; i++) {
        for (const s of [-1, 1]) {
          const [x, y] = toBoard(con, -con.w / 2 + 0.6 + i * ((con.w - 1.2) / (n - 1)), s * (con.h / 2 - 0.3));
          ctx.beginPath(); ctx.arc(x, y, 0.22, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    rectPath(ctx, con, 0.9);
    ctx.strokeStyle = P.silk;
    ctx.lineWidth = Math.max(0.2, px);
    ctx.stroke();
  }

  // Small ICs (regulators, sensors): perimeter pads on the module, black packages in the layer.
  for (const ic of L.ics) {
    if (isLayer) {
      rectPath(ctx, ic); ctx.fillStyle = '#1c1e21'; ctx.fill();
    } else {
      rectPath(ctx, ic, 0.15); ctx.fillStyle = P.pad; ctx.fill();
      rectPath(ctx, ic, -0.55); ctx.fillStyle = P.mask; ctx.fill();
      rectPath(ctx, ic, -1.1); ctx.fillStyle = P.pad; ctx.fill();
    }
    const [dx, dy] = toBoard(ic, -ic.w / 2 - 1, ic.h / 2 + 1);
    ctx.beginPath(); ctx.arc(dx, dy, 0.35, 0, Math.PI * 2); ctx.fillStyle = P.silk; ctx.fill();
  }

  // Power connector footprint / body.
  rectPath(ctx, L.power, isLayer ? 0 : 0.6);
  ctx.fillStyle = isLayer ? '#b9b7b0' : P.pad;
  ctx.fill();
  if (!isLayer) { rectPath(ctx, L.power, -0.6); ctx.fillStyle = P.mask; ctx.fill(); }
  rectPath(ctx, L.power, 1.2);
  ctx.strokeStyle = P.silk;
  ctx.stroke();

  // Passive component pads (module) or the parts themselves (layer).
  for (const p of L.passives) {
    if (isLayer) {
      rectPath(ctx, p); ctx.fillStyle = p.res ? '#1d1d1d' : '#b09668'; ctx.fill();
    } else {
      for (const s of [-1, 1]) {
        const [x, y] = toBoard(p, (s * p.w) / 2 * 0.72, 0);
        rectPath(ctx, { x, y, w: p.w * 0.42, h: p.h * 1.12, rot: p.rot });
        ctx.fillStyle = P.pad;
        ctx.fill();
      }
    }
  }

  // Test pads along the left flat.
  ctx.fillStyle = P.gold;
  for (const t of L.testPads) { rectPath(ctx, t); ctx.fill(); }

  // Wire-bond holes: gold bond-pad rings around the opening.
  for (const h of L.holes) {
    if (!isOrm) {
      ctx.beginPath(); ctx.arc(h.x, h.y, RING_R + 0.35, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,20,8,0.35)'; ctx.fill();
      const g = ctx.createRadialGradient(h.x - 0.5, h.y + 0.6, 0.2, h.x, h.y, RING_R);
      g.addColorStop(0, P.goldHi); g.addColorStop(0.6, P.gold); g.addColorStop(1, P.goldLo);
      ctx.fillStyle = g;
    } else ctx.fillStyle = P.gold;
    ctx.beginPath(); ctx.arc(h.x, h.y, RING_R, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(h.x, h.y, HOLE_R + (isLayer ? 0.1 : 0.05), 0, Math.PI * 2);
    ctx.fillStyle = isLayer ? '#1a2029' : P.hole;
    ctx.fill();
    if (isLayer) {
      ctx.beginPath(); ctx.arc(h.x, h.y, 0.45, 0, Math.PI * 2); ctx.fillStyle = '#8d96a3'; ctx.fill();
    }
  }

  // Silkscreen: channel numbers beside most holes, the board flavour near the bottom edge.
  if (!isOrm) {
    L.holes.forEach((h, i) => {
      if (i % 5 === 3) return;
      const ox = h.x + 3.3, oy = h.y + 2.4;
      if (insetDist(L.pcb, ox, oy) < 3 || L.chips.some((c) => inRect(c, ox, oy, 2))) return;
      boardText(ctx, String(i + 1), ox, oy, 1.1, P.silk, 0, 'left');
    });
    boardText(ctx, L.kind === 'LD' ? 'LD FULL' : 'HD FULL', 52, -58, 2.2, P.silk, Math.PI / 6);
  }

  // QC barcode sticker.
  rectPath(ctx, L.sticker);
  ctx.fillStyle = isLayer ? '#c4c4be' : P.sticker;
  ctx.fill();
  if (!isOrm) {
    ctx.save();
    ctx.translate(L.sticker.x, L.sticker.y);
    ctx.rotate(L.sticker.rot);
    dataMatrix(ctx, -5.6, -3.4, 6.8, 14, P.stickerInk, mulberry32(L.kind === 'LD' ? 5 : 6));
    ctx.fillStyle = P.stickerInk;
    for (let i = 0; i < 3; i++) ctx.fillRect(2.2, 1.6 - i * 2.0, 3.6 - i * 0.7, 0.7);
    ctx.restore();
  }

  ctx.restore();
  return canvas;
}

/* Silicon sensor: cell metallization, guard rings, bond pads at every hole. */
function paintSensor(canvas, L) {
  const ctx = boardContext(canvas);
  const rand = mulberry32(77);
  ctx.fillStyle = '#1d232b';
  ctx.fillRect(-TEX_SPAN, -TEX_SPAN, 2 * TEX_SPAN, 2 * TEX_SPAN);
  ctx.save();
  polyPath(ctx, L.sensor);
  ctx.clip();
  ctx.fillStyle = '#141a22';
  ctx.fillRect(-TEX_SPAN, -TEX_SPAN, 2 * TEX_SPAN, 2 * TEX_SPAN);
  // Clip the cell area to inside the guard rings.
  ctx.save();
  polyPath(ctx, hexOutline(DIM.sensor - 4.2, CHAMFER - 1.2));
  ctx.clip();
  for (const c of L.cells) {
    const v = rand();
    const l = 34 + v * 9;
    ctx.fillStyle = `rgb(${l - 4},${l + 6},${l + 20})`;
    ctx.beginPath();
    addHex(ctx, c.x, c.y, L.r - 0.2);
    ctx.fill();
  }
  ctx.restore();
  // Guard rings.
  ctx.strokeStyle = 'rgba(150,168,192,0.55)';
  ctx.lineWidth = 0.18;
  for (const inset of [0.7, 1.15, 1.6, 2.05]) {
    polyPath(ctx, hexOutline(DIM.sensor - 2 * inset, CHAMFER - inset * 0.6));
    ctx.stroke();
  }
  // Calibration cells: a small hexagonal pad inside a few regular cells.
  ctx.strokeStyle = '#10151c';
  ctx.lineWidth = 0.22;
  for (const c of L.circles) { ctx.beginPath(); addHex(ctx, c.x, c.y, L.r * 0.36); ctx.stroke(); }
  // Bond pads under each wire-bond hole (the area the bonding tool reaches through the board).
  for (const h of L.holes) {
    ctx.beginPath(); ctx.arc(h.x, h.y, HOLE_R * 0.95, 0, Math.PI * 2); ctx.fillStyle = '#4f5d70'; ctx.fill();
    ctx.fillStyle = '#d3d9e1';
    for (const p of h.pads) {
      rectPath(ctx, { x: h.x + p.dx * 0.62, y: h.y + p.dy * 0.62, w: 0.75, h: 0.5, rot: Math.atan2(p.dy, p.dx) });
      ctx.fill();
    }
  }
  // Mirror-like sheen: a broad diagonal gradient.
  const g = ctx.createLinearGradient(-90, 90, 90, -90);
  g.addColorStop(0, 'rgba(200,215,255,0.10)');
  g.addColorStop(0.45, 'rgba(200,215,255,0.0)');
  g.addColorStop(0.7, 'rgba(120,140,190,0.07)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(-TEX_SPAN, -TEX_SPAN, 2 * TEX_SPAN, 2 * TEX_SPAN);
  // Alignment fiducials in three corners.
  ctx.strokeStyle = 'rgba(190,200,215,0.7)';
  ctx.lineWidth = 0.2;
  for (let k = 0; k < 3; k++) {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / 3;
    const R = DIM.sensor / SQ3 - 9;
    const x = R * Math.cos(a), y = R * Math.sin(a);
    ctx.beginPath(); ctx.moveTo(x - 1.2, y); ctx.lineTo(x + 1.2, y); ctx.moveTo(x, y - 1.2); ctx.lineTo(x, y + 1.2); ctx.stroke();
  }
  ctx.restore();
  return canvas;
}

/* Copper-tungsten baseplate: brushed dark metal, mounting holes. */
function paintBaseplate(canvas) {
  const ctx = boardContext(canvas);
  const rand = mulberry32(31);
  ctx.fillStyle = '#2f2b28';
  ctx.fillRect(-TEX_SPAN, -TEX_SPAN, 2 * TEX_SPAN, 2 * TEX_SPAN);
  // Brushed grain, in pixel space.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const W = canvas.width;
  for (let i = 0; i < 1400; i++) {
    const y = rand() * W, x = rand() * W, len = 20 + rand() * 160;
    ctx.strokeStyle = rand() < 0.5 ? `rgba(255,236,215,${0.02 + rand() * 0.035})` : `rgba(0,0,0,${0.05 + rand() * 0.08})`;
    ctx.lineWidth = 0.6 + rand();
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + (rand() - 0.5) * 2); ctx.stroke();
  }
  // A uniform patch in the corner, sampled by the side walls.
  ctx.fillStyle = '#34302c';
  ctx.fillRect(0, 0, 24, 24);
  ctx.restore();
  // Mounting holes near alternate corners and one at the center.
  for (const [x, y] of [[0, 0], ...[0, 1, 2].map((k) => { const a = Math.PI / 2 + (k * 2 * Math.PI) / 3 + Math.PI / 3; return [72 * Math.cos(a), 72 * Math.sin(a)]; })]) {
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fillStyle = '#6b645d'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 1.7, 0, Math.PI * 2); ctx.fillStyle = '#0d0c0b'; ctx.fill();
  }
  return canvas;
}

/* Component atlas: chip tops, package sides, connectors, passive strips. Canvas pixels, y down. */
const ATLAS = 512;
const REG = {
  chipTop: [0, 0, 256, 256],
  pkgSide: [264, 4, 380, 28],
  qfnTop: [264, 40, 328, 104],
  capStrip: [264, 112, 392, 136],
  resStrip: [264, 144, 392, 168],
  conTop: [0, 264, 512, 328],
  conSide: [0, 336, 512, 368],
  pwrTop: [0, 376, 128, 504],
  pwrSide: [136, 376, 264, 440],
};

function paintAtlas(canvas) {
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(9);
  ctx.fillStyle = '#202226';
  ctx.fillRect(0, 0, ATLAS, ATLAS);

  // HGCROC package top: black mold, laser-marked 2D code and marking lines.
  {
    const [x0, y0, x1, y1] = REG.chipTop, w = x1 - x0;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#24272c'); g.addColorStop(1, '#15171a');
    ctx.fillStyle = g; ctx.fillRect(x0, y0, w, w);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 4; ctx.strokeRect(x0 + 2, y0 + 2, w - 4, w - 4);
    dataMatrix(ctx, x0 + 30, y0 + 30, 76, 18, '#8b9198', rand);
    ctx.fillStyle = '#7d838a';
    ctx.font = '600 25px "DejaVu Sans", Arial, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('HGCROC', x0 + 30, y0 + 128);
    for (let i = 0; i < 3; i++) ctx.fillRect(x0 + 30, y0 + 168 + i * 18, 150 - i * 34, 7);
    ctx.strokeStyle = '#7d838a'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(x0 + 176, y0 + 68, 28, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke();
    ctx.beginPath(); ctx.arc(x0 + 26, y0 + w - 26, 7, 0, Math.PI * 2); ctx.fillStyle = '#0c0d0f'; ctx.fill();
  }
  // Package side.
  { const [x0, y0, x1, y1] = REG.pkgSide; ctx.fillStyle = '#1b1d21'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
  // Small IC (QFN) top.
  {
    const [x0, y0, x1] = REG.qfnTop, w = x1 - x0;
    ctx.fillStyle = '#1e2024'; ctx.fillRect(x0, y0, w, w);
    ctx.fillStyle = '#a9adb1';
    for (let i = 0; i < 6; i++) {
      const t = 10 + i * 8.6;
      ctx.fillRect(x0 + t, y0, 4, 3); ctx.fillRect(x0 + t, y0 + w - 3, 4, 3);
      ctx.fillRect(x0, y0 + t, 3, 4); ctx.fillRect(x0 + w - 3, y0 + t, 3, 4);
    }
    ctx.fillStyle = '#5d6168'; ctx.fillRect(x0 + 14, y0 + 26, 34, 4); ctx.fillRect(x0 + 14, y0 + 36, 24, 4);
    ctx.beginPath(); ctx.arc(x0 + 12, y0 + 12, 3, 0, Math.PI * 2); ctx.fillStyle = '#0c0d0f'; ctx.fill();
  }
  // Passive strips: tinned ends, ceramic or resistive body.
  for (const [reg, body] of [[REG.capStrip, '#a98d5f'], [REG.resStrip, '#1b1b1c']]) {
    const [x0, y0, x1, y1] = reg, w = x1 - x0, h = y1 - y0;
    ctx.fillStyle = '#c9ccd0'; ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = body; ctx.fillRect(x0 + w * 0.24, y0, w * 0.52, h);
    if (body === '#1b1b1c') { ctx.fillStyle = '#d9d9d9'; ctx.fillRect(x0 + w * 0.38, y0 + h * 0.4, w * 0.24, h * 0.2); }
  }
  // Board-to-board connector: beige body, dark slot, two rows of gold contacts.
  {
    const [x0, y0, x1, y1] = REG.conTop, w = x1 - x0, h = y1 - y0;
    ctx.fillStyle = '#d6c69e'; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 3; ctx.strokeRect(x0 + 1.5, y0 + 1.5, w - 3, h - 3);
    ctx.fillStyle = '#2b2620'; ctx.fillRect(x0 + 18, y0 + h * 0.36, w - 36, h * 0.28);
    ctx.fillStyle = '#e2bb5c';
    for (let x = x0 + 22; x < x1 - 22; x += 9.2) {
      ctx.fillRect(x, y0 + h * 0.27, 4, h * 0.09);
      ctx.fillRect(x, y0 + h * 0.64, 4, h * 0.09);
    }
  }
  {
    const [x0, y0, x1, y1] = REG.conSide, w = x1 - x0, h = y1 - y0;
    ctx.fillStyle = '#c9b78c'; ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x0, y0, w, h * 0.18);
    ctx.fillStyle = '#e2bb5c';
    for (let x = x0 + 22; x < x1 - 22; x += 9.2) ctx.fillRect(x, y1 - h * 0.22, 4, h * 0.22);
  }
  // White power connector.
  {
    const [x0, y0, x1, y1] = REG.pwrTop, w = x1 - x0, h = y1 - y0;
    ctx.fillStyle = '#ebe9e3'; ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = '#3b3b3d'; ctx.fillRect(x0 + 16, y0 + 18, w - 32, h - 40);
    ctx.fillStyle = '#d7b35c'; ctx.fillRect(x0 + 34, y0 + 52, 14, 14); ctx.fillRect(x0 + w - 48, y0 + 52, 14, 14);
    ctx.fillStyle = '#d0cec8'; ctx.fillRect(x0 + 40, y0 + h - 16, w - 80, 10);
  }
  {
    const [x0, y0, x1, y1] = REG.pwrSide, w = x1 - x0, h = y1 - y0;
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#f0eee8'); g.addColorStop(1, '#c9c7c0');
    ctx.fillStyle = g; ctx.fillRect(x0, y0, w, h);
  }
  return canvas;
}

/* ==========================================================================
   Textures (cached: every module and layer shares them)
   ========================================================================== */

const texCache = new Map();

function canvasTexture(canvas, { srgb = true, anisotropy = 8, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

function cached(key, make) {
  if (!texCache.has(key)) texCache.set(key, make());
  return texCache.get(key);
}

function moduleTextures(anisotropy) {
  return cached('module', () => {
    const L = boardLayout('LD');
    return {
      pcb: canvasTexture(paintHexaboard(makeCanvas(1024), L, 'color'), { anisotropy }),
      pcbOrm: canvasTexture(paintHexaboard(makeCanvas(512), L, 'orm'), { srgb: false, anisotropy }),
      sensor: canvasTexture(paintSensor(makeCanvas(1024), L), { anisotropy }),
      base: canvasTexture(paintBaseplate(makeCanvas(512)), { anisotropy }),
      atlas: canvasTexture(paintAtlas(makeCanvas(ATLAS)), { anisotropy }),
    };
  });
}

function layerTextures(kind, edgeColor, glow, anisotropy) {
  return cached(`layer-${kind}-${edgeColor}-${glow}`, () => {
    const L = boardLayout(kind);
    const color = paintHexaboard(makeCanvas(512), L, 'layer');
    // Emissive: the board itself, dimmed (so it reads on a dark background), plus a glowing rim.
    const em = makeCanvas(512);
    const ctx = boardContext(em);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 512, 512);
    ctx.globalAlpha = glow;
    ctx.drawImage(color, 0, 0);
    ctx.restore();
    const rim = hexOutline(DIM.base - 2.2, CHAMFER - 0.6);
    polyPath(ctx, rim);
    ctx.strokeStyle = edgeColor;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 3.2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.1;
    ctx.stroke();
    return { map: canvasTexture(color, { anisotropy }), emissive: canvasTexture(em, { anisotropy }) };
  });
}

/* ==========================================================================
   Geometry helpers
   ========================================================================== */

/* Extruded slab from an outline (mm), z from 0 to depth. Caps get board-texture UVs,
   side walls (outer edge and hole walls) sample one texel at sideUV. Single group. */
function slabGeometry(outline, holes, depthMM, sideUV = [0.02, 0.5]) {
  const v2 = (pts) => pts.map(([x, y]) => new THREE.Vector2(x * MM, y * MM));
  const shape = new THREE.Shape(v2(outline));
  for (const h of holes) shape.holes.push(new THREE.Path(v2(h)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: depthMM * MM, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.clearGroups();
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  const span = TEX_SPAN * MM;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nor.getZ(i)) > 0.5) uv.setXY(i, pos.getX(i) / span + 0.5, pos.getY(i) / span + 0.5);
    else uv.setXY(i, sideUV[0], sideUV[1]);
  }
  return geo;
}

/* Merge many textured boxes into one geometry (one draw call). Each box: center x,y (mm),
   z0 (mm, bottom), size w,h,d (mm), rotation about z, atlas regions for top and sides. */
function boxesGeometry(boxes) {
  const P = [], N = [], U = [], I = [];
  const uvOf = (reg, u, v) => {
    const [x0, y0, x1, y1] = reg;
    return [(x0 + 1 + u * (x1 - x0 - 2)) / ATLAS, 1 - (y0 + 1 + (1 - v) * (y1 - y0 - 2)) / ATLAS];
  };
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w * MM, b.h * MM, b.d * MM);
    const pos = g.attributes.position, nor = g.attributes.normal, idx = g.index;
    const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
    const base = P.length / 3;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      P.push(b.x * MM + lx * c - ly * s, b.y * MM + lx * s + ly * c, (b.z0 + b.d / 2) * MM + lz);
      N.push(nx * c - ny * s, nx * s + ny * c, nz);
      const u = lx / (b.w * MM) + 0.5, v = ly / (b.h * MM) + 0.5, w = lz / (b.d * MM) + 0.5;
      let uv;
      if (nz > 0.5) uv = uvOf(b.top, u, v);
      else if (nz < -0.5) uv = uvOf(b.side, 0.5, 0.5);
      else if (Math.abs(nx) > 0.5) uv = uvOf(b.side, v, w);
      else uv = uvOf(b.side, u, w);
      U.push(uv[0], uv[1]);
    }
    for (let i = 0; i < idx.count; i++) I.push(base + idx.getX(i));
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  geo.setIndex(I);
  geo.computeBoundingSphere();
  return geo;
}

/* ==========================================================================
   createModule
   ========================================================================== */

/**
 * One HGCAL silicon module (8-inch, low-density hexaboard), centered at the origin, front toward +z.
 * @param {object} [opts]
 * @param {number} [opts.size=0.167]       flat-to-flat in meters (the model is scaled uniformly)
 * @param {number} [opts.glow=0.06]        emissive fill so the module stays readable in the dark
 * @param {number} [opts.envIntensity=0.55] envMapIntensity of the dielectric parts (metals get a bit more)
 * @param {boolean} [opts.wireBonds=true]  short wire-bond arcs in the holes (hidden once exploded)
 * @param {boolean} [opts.hits=true]       glowing "energy deposits" on the sensor cells, visible when exploded
 * @param {string} [opts.hitColor='#46e27a']
 * @param {number} [opts.explodeSpacing=0.06] total spread (m) of the stack at t = 1
 * @param {'center'|'back'} [opts.explodeAnchor='center'] keep the stack centered, or keep the baseplate fixed
 * @param {number} [opts.anisotropy=8]
 */
export function createModule(opts = {}) {
  const {
    size = NOMINAL_SIZE,
    glow = 0.06,
    envIntensity = 0.55,
    wireBonds = true,
    hits = true,
    hitColor = '#46e27a',
    explodeSpacing = 0.06,
    explodeAnchor = 'center',
    anisotropy = 8,
  } = opts;

  const L = boardLayout('LD');
  const T = moduleTextures(anisotropy);
  const disposables = [];
  const track = (x) => (disposables.push(x), x);

  const group = new THREE.Group();
  group.name = 'hgcal-module';
  const stack = new THREE.Group();
  group.add(stack);
  if (size !== NOMINAL_SIZE) group.scale.setScalar(size / NOMINAL_SIZE);

  /* --- assembled z positions (mm, bottom of each part) --- */
  const zBase = 0;
  const zKap = zBase + THK.base + THK.glue;
  const zSen = zKap + THK.kapton + THK.glue;
  const zPcb = zSen + THK.sensor + THK.glue;
  const zTop = zPcb + THK.pcb;
  const zMid = zTop / 2;
  stack.position.z = -zMid * MM;

  const mkGroup = (name, z) => { const g = new THREE.Group(); g.name = name; g.position.z = z * MM; g.userData.z0 = z * MM; stack.add(g); return g; };
  const gBase = mkGroup('baseplate', zBase);
  const gKap = mkGroup('kapton', zKap);
  const gSen = mkGroup('sensor', zSen);
  const gPcb = mkGroup('hexaboard', zPcb);
  const gChips = mkGroup('readout-chips', zTop);

  /* --- baseplate --- */
  const baseMat = track(new THREE.MeshStandardMaterial({
    map: T.base, color: 0xffffff, roughness: 0.55, metalness: 0.45, envMapIntensity: envIntensity * 1.3,
    emissive: 0xffffff, emissiveMap: T.base, emissiveIntensity: glow * 1.2,
  }));
  gBase.add(new THREE.Mesh(track(slabGeometry(hexOutline(DIM.base), [], THK.base, [0.02, 0.98])), baseMat));

  /* --- Kapton (gold-plated polyimide) --- */
  const kapMat = track(new THREE.MeshStandardMaterial({
    color: 0xa47a3c, roughness: 0.34, metalness: 0.55, envMapIntensity: envIntensity * 1.3,
    emissive: 0x3e260a, emissiveIntensity: glow * 3,
  }));
  gKap.add(new THREE.Mesh(track(slabGeometry(hexOutline(DIM.kapton), [], THK.kapton)), kapMat));

  /* --- silicon sensor --- */
  const senMat = track(new THREE.MeshStandardMaterial({
    map: T.sensor, roughness: 0.32, metalness: 0.35, envMapIntensity: envIntensity * 1.4,
    emissive: 0xffffff, emissiveMap: T.sensor, emissiveIntensity: glow * 2.5,
  }));
  gSen.add(new THREE.Mesh(track(slabGeometry(hexOutline(DIM.sensor), [], THK.sensor, [0.01, 0.01])), senMat));

  /* --- energy deposits on the sensor cells (visible in the exploded view) --- */
  let hitMesh = null, hitE = null, hitTimer = 0, hitClock = 0;
  const hitCells = L.cells.filter((c) => c.full);
  const hitRand = mulberry32(4242);
  const hitBase = new THREE.Color(hitColor);
  const hitHot = new THREE.Color(1, 0.95, 0.6);   // the densest cells run warmer, toward yellow
  const hitTmp = new THREE.Color(), hitTmp2 = new THREE.Color();
  if (hits) {
    const hexGeo = track(new THREE.CircleGeometry((L.r - 0.45) * MM, 6));
    const hitMat = track(new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    hitMesh = new THREE.InstancedMesh(hexGeo, hitMat, hitCells.length);
    hitMesh.name = 'cell-hits';
    const m = new THREE.Matrix4();
    hitCells.forEach((c, i) => {
      m.makeTranslation(c.x * MM, c.y * MM, (THK.sensor + 0.03) * MM);
      hitMesh.setMatrixAt(i, m);
      hitMesh.setColorAt(i, new THREE.Color(0, 0, 0));
    });
    hitMesh.frustumCulled = false;
    hitMesh.visible = false;
    gSen.add(hitMesh);
    hitE = new Float32Array(hitCells.length);
  }
  // A compact, electromagnetic-like shower: energy falls off with distance from the core.
  const newShower = () => {
    const a = hitRand() * Math.PI * 2, rr = Math.sqrt(hitRand()) * 62;
    const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
    const lambda = 9 + hitRand() * 6;
    hitCells.forEach((c, i) => {
      const d = Math.hypot(c.x - cx, c.y - cy);
      const e = Math.exp(-d / lambda) * (0.55 + hitRand() * 0.9);
      hitE[i] = e > 0.08 ? Math.min(1.6, e * 1.4) : (hitRand() < 0.015 ? 0.15 + hitRand() * 0.2 : 0);
    });
    hitClock = 0;
  };
  let explodeT = 0;
  const paintHits = () => {
    if (!hitMesh) return;
    const vis = smooth((explodeT - 0.35) / 0.5);
    hitMesh.visible = vis > 0.001;
    if (!hitMesh.visible) return;
    // Rise quickly, then decay.
    const env = Math.min(1, hitClock / 0.12) * Math.exp(-Math.max(0, hitClock - 0.12) / 1.1);
    const amp = vis * (0.25 + 0.75 * env);
    for (let i = 0; i < hitE.length; i++) {
      const e = hitE[i] * amp;
      hitTmp.copy(hitBase).multiplyScalar(e);
      if (hitE[i] > 1.1) hitTmp.lerp(hitTmp2.copy(hitHot).multiplyScalar(e), 0.35);
      hitMesh.setColorAt(i, hitTmp);
    }
    hitMesh.instanceColor.needsUpdate = true;
  };
  if (hits) newShower();

  /* --- hexaboard PCB with real wire-bond holes --- */
  const pcbMat = track(new THREE.MeshStandardMaterial({
    map: T.pcb, roughnessMap: T.pcbOrm, metalnessMap: T.pcbOrm, roughness: 1, metalness: 1, envMapIntensity: envIntensity,
    emissive: 0xffffff, emissiveMap: T.pcb, emissiveIntensity: glow,
  }));
  const holePolys = L.holes.map((h) => circlePts(h.x, h.y, HOLE_R, 14));
  gPcb.add(new THREE.Mesh(track(slabGeometry(L.pcb, holePolys, THK.pcb, [0.015, 0.5])), pcbMat));

  /* --- components on the board (connectors, small ICs, passives): one merged mesh --- */
  const atlasMat = track(new THREE.MeshStandardMaterial({
    map: T.atlas, roughness: 0.5, metalness: 0.12, envMapIntensity: envIntensity,
    emissive: 0xffffff, emissiveMap: T.atlas, emissiveIntensity: glow,
  }));
  const boxes = [];
  for (const c of L.connectors) boxes.push({ ...c, z0: THK.pcb, d: c.tall, top: REG.conTop, side: REG.conSide });
  for (const ic of L.ics) boxes.push({ ...ic, z0: THK.pcb, d: 0.9, top: REG.qfnTop, side: REG.pkgSide });
  boxes.push({ ...L.power, z0: THK.pcb, d: 5.8, top: REG.pwrTop, side: REG.pwrSide });
  for (const p of L.passives) {
    const strip = p.res ? REG.resStrip : REG.capStrip;
    boxes.push({ ...p, z0: THK.pcb, top: strip, side: strip });
  }
  gPcb.add(new THREE.Mesh(track(boxesGeometry(boxes)), atlasMat));

  /* --- wire bonds: short arcs from the gold ring down to the sensor pads --- */
  let bondMat = null, bonds = null;
  if (wireBonds) {
    const seg = [];
    const top = THK.pcb, sen = -THK.glue; // relative to the PCB bottom
    const bez = (t, p0, p1, p2, p3) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
    for (const h of L.holes) {
      for (const p of h.pads) {
        const rr = [1.8, 1.65, 0.62, 0.62], zz = [top, top + 0.75, top + 0.75, sen];
        let prev = null;
        for (let k = 0; k <= 8; k++) {
          const t = k / 8;
          const r = bez(t, ...rr), z = bez(t, ...zz);
          const pt = [(h.x + p.dx * r) * MM, (h.y + p.dy * r) * MM, z * MM];
          if (prev) seg.push(...prev, ...pt);
          prev = pt;
        }
      }
    }
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    bondMat = track(new THREE.LineBasicMaterial({ color: 0xd2d8e0, transparent: true, opacity: 0.9 }));
    bonds = new THREE.LineSegments(g, bondMat);
    bonds.name = 'wire-bonds';
    gPcb.add(bonds);
  }

  /* --- HGCROC readout chips (their own exploded layer) --- */
  gChips.add(new THREE.Mesh(
    track(boxesGeometry(L.chips.map((c) => ({ ...c, z0: 0, d: THK.chip, top: REG.chipTop, side: REG.pkgSide })))),
    atlasMat,
  ));

  /* --- explode --- */
  // Gaps opened above each part, as fractions of explodeSpacing (sum = 1).
  const parts = [gBase, gKap, gSen, gPcb, gChips];
  // The chips stay close to their board (they are soldered to it), the sensor gap is the widest
  // so its face, and the hits on it, show between the hexaboard and the Kapton.
  const gapFrac = [0.26, 0.24, 0.36, 0.14];
  const delays = [0.16, 0.12, 0.06, 0]; // the top of the stack leads a little

  const off = new Float64Array(parts.length);   // reused: setExplode runs every frame of a transition
  function setExplode(t) {
    explodeT = clamp01(t);
    for (let i = 0; i < gapFrac.length; i++) {
      const local = smooth((explodeT - delays[i]) / (1 - delays[i]));
      off[i + 1] = off[i] + gapFrac[i] * explodeSpacing * local;
    }
    const shift = explodeAnchor === 'back' ? 0 : off[parts.length - 1] / 2;
    for (let i = 0; i < parts.length; i++) parts[i].position.z = parts[i].userData.z0 + off[i] - shift;
    // Bonds would stretch across the gap: show them only on the assembled module. (Visibility, not
    // opacity, so a caller fading the whole module through material.opacity is not overridden.)
    if (bonds) bonds.visible = explodeT < 0.03;
    paintHits();
  }

  // Advances the sensor-hit animation. Returns true when something changed (only while exploded),
  // so a render-on-demand loop can skip frames otherwise.
  function update(dt = 0) {
    if (!hitMesh || explodeT < 0.35) return false;
    hitClock += Math.min(dt, 0.1);
    hitTimer -= Math.min(dt, 0.1);
    if (hitTimer <= 0) { newShower(); hitTimer = 2.4 + hitRand() * 1.4; }
    paintHits();
    return true;
  }

  function dispose() {
    for (const d of disposables) d.dispose?.();
    if (hitMesh) hitMesh.dispose();
  }

  setExplode(0);
  return {
    group,
    setExplode,
    update,
    dispose,
    layers: { baseplate: gBase, kapton: gKap, sensor: gSen, hexaboard: gPcb, chips: gChips },
  };
}

/* ==========================================================================
   createLayer
   ========================================================================== */

/**
 * A disk of hexagonal modules tiling an annulus in the XY plane, front toward +z, centered on the beam axis.
 * Inner modules (r < hdRadius) are high-density boards (smaller cells, six readout chips), the rest low-density.
 * @param {object} [opts]
 * @param {number} [opts.innerRadius=0.32]
 * @param {number} [opts.outerRadius=1.55]
 * @param {number} [opts.moduleSize=0.167]  flat-to-flat (m)
 * @param {number} [opts.gap=0.002]         gap between neighbouring modules (m)
 * @param {number} [opts.hdRadius=0.7]      modules whose center is inside this radius use the HD board (0 = none)
 * @param {string} [opts.edgeColor='#62e8b0'] color of the faint glowing module edges
 * @param {number} [opts.glow=0.12]         emissive fill of the boards
 * @param {number} [opts.envIntensity=0.45] envMapIntensity (the scene's RoomEnvironment washes boards out at grazing angles)
 * @param {boolean} [opts.plate=true]       dark copper cooling plate behind the modules
 * @param {boolean} [opts.rings=true]       thin inner/outer outline rings
 * @param {number} [opts.anisotropy=8]
 */
export function createLayer(opts = {}) {
  const {
    innerRadius = 0.32,
    outerRadius = 1.55,
    moduleSize = NOMINAL_SIZE,
    gap = 0.002,
    hdRadius = 0.7,
    edgeColor = '#62e8b0',
    glow = 0.12,
    envIntensity = 0.45,
    plate = true,
    rings = true,
    anisotropy = 8,
    seed = 3,
  } = opts;

  const disposables = [];
  const track = (x) => (disposables.push(x), x);
  const group = new THREE.Group();
  group.name = 'hgcal-layer';
  const scale = moduleSize / NOMINAL_SIZE;
  const thick = 4.0; // mm, module stack
  const rand = mulberry32(seed);

  /* --- choose lattice sites fully inside the annulus --- */
  const pitch = moduleSize + gap;
  const outlineM = hexOutline(DIM.base).map(([x, y]) => [x * MM * scale, y * MM * scale]);
  const segDist = (px, py, ax, ay, bx, by) => {
    const ex = bx - ax, ey = by - ay;
    const t = clamp01(((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey));
    return Math.hypot(ax + ex * t - px, ay + ey * t - py);
  };
  const sites = { LD: [], HD: [] };
  const nI = Math.ceil(outerRadius / pitch) + 2, nJ = Math.ceil(outerRadius / (pitch * SQ3 / 2)) + 2;
  for (let j = -nJ; j <= nJ; j++) {
    for (let i = -nI; i <= nI; i++) {
      const x = (i + (Math.abs(j) % 2 ? 0.5 : 0)) * pitch, y = j * pitch * (SQ3 / 2);
      let maxR = 0, minR = Infinity;
      for (let k = 0; k < outlineM.length; k++) {
        const [ax, ay] = outlineM[k], [bx, by] = outlineM[(k + 1) % outlineM.length];
        maxR = Math.max(maxR, Math.hypot(x + ax, y + ay));
        minR = Math.min(minR, segDist(0, 0, x + ax, y + ay, x + bx, y + by));
      }
      if (maxR > outerRadius || minR < innerRadius) continue;
      const rc = Math.hypot(x, y);
      (rc < hdRadius ? sites.HD : sites.LD).push({ x, y, rc });
    }
  }

  /* --- instanced modules (one draw call per board type) --- */
  const geo = track(slabGeometry(hexOutline(DIM.base), [], thick, [0.01, 0.5]));
  geo.translate(0, 0, -thick * MM * 0.5);
  if (scale !== 1) geo.scale(scale, scale, scale);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const col = new THREE.Color();
  const meshes = [];
  for (const kind of ['LD', 'HD']) {
    const list = sites[kind];
    if (!list.length) continue;
    const tex = layerTextures(kind, edgeColor, glow, anisotropy);
    const mat = track(new THREE.MeshStandardMaterial({
      map: tex.map, roughness: 0.55, metalness: 0.15, envMapIntensity: envIntensity,
      emissive: 0xffffff, emissiveMap: tex.emissive, emissiveIntensity: 1,
    }));
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = `modules-${kind}`;
    list.forEach((site, idx) => {
      // Modules in the same 60° sector share an orientation, as on a cassette.
      const sector = Math.floor(((Math.atan2(site.y, site.x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 3));
      q.setFromAxisAngle(zAxis, sector * (Math.PI / 3));
      p.set(site.x, site.y, 0);
      m.compose(p, q, s);
      mesh.setMatrixAt(idx, m);
      const b = 0.86 + rand() * 0.2;
      const warm = rand() < 0.18 ? 0.06 : 0;
      col.setRGB(b * (1 + warm), b, b * (1 - warm * 1.5));
      mesh.setColorAt(idx, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  /* --- cooling plate behind the modules --- */
  if (plate) {
    const pg = track(new THREE.RingGeometry(innerRadius - 0.012, outerRadius + 0.02, 160, 1));
    const pm = track(new THREE.MeshStandardMaterial({ color: 0x4a2f1f, roughness: 0.55, metalness: 0.55, envMapIntensity: envIntensity, emissive: 0x160c06, emissiveIntensity: 0.6 }));
    const plateMesh = new THREE.Mesh(pg, pm);
    plateMesh.position.z = -(thick / 2 + 0.6) * MM;
    plateMesh.name = 'cooling-plate';
    group.add(plateMesh);
  }

  /* --- thin outline rings at the inner and outer radius --- */
  if (rings) {
    const pts = [];
    for (const R of [innerRadius - 0.006, outerRadius + 0.012]) {
      const n = 256;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        pts.push(R * Math.cos(a0), R * Math.sin(a0), 0, R * Math.cos(a1), R * Math.sin(a1), 0);
      }
    }
    const lg = track(new THREE.BufferGeometry());
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lm = track(new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    const lines = new THREE.LineSegments(lg, lm);
    lines.position.z = (thick / 2) * MM;
    lines.name = 'layer-rings';
    group.add(lines);
  }

  return {
    group,
    count: { LD: sites.LD.length, HD: sites.HD.length },
    dispose() {
      for (const d of disposables) d.dispose?.();
      for (const mesh of meshes) mesh.dispose();
    },
  };
}
