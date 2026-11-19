// DXF okuyucu (saf): profil kesitlerini sketch geometrisine çevirmek için 2B eğrileri çıkarır.
//
// Desteklenen: LINE, ARC, CIRCLE, LWPOLYLINE / POLYLINE (yaylı köşeler = bulge), SPLINE ve ELLIPSE (kısa
// çizgilerle yaklaşık), INSERT (blok içindeki çizimler; iç içe bloklar, ölçek, dönüş, ayna).
// Yazı, ölçü, tarama vb. atlanır (sayısı uyarı olarak döner). Kağıt alanındaki (paper space) öğeler atlanır.
// Ardından placeDxf (birim, katman, dönüş, ayna, yerleşim) ve dxfToSketch (uç birleştirme, T-kesişimde bölme,
// kopya silme → sketch varlıkları) çalışır.
import type { SkEntity, Vec2 } from '@/core/types';

export type DxfPrim =
  | { kind: 'line'; a: Vec2; b: Vec2; layer: string }
  /** Merkez c etrafında a0'dan a1'e saat yönü tersine (radyan) */
  | { kind: 'arc'; c: Vec2; r: number; a0: number; a1: number; layer: string }
  | { kind: 'circle'; c: Vec2; r: number; layer: string };

export interface DxfData {
  prims: DxfPrim[];
  /** Eğri içeren katmanlar (sıralı) */
  layers: string[];
  /** Dosyanın birimi: 1 birim kaç mm ($INSUNITS); bilinmiyorsa null */
  unitMm: number | null;
  /** Atlanan öğe türleri → adet */
  skipped: Record<string, number>;
}

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- grup kodları

interface RawEntity {
  type: string;
  codes: [number, string][];
}

function readPairs(text: string): [number, string][] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) {
      // Hizası kaymış satır: bir satır ileri
      i -= 1;
      continue;
    }
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

/** Bölümlere ayırır: HEADER çiftleri, BLOCKS (ad → taban + öğeler), ENTITIES öğeleri */
function sections(pairs: [number, string][]) {
  const header: [number, string][] = [];
  const blocks = new Map<string, { base: Vec2; ents: RawEntity[] }>();
  const entities: RawEntity[] = [];
  let i = 0;
  const n = pairs.length;
  while (i < n) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1];
      i += 2;
      const start = i;
      while (i < n && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) i++;
      const body = pairs.slice(start, i);
      if (name === 'HEADER') header.push(...body);
      else if (name === 'ENTITIES') entities.push(...splitEntities(body));
      else if (name === 'BLOCKS') {
        let cur: { name: string; base: Vec2; ents: RawEntity[] } | null = null;
        for (const e of splitEntities(body)) {
          if (e.type === 'BLOCK') {
            cur = { name: str(e, 2) ?? '', base: [num(e, 10), num(e, 20)], ents: [] };
          } else if (e.type === 'ENDBLK') {
            if (cur) blocks.set(cur.name, { base: cur.base, ents: cur.ents });
            cur = null;
          } else if (cur) cur.ents.push(e);
        }
      }
    }
    i++;
  }
  return { header, blocks, entities };
}

function splitEntities(body: [number, string][]): RawEntity[] {
  const out: RawEntity[] = [];
  let cur: RawEntity | null = null;
  for (const p of body) {
    if (p[0] === 0) {
      cur = { type: p[1].toUpperCase(), codes: [] };
      out.push(cur);
    } else if (cur) cur.codes.push(p);
  }
  return out;
}

const str = (e: RawEntity, code: number): string | undefined => e.codes.find((c) => c[0] === code)?.[1];
function num(e: RawEntity, code: number, def = 0): number {
  const v = str(e, code);
  const x = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(x) ? x : def;
}
const nums = (e: RawEntity, code: number): number[] => e.codes.filter((c) => c[0] === code).map((c) => parseFloat(c[1]));

