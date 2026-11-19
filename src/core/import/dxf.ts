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

/** Tek eğriyi benzerlik dönüşümüyle taşır (sonuç 1:1; yay yay kalır) */
function mapPrim(m: Mat, p: DxfPrim): DxfPrim {
  const ctx: Ctx = { out: [], skipped: {}, blocks: new Map() };
  if (p.kind === 'line') addLine(ctx, m, p.a, p.b, p.layer);
  else if (p.kind === 'circle') addArc(ctx, m, p.c, p.r, 0, TAU, p.layer, true);
  else addArc(ctx, m, p.c, p.r, p.a0, p.a1, p.layer);
  return ctx.out[0] ?? p;
}

/**
 * Birim + ayna + dönüş + yerleşim (sonuç sketch koordinatında, mm). Çıktı girdiyle aynı sıra ve uzunlukta.
 * anchorMask verilirse yerleşim (orijine gelen nokta) yalnız işaretli eğrilerden hesaplanır.
 */
export function transformPrims(prims: DxfPrim[], o: Omit<DxfPlacement, 'layers'>, anchorMask?: boolean[]): DxfPrim[] {
  const rad = (o.rotate * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const k = o.scale;
  const mx = o.mirror ? -1 : 1;
  // Önce ölçek + ayna + dönüş (orijin etrafında), sonra yerleşim kaydırması
  const lin: Mat = [c * k * mx, -s * k, 0, s * k * mx, c * k, 0];
  const mid = prims.map((p) => mapPrim(lin, p));
  // Hiçbiri seçili değilse tüm çizime göre (önizleme kaymasın)
  const bb = primBounds(anchorMask?.some(Boolean) ? mid.filter((_, i) => anchorMask[i]) : mid);
  let shift: Vec2 = [0, 0];
  if (bb && o.anchor === 'center') shift = [-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2];
  else if (bb && o.anchor === 'minCorner') shift = [-bb.min[0], -bb.min[1]];
  const t: Mat = [1, 0, shift[0] + o.offset[0], 0, 1, shift[1] + o.offset[1]];
  return mid.map((p) => mapPrim(t, p));
}

/** Katman süzme + birim + ayna + dönüş + yerleşim (sonuç sketch koordinatında, mm) */
export function placeDxf(data: DxfData, o: DxfPlacement): DxfPrim[] {
  const keep = new Set(o.layers);
  return transformPrims(data.prims.filter((p) => keep.has(p.layer)), o);
}

/**
 * Ayrı profiller: uçları birleşen eğriler aynı parçadır; kutusu başka bir parçanın kutusu içinde kalan
 * parça (ör. profil içindeki vida dairesi, ayrı çizilmiş odacık) onu içeren profile katılır. Dönen dizi eğri başına grup no
 * (0'dan, soldan sağa / yukarıdan aşağı sıralı).
 */
export function dxfPieces(prims: DxfPrim[], tol = 0.01): number[] {
  const n = prims.length;
  const parent = prims.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  // 1) Ortak uç noktası (ızgara karması)
  const cell = Math.max(tol, 1e-9);
  const grid = new Map<string, number[]>();
  const ends = (p: DxfPrim): Vec2[] =>
    p.kind === 'line' ? [p.a, p.b] : p.kind === 'arc' ? [arcPt(p, p.a0), arcPt(p, p.a1)] : [];
  prims.forEach((p, i) => {
    for (const q of ends(p)) {
      const gx = Math.floor(q[0] / cell);
      const gy = Math.floor(q[1] / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) union(i, j);
      const key = `${gx},${gy}`;
      const l = grid.get(key);
      if (l) l.push(i);
      else grid.set(key, [i]);
    }
  });
  // 2) İçerme: kutusu başka bir grubun kutusunun tamamen içinde kalan grup (ayrı çizilmiş iç odacık, vida
  // dairesi, küçük detay) onu içeren en küçük gruba katılır. Kısmen kesişen gruplar (yan yana duran,
  // birbirine geçen profiller) ayrı kalır.
  const boxOf = new Map<number, { min: Vec2; max: Vec2 }>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const bx = primBounds([prims[i]])!;
    const cur = boxOf.get(r);
    if (!cur) boxOf.set(r, { min: [...bx.min], max: [...bx.max] });
    else {
      cur.min = [Math.min(cur.min[0], bx.min[0]), Math.min(cur.min[1], bx.min[1])];
      cur.max = [Math.max(cur.max[0], bx.max[0]), Math.max(cur.max[1], bx.max[1])];
    }
  }
  const area = (q: { min: Vec2; max: Vec2 }) => (q.max[0] - q.min[0]) * (q.max[1] - q.min[1]);
  const inside = (q: { min: Vec2; max: Vec2 }, o: { min: Vec2; max: Vec2 }) =>
    q.min[0] >= o.min[0] - tol && q.min[1] >= o.min[1] - tol && q.max[0] <= o.max[0] + tol && q.max[1] <= o.max[1] + tol;
  const groupRoots = [...boxOf.keys()];
  const into = new Map<number, number>();
  for (const r of groupRoots) {
    const q = boxOf.get(r)!;
    let best = -1;
    let bestArea = Infinity;
    for (const o of groupRoots) {
      if (o === r) continue;
      const ob = boxOf.get(o)!;
      const oa = area(ob);
      // Eşit kutular (aynı konturun kopyası) birbirine katılmasın diye içeren kesin büyük olmalı
      if (oa > area(q) + tol && oa < bestArea && inside(q, ob)) {
        best = o;
        bestArea = oa;
      }
    }
    if (best >= 0) into.set(r, best);
  }
  for (const [r, o] of into) union(r, o);
  // Grup no: kutu sol üstüne göre sıralı
  const roots = [...new Set(prims.map((_, i) => find(i)))];
  const corner = new Map<number, Vec2>();
  for (const r of roots) {
    const b = primBounds(prims.filter((_, i) => find(i) === r))!;
    corner.set(r, [b.min[0], b.max[1]]);
  }
  roots.sort((a, b) => {
    const A = corner.get(a)!;
    const B = corner.get(b)!;
    return Math.abs(A[1] - B[1]) > 1e-6 ? B[1] - A[1] : A[0] - B[0];
  });
  const idx = new Map(roots.map((r, i) => [r, i]));
  return prims.map((_, i) => idx.get(find(i))!);
}

