// Sketch 2B geometri yardımcıları (saf fonksiyonlar)
import type { SkArc, SkCircle, SkConstraint, SkEntity, SkLine, SkPoint, Vec2 } from '../../modeling/types';

export type PtMap = Map<string, SkPoint>;

export const TAU = Math.PI * 2;

export function pointMap(ents: readonly SkEntity[]): PtMap {
  const m: PtMap = new Map();
  for (const e of ents) if (e.kind === 'point') m.set(e.id, e);
  return m;
}

export const v2 = (p: { x: number; y: number }): Vec2 => [p.x, p.y];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
}
export const polar = (c: Vec2, r: number, a: number): Vec2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

/** [0, 2π) aralığına */
export function wrapAngle(a: number): number {
  const w = a % TAU;
  return w < 0 ? w + TAU : w;
}

export function isCurve(e: SkEntity | undefined): e is SkLine | SkCircle | SkArc {
  return !!e && e.kind !== 'point';
}

/** Eğrinin referans verdiği nokta id'leri */
export function curvePointIds(e: SkEntity): string[] {
  switch (e.kind) {
    case 'line':
      return [e.p1, e.p2];
    case 'circle':
      return [e.c];
    case 'arc':
      return [e.c, e.start, e.end];
    default:
      return [];
  }
}

export function linePts(l: SkLine, pm: PtMap): [Vec2, Vec2] | null {
  const a = pm.get(l.p1);
  const b = pm.get(l.p2);
  return a && b ? [v2(a), v2(b)] : null;
}

/** Yay açıları: a0 başlangıç, sweep (0, 2π] ccw */
export function arcAngles(arc: SkArc, pm: PtMap): { c: Vec2; r: number; a0: number; sweep: number } | null {
  const c = pm.get(arc.c);
  const s = pm.get(arc.start);
  const e = pm.get(arc.end);
  if (!c || !s || !e) return null;
  const cc = v2(c);
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const a1 = Math.atan2(e.y - c.y, e.x - c.x);
  let sweep = wrapAngle(a1 - a0);
  if (sweep < 1e-9) sweep = TAU;
  return { c: cc, r: arc.r, a0, sweep };
}

export function arcPolyline(c: Vec2, r: number, a0: number, sweep: number, perCircle = 96): Vec2[] {
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / TAU) * perCircle));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) out.push(polar(c, r, a0 + (sweep * i) / n));
  return out;
}

/** Eğriyi çoklu çizgiye çevirir */
export function curvePolyline(e: SkEntity, pm: PtMap): Vec2[] {
  if (e.kind === 'line') {
    const p = linePts(e, pm);
    return p ? [p[0], p[1]] : [];
  }
  if (e.kind === 'circle') {
    const c = pm.get(e.c);
    return c ? arcPolyline(v2(c), e.r, 0, TAU) : [];
  }
  if (e.kind === 'arc') {
    const a = arcAngles(e, pm);
    return a ? arcPolyline(a.c, a.r, a.a0, a.sweep) : [];
  }
  return [];
}

export function distToSeg(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number; foot: Vec2 } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 1e-18 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  const foot = add(a, mul(ab, t));
  return { d: dist(p, foot), t, foot };
}

/** Sonsuz doğruya dik izdüşüm */
export function projectToLine(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-18) return a;
  return add(a, mul(ab, dot(sub(p, a), ab) / l2));
}

/** Açı yay aralığında mı (a0'dan ccw sweep) */
export function angleInArc(a: number, a0: number, sweep: number): boolean {
  return wrapAngle(a - a0) <= sweep + 1e-9;
}

/** Noktanın eğriye uzaklığı ve eğri üzerindeki en yakın nokta */
export function distToCurve(p: Vec2, e: SkEntity, pm: PtMap): { d: number; foot: Vec2 } | null {
  if (e.kind === 'line') {
    const lp = linePts(e, pm);
    if (!lp) return null;
    const r = distToSeg(p, lp[0], lp[1]);
    return { d: r.d, foot: r.foot };
  }
  if (e.kind === 'circle') {
    const c = pm.get(e.c);
    if (!c) return null;
    const cc = v2(c);
    const dir = norm(sub(p, cc));
    return { d: Math.abs(dist(p, cc) - e.r), foot: add(cc, mul(dir, e.r)) };
  }
  if (e.kind === 'arc') {
    const a = arcAngles(e, pm);
    if (!a) return null;
    const ang = Math.atan2(p[1] - a.c[1], p[0] - a.c[0]);
    if (angleInArc(ang, a.a0, a.sweep)) {
      return { d: Math.abs(dist(p, a.c) - a.r), foot: polar(a.c, a.r, ang) };
    }
    const s = polar(a.c, a.r, a.a0);
    const t = polar(a.c, a.r, a.a0 + a.sweep);
    const ds = dist(p, s);
    const dt = dist(p, t);
    return ds < dt ? { d: ds, foot: s } : { d: dt, foot: t };
  }
  return null;
}

/** Varlığın bir "çapa" noktası (rozet konumu): çizgi ortası, daire üstü, nokta kendisi */
export function anchorOf(e: SkEntity, pm: PtMap): Vec2 | null {
  if (e.kind === 'point') return v2(e);
  if (e.kind === 'line') {
    const lp = linePts(e, pm);
    return lp ? lerp(lp[0], lp[1], 0.5) : null;
  }
  if (e.kind === 'circle') {
    const c = pm.get(e.c);
    return c ? polar(v2(c), e.r, Math.PI / 4) : null;
  }
  const a = arcAngles(e, pm);
  return a ? polar(a.c, a.r, a.a0 + a.sweep / 2) : null;
}

/** Varlıkların 2B sınır kutusu */
export function boundsOf(ents: readonly SkEntity[]): { min: Vec2; max: Vec2 } | null {
  const pm = pointMap(ents);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const ext = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const e of ents) {
    if (e.kind === 'point') ext(e.x, e.y);
    else if (e.kind === 'circle' || e.kind === 'arc') {
      const c = pm.get(e.c);
      if (c) {
        ext(c.x - e.r, c.y - e.r);
        ext(c.x + e.r, c.y + e.r);
      }
    }
  }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

/** İki doğrunun kesişimi (paralelse null) */
export function intersectLines(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d1 = sub(a2, a1);
  const d2 = sub(b2, b1);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12 * (len(d1) * len(d2) + 1e-12)) return null;
  const t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / den;
  return add(a1, mul(d1, t));
}

/** Kısıtın referans verdiği tüm varlık id'leri */
export const constraintRefs = (c: SkConstraint) => c.refs;

/** Sayıyı kısa biçimde (en fazla 3 ondalık) */
export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  const r = Number(n.toFixed(digits));
  return String(Object.is(r, -0) ? 0 : r);
}

/** "12,5" ya da "12.5" → sayı (boş/geçersizse null) */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