// ---------------------------------------------------------------- dönüşüm (2B afin)

/** [a b c; d e f]: x' = a x + b y + c, y' = d x + e y + f */
type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 0, 1, 0];
const apply = (m: Mat, p: Vec2): Vec2 => [m[0] * p[0] + m[1] * p[1] + m[2], m[3] * p[0] + m[4] * p[1] + m[5]];
const mulM = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[3],
  m[0] * n[1] + m[1] * n[4],
  m[0] * n[2] + m[1] * n[5] + m[2],
  m[3] * n[0] + m[4] * n[3],
  m[3] * n[1] + m[4] * n[4],
  m[3] * n[2] + m[4] * n[5] + m[5],
];
const det = (m: Mat) => m[0] * m[4] - m[1] * m[3];
/** Benzerlik dönüşümü mü (eşit ölçek, açı korunur) */
function isSimilar(m: Mat): boolean {
  const sx = Math.hypot(m[0], m[3]);
  const sy = Math.hypot(m[1], m[4]);
  const dotp = m[0] * m[1] + m[3] * m[4];
  return Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy, 1) && Math.abs(dotp) <= 1e-9 * Math.max(sx * sy, 1);
}

/** OCS: çekme yönü -Z ise x aynalanır (rastgele eksen algoritmasının bu özel hâli) */
const ocsOf = (e: RawEntity): Mat => (num(e, 230, 1) < 0 ? [-1, 0, 0, 0, 1, 0] : IDENT);

// ---------------------------------------------------------------- öğe → eğri

interface Ctx {
  out: DxfPrim[];
  skipped: Record<string, number>;
  blocks: Map<string, { base: Vec2; ents: RawEntity[] }>;
}

function addLine(ctx: Ctx, m: Mat, a: Vec2, b: Vec2, layer: string) {
  ctx.out.push({ kind: 'line', a: apply(m, a), b: apply(m, b), layer });
}

function addPolyline(ctx: Ctx, m: Mat, pts: Vec2[], layer: string, closed = false) {
  const n = pts.length;
  for (let i = 0; i + 1 < (closed ? n + 1 : n); i++) addLine(ctx, m, pts[i], pts[(i + 1) % n], layer);
}

/** Yay (ccw, radyan) — benzerlik dönüşümünde yay kalır, değilse çizgilerle */
function addArc(ctx: Ctx, m: Mat, c: Vec2, r: number, a0: number, a1: number, layer: string, full = false) {
  if (!(r > 0)) return;
  if (isSimilar(m)) {
    const s = Math.sqrt(Math.abs(det(m)));
    const cc = apply(m, c);
    if (full) {
      ctx.out.push({ kind: 'circle', c: cc, r: r * s, layer });
      return;
    }
    const p0 = apply(m, [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)]);
    const p1 = apply(m, [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)]);
    const b0 = Math.atan2(p0[1] - cc[1], p0[0] - cc[0]);
    const b1 = Math.atan2(p1[1] - cc[1], p1[0] - cc[0]);
    // Ayna (det < 0) yönü çevirir: ccw yay p1'den p0'a olur
    if (det(m) > 0) ctx.out.push({ kind: 'arc', c: cc, r: r * s, a0: b0, a1: b1, layer });
    else ctx.out.push({ kind: 'arc', c: cc, r: r * s, a0: b1, a1: b0, layer });
    return;
  }
  let sweep = full ? TAU : (((a1 - a0) % TAU) + TAU) % TAU;
  if (sweep < 1e-12) sweep = TAU;
  const n = Math.max(8, Math.ceil((sweep / TAU) * 64));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  addPolyline(ctx, m, pts, layer);
}