/**
 * Önerilen birim (1 birim kaç mm). Dosyadaki birim ölçüleri makul değilse (profil 0,5 mm'den küçük ya da
 * 10 m'den büyük çıkıyorsa) ve mm makulse mm önerilir; note uyarı metnidir.
 */
export function suggestUnit(data: DxfData): { unitMm: number; note?: string } {
  const bb = primBounds(data.prims);
  const size = bb ? Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) : 0;
  const ok = (mm: number) => size * mm >= 0.5 && size * mm <= 10000;
  if (data.unitMm && ok(data.unitMm)) return { unitMm: data.unitMm };
  if (data.unitMm && ok(1)) {
    return {
      unitMm: 1,
      note: `Dosyadaki birim ölçülere uymuyor (${fmtMm(size * data.unitMm)} çıkıyordu); mm kabul edildi.`,
    };
  }
  return { unitMm: data.unitMm ?? 1 };
}

const fmtMm = (mm: number) => (mm >= 1000 ? `${Number((mm / 1000).toFixed(1))} m` : `${Number(mm.toFixed(2))} mm`);

// ---------------------------------------------------------------- sketch'e çevirme

export interface DxfSketchResult {
  entities: SkEntity[];
  /** Uçları birleştirilen nokta sayısı, bölünen çizgi, silinen kopya */
  stats: { snapped: number; split: number; duplicates: number };
}