/** p1 → p2 arası bulge'lı parça */
function addBulge(ctx: Ctx, m: Mat, p1: Vec2, p2: Vec2, bulge: number, layer: string) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return;
  if (Math.abs(bulge) < 1e-9) {
    addLine(ctx, m, p1, p2, layer);
    return;
  }
  const theta = 4 * Math.atan(bulge);
  const mid: Vec2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const off = d / 2 / Math.tan(theta / 2);
  // Kirişin sol normali; bulge > 0 (ccw) merkez solda
  const c: Vec2 = [mid[0] - (dy / d) * off, mid[1] + (dx / d) * off];
  const r = Math.hypot(p1[0] - c[0], p1[1] - c[1]);
  const a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
  const a2 = Math.atan2(p2[1] - c[1], p2[0] - c[0]);
  if (bulge > 0) addArc(ctx, m, c, r, a1, a2, layer);
  else addArc(ctx, m, c, r, a2, a1, layer);
}

function addVertices(ctx: Ctx, m: Mat, verts: { p: Vec2; bulge: number }[], closed: boolean, layer: string) {
  const n = verts.length;
  if (n < 2) return;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    addBulge(ctx, m, a.p, b.p, a.bulge, layer);
  }
}

/** LWPOLYLINE: köşe başına 10/20 ve isteğe bağlı 42 (bulge) — sıra önemli */
function lwVertices(e: RawEntity): { p: Vec2; bulge: number }[] {
  const out: { p: Vec2; bulge: number }[] = [];
  let cur: { p: Vec2; bulge: number } | null = null;
  for (const [code, v] of e.codes) {
    if (code === 10) {
      cur = { p: [parseFloat(v), 0], bulge: 0 };
      out.push(cur);
    } else if (code === 20 && cur) cur.p[1] = parseFloat(v);
    else if (code === 42 && cur) cur.bulge = parseFloat(v) || 0;
  }
  return out;
}

/** NURBS eğrisini örnekler (de Boor) */
function splinePoints(e: RawEntity): Vec2[] {
  const deg = Math.max(1, Math.round(num(e, 71, 3)));
  const knots = nums(e, 40);
  const cx = nums(e, 10);
  const cy = nums(e, 20);
  const w = nums(e, 41);
  const ctrl: Vec2[] = cx.map((x, i) => [x, cy[i] ?? 0]);
  if (ctrl.length < 2 || knots.length !== ctrl.length + deg + 1) {
    // Yedek: uydurma noktaları ya da kontrol çokgeni
    const fx = nums(e, 11);
    const fy = nums(e, 21);
    if (fx.length >= 2) return fx.map((x, i) => [x, fy[i] ?? 0]);
    return ctrl;
  }
  const weights = ctrl.map((_, i) => (w.length === ctrl.length && w[i] > 0 ? w[i] : 1));
  const t0 = knots[deg];
  const t1 = knots[knots.length - deg - 1];
  const N = Math.max(16, ctrl.length * 8);
  const pts: Vec2[] = [];
  for (let s = 0; s <= N; s++) {
    const t = t0 + ((t1 - t0) * s) / N;
    let k = deg;
    while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++;
    const d: [number, number, number][] = [];
    for (let j = 0; j <= deg; j++) {
      const i = k - deg + j;
      const wi = weights[i];
      d.push([ctrl[i][0] * wi, ctrl[i][1] * wi, wi]);
    }
    for (let r = 1; r <= deg; r++)
      for (let j = deg; j >= r; j--) {
        const i = k - deg + j;
        const den = knots[i + deg - r + 1] - knots[i];
        const a = den > 1e-15 ? (t - knots[i]) / den : 0;
        for (let q = 0; q < 3; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
      }
    const [x, y, ww] = d[deg];
    pts.push([x / ww, y / ww]);
  }
  return pts;
}

function ellipse(ctx: Ctx, m: Mat, e: RawEntity, layer: string) {
  const c: Vec2 = [num(e, 10), num(e, 20)];
  const maj: Vec2 = [num(e, 11), num(e, 21)];
  const ratio = num(e, 40, 1);
  const p0 = num(e, 41, 0);
  let p1 = num(e, 42, TAU);
  const a = Math.hypot(maj[0], maj[1]);
  if (!(a > 0)) return;
  const rot = Math.atan2(maj[1], maj[0]);
  const full = Math.abs(Math.abs(p1 - p0) - TAU) < 1e-9;
  if (Math.abs(ratio - 1) < 1e-9) {
    addArc(ctx, m, c, a, p0 + rot, p1 + rot, layer, full);
    return;
  }
  if (p1 <= p0) p1 += TAU;
  const n = Math.max(16, Math.ceil(((p1 - p0) / TAU) * 96));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = p0 + ((p1 - p0) * i) / n;
    const x = a * Math.cos(t);
    const y = a * ratio * Math.sin(t);
    pts.push([c[0] + x * Math.cos(rot) - y * Math.sin(rot), c[1] + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  addPolyline(ctx, m, pts, layer);
}

function walk(ctx: Ctx, ents: RawEntity[], m: Mat, depth: number, inheritLayer?: string) {
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (str(e, 67) === '1') continue; // kağıt alanı
    let layer = str(e, 8) ?? '0';
    // Blok içinde "0" katmanı, INSERT'in katmanını alır
    if (inheritLayer && layer === '0') layer = inheritLayer;
    switch (e.type) {
      case 'LINE':
        // LINE noktaları dünya (WCS) koordinatında
        addLine(ctx, m, [num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)], layer);
        break;
      case 'CIRCLE':
        addArc(ctx, mulM(m, ocsOf(e)), [num(e, 10), num(e, 20)], num(e, 40), 0, TAU, layer, true);
        break;
      case 'ARC':
        addArc(ctx, mulM(m, ocsOf(e)), [num(e, 10), num(e, 20)], num(e, 40), (num(e, 50) * Math.PI) / 180, (num(e, 51) * Math.PI) / 180, layer);
        break;
      case 'LWPOLYLINE':
        addVertices(ctx, mulM(m, ocsOf(e)), lwVertices(e), (Math.round(num(e, 70)) & 1) === 1, layer);
        break;
      case 'POLYLINE': {
        const flags = Math.round(num(e, 70));
        const verts: { p: Vec2; bulge: number }[] = [];
        let j = i + 1;
        for (; j < ents.length && ents[j].type === 'VERTEX'; j++) {
          const v = ents[j];
          // Çokyüzlü/ağ köşeleri (yalnız indeks) atlanır
          if (Math.round(num(v, 70)) & 128) continue;
          verts.push({ p: [num(v, 10), num(v, 20)], bulge: num(v, 42) });
        }
        if (j < ents.length && ents[j].type === 'SEQEND') j++;
        i = j - 1;
        if (flags & (16 | 64)) {
          ctx.skipped['POLYFACE'] = (ctx.skipped['POLYFACE'] ?? 0) + 1;
          break;
        }
        addVertices(ctx, mulM(m, ocsOf(e)), verts, (flags & 1) === 1, layer);
        break;
      }
      case 'SPLINE':
        addPolyline(ctx, m, splinePoints(e), layer, (Math.round(num(e, 70)) & 1) === 1);
        break;
      case 'ELLIPSE':
        ellipse(ctx, m, e, layer);
        break;
      case 'INSERT': {
        const blk = ctx.blocks.get(str(e, 2) ?? '');
        if (!blk || depth > 8) break;
        const sx = num(e, 41, 1) || 1;
        const sy = num(e, 42, 1) || 1;
        const rot = (num(e, 50) * Math.PI) / 180;
        const [px, py] = [num(e, 10), num(e, 20)];
        const cr = Math.cos(rot);
        const sr = Math.sin(rot);
        // P + R·S·(x − taban)
        const local: Mat = [cr * sx, -sr * sy, 0, sr * sx, cr * sy, 0];
        const t1: Mat = [1, 0, -blk.base[0], 0, 1, -blk.base[1]];
        const ins = mulM([1, 0, px, 0, 1, py], mulM(local, t1));
        walk(ctx, blk.ents, mulM(m, mulM(ocsOf(e), ins)), depth + 1, layer);
        break;
      }
      case 'VERTEX':
      case 'SEQEND':
      case 'ATTRIB':
      case 'ATTDEF':
        break;
      default:
        ctx.skipped[e.type] = (ctx.skipped[e.type] ?? 0) + 1;
    }
  }
}

const UNIT_MM: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 14: 100 };