/**
 * Yerleştirilmiş eğrileri sketch varlıklarına çevirir: toleransla yakın uçlar tek noktada birleşir, başka
 * bir eğrinin ortasına değen uçta ve kesişen eğrilerin kesişme noktasında eğriler bölünür (bölge bulma için),
 * kopyalar silinir. Tüm varlıklar
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
  let arcs: A[] = [];
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

  // 2) Bölme: başka bir eğrinin ucu bir eğrinin içine düşüyorsa (T) ya da iki eğri kesişiyorsa (X), eğriler o
  // noktada bölünür. Bölge bulma kesişmelerin nokta olarak tanımlı olmasını ister; yoksa kontur kendini keser ve
  // çekirdek geçersiz yüz üretir (katalog çizimlerinde uzatılmış/çakışan çizgiler sık görülür).
  type Cut = { t: number; i: number };
  const ang = (c: Vec2, p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  // Bir çizginin kestiği ya da bir ucun değdiği daire, o noktadan başlayan tam tur yaya çevrilir (bölünebilsin)
  for (let ci = circles.length - 1; ci >= 0; ci--) {
    const cc = circles[ci];
    let hit: Vec2 | null = null;
    for (const p of [...lines.flatMap((l) => [pts[l.a], pts[l.b]]), ...arcs.flatMap((q) => [pts[q.s], pts[q.e]])])
      if (Math.abs(dist(p, cc.c) - cc.r) <= tol) {
        hit = p;
        break;
      }
    for (let k = 0; !hit && k < lines.length; k++) {
      const A = pts[lines[k].a];
      const D: Vec2 = [pts[lines[k].b][0] - A[0], pts[lines[k].b][1] - A[1]];
      const F: Vec2 = [A[0] - cc.c[0], A[1] - cc.c[1]];
      const a2 = D[0] * D[0] + D[1] * D[1];
      const b2 = 2 * (D[0] * F[0] + D[1] * F[1]);
      const disc = b2 * b2 - 4 * a2 * (F[0] * F[0] + F[1] * F[1] - cc.r * cc.r);
      if (disc < 0) continue;
      for (const t of [(-b2 - Math.sqrt(disc)) / (2 * a2), (-b2 + Math.sqrt(disc)) / (2 * a2)])
        if (t > 0 && t < 1) {
          hit = [A[0] + D[0] * t, A[1] + D[1] * t];
          break;
        }
    }
    if (!hit) continue;
    const i = snap(hit);
    arcs.push({ c: cc.c, r: cc.r, s: i, e: i });
    circles.splice(ci, 1);
  }
  const arcG = arcs.map((q) => {
    const a0 = ang(q.c, pts[q.s]);
    let sw = (((ang(q.c, pts[q.e]) - a0) % TAU) + TAU) % TAU;
    if (sw < 1e-12) sw = TAU;
    return { a0, sw };
  });
  const lineCuts: Cut[][] = lines.map(() => []);
  const arcCuts: Cut[][] = arcs.map(() => []);
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const lineBox: Box[] = lines.map((l) => {
    const A = pts[l.a];
    const B = pts[l.b];
    return { x0: Math.min(A[0], B[0]) - tol, y0: Math.min(A[1], B[1]) - tol, x1: Math.max(A[0], B[0]) + tol, y1: Math.max(A[1], B[1]) + tol };
  });
  const arcBox: Box[] = arcs.map((q) => ({ x0: q.c[0] - q.r - tol, y0: q.c[1] - q.r - tol, x1: q.c[0] + q.r + tol, y1: q.c[1] + q.r + tol }));
  const overlap = (u: Box, v: Box) => u.x0 <= v.x1 && v.x0 <= u.x1 && u.y0 <= v.y1 && v.y0 <= u.y1;
  const inBox = (u: Box, P: Vec2) => P[0] >= u.x0 && P[0] <= u.x1 && P[1] >= u.y0 && P[1] <= u.y1;

  /** Çizgi içi parametre (uçlara tol'dan yakınsa null) */
  const lineT = (k: number, P: Vec2): number | null => {
    const A = pts[lines[k].a];
    const B = pts[lines[k].b];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2;
    if (t * len <= tol || (1 - t) * len <= tol) return null;
    const off = Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / len;
    return off <= tol ? t : null;
  };
  /** Yay içi açı ofseti (uçlara tol'dan yakınsa ya da yay dışındaysa null) */
  const arcT = (k: number, P: Vec2): number | null => {
    const q = arcs[k];
    if (Math.abs(dist(P, q.c) - q.r) > tol) return null;
    const g = arcG[k];
    const o = (((ang(q.c, P) - g.a0) % TAU) + TAU) % TAU;
    if (o * q.r <= tol || (g.sw - o) * q.r <= tol) return null;
    return o;
  };
  /** Kesişme noktasını iki eğriye de keser (nokta uçlardan birine birleşirse kesmez) */
  const cutAt = (P: Vec2, onLines: number[], onArcs: number[]) => {
    const tl = onLines.map((k) => lineT(k, P));
    const ta = onArcs.map((k) => arcT(k, P));
    if (tl.some((t) => t === null) || ta.some((t) => t === null)) return;
    const i = snap(P);
    onLines.forEach((k, j) => {
      if (i !== lines[k].a && i !== lines[k].b) lineCuts[k].push({ t: tl[j]!, i });
    });
    onArcs.forEach((k, j) => {
      if (i !== arcs[k].s && i !== arcs[k].e) arcCuts[k].push({ t: ta[j]!, i });
    });
  };

  // (a) T: eğri uçları
  const used = new Set<number>();
  for (const l of lines) used.add(l.a).add(l.b);
  for (const q of arcs) used.add(q.s).add(q.e);
  for (const i of used) {
    const P = pts[i];
    lines.forEach((l, k) => {
      if (i === l.a || i === l.b || !inBox(lineBox[k], P)) return;
      const t = lineT(k, P);
      if (t !== null) lineCuts[k].push({ t, i });
    });
    arcs.forEach((q, k) => {
      if (i === q.s || i === q.e || !inBox(arcBox[k], P)) return;
      const t = arcT(k, P);
      if (t !== null) arcCuts[k].push({ t, i });
    });
  }
  // (b) X: kesişen eğri çiftleri
  for (let k = 0; k < lines.length; k++) {
    const A = pts[lines[k].a];
    const D: Vec2 = [pts[lines[k].b][0] - A[0], pts[lines[k].b][1] - A[1]];
    for (let j = k + 1; j < lines.length; j++) {
      if (!overlap(lineBox[k], lineBox[j])) continue;
      const C = pts[lines[j].a];
      const E: Vec2 = [pts[lines[j].b][0] - C[0], pts[lines[j].b][1] - C[1]];
      const den = D[0] * E[1] - D[1] * E[0];
      if (Math.abs(den) < 1e-12 * Math.hypot(...D) * Math.hypot(...E)) continue; // paralel
      const t = ((C[0] - A[0]) * E[1] - (C[1] - A[1]) * E[0]) / den;
      if (t <= 0 || t >= 1) continue;
      cutAt([A[0] + D[0] * t, A[1] + D[1] * t], [k, j], []);
    }
    for (let j = 0; j < arcs.length; j++) {
      if (!overlap(lineBox[k], arcBox[j])) continue;
      const q = arcs[j];
      const F: Vec2 = [A[0] - q.c[0], A[1] - q.c[1]];
      const a2 = D[0] * D[0] + D[1] * D[1];
      const b2 = 2 * (D[0] * F[0] + D[1] * F[1]);
      const c2 = F[0] * F[0] + F[1] * F[1] - q.r * q.r;
      const disc = b2 * b2 - 4 * a2 * c2;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      for (const t of sq < 1e-12 ? [-b2 / (2 * a2)] : [(-b2 - sq) / (2 * a2), (-b2 + sq) / (2 * a2)]) {
        if (t <= 0 || t >= 1) continue;
        cutAt([A[0] + D[0] * t, A[1] + D[1] * t], [k], [j]);
      }
    }
  }
  for (let k = 0; k < arcs.length; k++)
    for (let j = k + 1; j < arcs.length; j++) {
      if (!overlap(arcBox[k], arcBox[j])) continue;
      const p = arcs[k];
      const q = arcs[j];
      const d = dist(p.c, q.c);
      if (d < 1e-12 || d > p.r + q.r || d < Math.abs(p.r - q.r)) continue;
      const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
      const ux = (q.c[0] - p.c[0]) / d;
      const uy = (q.c[1] - p.c[1]) / d;
      const m: Vec2 = [p.c[0] + ux * a, p.c[1] + uy * a];
      for (const P of h < 1e-12 ? [m] : [[m[0] - uy * h, m[1] + ux * h] as Vec2, [m[0] + uy * h, m[1] - ux * h] as Vec2])
        cutAt(P, [], [k, j]);
    }

  // Bölmeleri uygula
  const nextLines: L[] = [];
  lines.forEach((l, k) => {
    const cuts = lineCuts[k];
    if (!cuts.length) {
      nextLines.push(l);
      return;
    }
    stats.split++;
    cuts.sort((x, y) => x.t - y.t);
    let prev = l.a;
    for (const c of cuts) {
      if (c.i !== prev) nextLines.push({ a: prev, b: c.i });
      prev = c.i;
    }
    if (prev !== l.b) nextLines.push({ a: prev, b: l.b });
  });
  const nextArcs: A[] = [];
  arcs.forEach((q, k) => {
    const cuts = arcCuts[k];
    if (!cuts.length) {
      nextArcs.push(q);
      return;
    }
    stats.split++;
    cuts.sort((x, y) => x.t - y.t);
    let prev = q.s;
    for (const c of cuts) {
      if (c.i !== prev) nextArcs.push({ c: q.c, r: q.r, s: prev, e: c.i });
      prev = c.i;
    }
    if (prev !== q.e) nextArcs.push({ c: q.c, r: q.r, s: prev, e: q.e });
  });
  lines = nextLines;
  arcs = nextArcs;

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