/** DXF metnini okur. Okunamazsa hata fırlatır. */
export function parseDxf(text: string): DxfData {
  if (!/\bSECTION\b/.test(text)) {
    if (text.startsWith('AutoCAD Binary DXF')) throw new Error('İkili (binary) DXF desteklenmiyor; ASCII DXF olarak kaydedin.');
    throw new Error('Geçerli bir DXF dosyası değil.');
  }
  const { header, blocks, entities } = sections(readPairs(text));
  let unitMm: number | null = null;
  for (let i = 0; i < header.length; i++) {
    if (header[i][0] === 9 && header[i][1] === '$INSUNITS') {
      const v = parseInt(header[i + 1]?.[1] ?? '', 10);
      unitMm = UNIT_MM[v] ?? null;
    }
  }
  const ctx: Ctx = { out: [], skipped: {}, blocks };
  walk(ctx, entities, IDENT, 0);
  const prims = ctx.out.filter((p) => (p.kind === 'line' ? dist(p.a, p.b) > 1e-12 : p.r > 1e-12) && allFinite(p));
  const layers = [...new Set(prims.map((p) => p.layer))].sort((a, b) => a.localeCompare(b, 'tr'));
  return { prims, layers, unitMm, skipped: ctx.skipped };
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function allFinite(p: DxfPrim): boolean {
  const vs = p.kind === 'line' ? [...p.a, ...p.b] : p.kind === 'arc' ? [...p.c, p.r, p.a0, p.a1] : [...p.c, p.r];
  return vs.every(Number.isFinite);
}

// ---------------------------------------------------------------- yerleştirme

export interface DxfPlacement {
  /** 1 DXF birimi kaç mm */
  scale: number;
  /** Alınacak katmanlar */
  layers: string[];
  /** Derece (saat yönü tersi) */
  rotate: number;
  /** Y eksenine göre ayna (yatay çevir) */
  mirror: boolean;
  /** Hangi nokta sketch orijinine gelir */
  anchor: 'origin' | 'center' | 'minCorner';
  /** Ek kaydırma (mm, sketch) */
  offset: Vec2;
}

export function primBounds(prims: DxfPrim[]): { min: Vec2; max: Vec2 } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Vec2) => {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  };
  for (const p of prims) {
    if (p.kind === 'line') {
      add(p.a);
      add(p.b);
    } else if (p.kind === 'circle') {
      add([p.c[0] - p.r, p.c[1] - p.r]);
      add([p.c[0] + p.r, p.c[1] + p.r]);
    } else {
      // Yay: uçlar + içinde kalan eksen uçları
      let sw = (((p.a1 - p.a0) % TAU) + TAU) % TAU;
      if (sw < 1e-12) sw = TAU;
      add(arcPt(p, p.a0));
      add(arcPt(p, p.a0 + sw));
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const rel = (((ang - p.a0) % TAU) + TAU) % TAU;
        if (rel <= sw) add(arcPt(p, ang));
      }
    }
  }
  return x0 <= x1 ? { min: [x0, y0], max: [x1, y1] } : null;
}

const arcPt = (p: { c: Vec2; r: number }, a: number): Vec2 => [p.c[0] + p.r * Math.cos(a), p.c[1] + p.r * Math.sin(a)];

/** Katman süzme + birim + ayna + dönüş + yerleşim (sonuç sketch koordinatında, mm) */
export function placeDxf(data: DxfData, o: DxfPlacement): DxfPrim[] {
  const keep = new Set(o.layers);
  const src = data.prims.filter((p) => keep.has(p.layer));
  const rad = (o.rotate * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const k = o.scale;
  const mx = o.mirror ? -1 : 1;
  // Önce ölçek + ayna + dönüş (orijin etrafında), sonra yerleşim kaydırması
  const lin: Mat = [c * k * mx, -s * k, 0, s * k * mx, c * k, 0];
  const ctx: Ctx = { out: [], skipped: {}, blocks: new Map() };
  for (const p of src) {
    if (p.kind === 'line') addLine(ctx, lin, p.a, p.b, p.layer);
    else if (p.kind === 'circle') addArc(ctx, lin, p.c, p.r, 0, TAU, p.layer, true);
    else addArc(ctx, lin, p.c, p.r, p.a0, p.a1, p.layer);
  }
  const bb = primBounds(ctx.out);
  let shift: Vec2 = [0, 0];
  if (bb && o.anchor === 'center') shift = [-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2];
  else if (bb && o.anchor === 'minCorner') shift = [-bb.min[0], -bb.min[1]];
  const t: Mat = [1, 0, shift[0] + o.offset[0], 0, 1, shift[1] + o.offset[1]];
  const out: Ctx = { out: [], skipped: {}, blocks: new Map() };
  for (const p of ctx.out) {
    if (p.kind === 'line') addLine(out, t, p.a, p.b, p.layer);
    else if (p.kind === 'circle') out.out.push({ ...p, c: apply(t, p.c) });
    else out.out.push({ ...p, c: apply(t, p.c) });
  }
  return out.out;
}

// ---------------------------------------------------------------- sketch'e çevirme

export interface DxfSketchResult {
  entities: SkEntity[];
  /** Uçları birleştirilen nokta sayısı, bölünen çizgi, silinen kopya */
  stats: { snapped: number; split: number; duplicates: number };
}

/**
 * Yerleştirilmiş eğrileri sketch varlıklarına çevirir: toleransla yakın uçlar tek noktada birleşir, başka
 * bir çizginin ortasına değen uçta o çizgi bölünür (bölge bulma için), kopyalar silinir. Tüm varlıklar
 * ext = extId taşır (çözücüde sabit; biri silinince içe aktarmanın tamamı silinir).
 */
export function dxfToSketch(prims: DxfPrim[], extId: string, newId: (prefix: string) => string, tol = 0.01): DxfSketchResult {
  const stats = { snapped: 0, split: 0, duplicates: 0 };
  // 1) Uç noktaları kümele (ızgara karması)
  const pts: Vec2[] = [];
  const grid = new Map<string, number[]>();
  const cell = Math.max(tol, 1e-9);
  const keyOf = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const snap = (p: Vec2): number => {
    const gx = Math.floor(p[0] / cell);
    const gy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (dist(pts[i], p) <= tol) {
            if (dist(pts[i], p) > 0) stats.snapped++;
            return i;
          }
        }
      }
    pts.push([p[0], p[1]]);
    const k = keyOf(p[0], p[1]);
    const list = grid.get(k);
    if (list) list.push(pts.length - 1);
    else grid.set(k, [pts.length - 1]);
    return pts.length - 1;
  };

  type L = { a: number; b: number };
  type A = { c: Vec2; r: number; s: number; e: number };
  let lines: L[] = [];
  const arcs: A[] = [];
  const circles: { c: Vec2; r: number }[] = [];
  for (const p of prims) {
    if (p.kind === 'line') {
      const a = snap(p.a);
      const b = snap(p.b);
      if (a !== b) lines.push({ a, b });
    } else if (p.kind === 'arc') {
      const s = snap(arcPt(p, p.a0));
      const e = snap(arcPt(p, p.a1));
      if (s === e) {
        // Çok küçük ya da tam tur yay
        const sw = (((p.a1 - p.a0) % TAU) + TAU) % TAU;
        if (sw < 1e-9 || sw > TAU - 1e-9) circles.push({ c: p.c, r: p.r });
        continue;
      }
      arcs.push({ c: p.c, r: p.r, s, e });
    } else circles.push({ c: p.c, r: p.r });
  }

  // 2) T-kesişimleri: bir uç başka bir çizginin içine düşüyorsa çizgiyi böl
  const used = new Set<number>();
  for (const l of lines) used.add(l.a).add(l.b);
  for (const a of arcs) used.add(a.s).add(a.e);
  const endpoints = [...used];
  const next: L[] = [];
  for (const l of lines) {
    const A = pts[l.a];
    const B = pts[l.b];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const minX = Math.min(A[0], B[0]) - tol, maxX = Math.max(A[0], B[0]) + tol;
    const minY = Math.min(A[1], B[1]) - tol, maxY = Math.max(A[1], B[1]) + tol;
    const cuts: { t: number; i: number }[] = [];
    for (const i of endpoints) {
      if (i === l.a || i === l.b) continue;
      const P = pts[i];
      if (P[0] < minX || P[0] > maxX || P[1] < minY || P[1] > maxY) continue;
      const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2;
      if (t * len <= tol || (1 - t) * len <= tol) continue;
      const off = Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / len;
      if (off <= tol) cuts.push({ t, i });
    }
    if (!cuts.length) {
      next.push(l);
      continue;
    }
    cuts.sort((x, y) => x.t - y.t);
    stats.split++;
    let prev = l.a;
    for (const c of cuts) {
      if (c.i !== prev) next.push({ a: prev, b: c.i });
      prev = c.i;
    }
    if (prev !== l.b) next.push({ a: prev, b: l.b });
  }
  lines = next;

  // 3) Kopyaları sil
  const seen = new Set<string>();
  const uniq = <T>(list: T[], key: (x: T) => string): T[] =>
    list.filter((x) => {
      const k = key(x);
      if (seen.has(k)) {
        stats.duplicates++;
        return false;
      }
      seen.add(k);
      return true;
    });
  const r6 = (v: number) => Math.round(v / tol);
  const lineList = uniq(lines, (l) => `L${Math.min(l.a, l.b)}-${Math.max(l.a, l.b)}`);
  const arcList = uniq(arcs, (a) => `A${a.s}-${a.e}-${r6(a.r)}-${r6(a.c[0])}-${r6(a.c[1])}`);
  const circList = uniq(circles, (c) => `C${r6(c.r)}-${r6(c.c[0])}-${r6(c.c[1])}`);

  // 4) Varlıklar
  const entities: SkEntity[] = [];
  const pid = new Map<number, string>();
  const pointId = (i: number): string => {
    let id = pid.get(i);
    if (!id) {
      id = newId('p');
      pid.set(i, id);
      entities.push({ id, kind: 'point', x: pts[i][0], y: pts[i][1], ext: extId });
    }
    return id;
  };
  const centerId = (c: Vec2): string => {
    const id = newId('p');
    entities.push({ id, kind: 'point', x: c[0], y: c[1], ext: extId });
    return id;
  };
  for (const l of lineList) entities.push({ id: newId('l'), kind: 'line', p1: pointId(l.a), p2: pointId(l.b), ext: extId });
  for (const a of arcList) {
    const s = pointId(a.s);
    const e = pointId(a.e);
    // Yarıçap, birleştirilmiş uçlara göre güncellenir (ortalama)
    const r = (dist(pts[a.s], a.c) + dist(pts[a.e], a.c)) / 2;
    entities.push({ id: newId('a'), kind: 'arc', c: centerId(a.c), start: s, end: e, r, ext: extId });
  }
  for (const c of circList) entities.push({ id: newId('c'), kind: 'circle', c: centerId(c.c), r: c.r, ext: extId });
  return { entities, stats };
}
