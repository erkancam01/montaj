// Kısıt görselleri: ölçü çizgileri (GL) ve etiket/rozet konumları (DOM). Saf hesaplar.
import type { SkConstraint, SkConstraintType, SkEntity, Vec2 } from '@/core/types/modeling';
import { isDimension } from '@/state/sketchSession';
import {
  add,
  anchorOf,
  dist,
  dot,
  fmt,
  intersectLines,
  lerp,
  linePts,
  mul,
  norm,
  perp,
  polar,
  projectToLine,
  sub,
  TAU,
  v2,
  wrapAngle,
  type PtMap,
} from '@/core/sketch/geom';

export interface DimGeom {
  id: string;
  /** Çoklu çizgiler (ölçü, uzatma çizgileri ve oklar) */
  polys: Vec2[][];
  label: Vec2;
  text: string;
}

/** Ölçü metni */
export function dimText(c: SkConstraint): string {
  const v = c.value ?? 0;
  switch (c.type) {
    case 'radius':
      return `R${fmt(v)} mm`;
    case 'diameter':
      return `Ø${fmt(v)} mm`;
    case 'angle':
      return `${fmt(v, 1)}°`;
    default:
      return `${fmt(v)} mm`;
  }
}

function arrow(tip: Vec2, dir: Vec2, px: number): Vec2[] {
  const u = norm(dir);
  const n = perp(u);
  const L = 9 * px;
  const W = 3 * px;
  const back = sub(tip, mul(u, L));
  return [add(back, mul(n, W)), tip, sub(back, mul(n, W))];
}

interface DimRefs {
  get: (id: string) => SkEntity | undefined;
  pm: PtMap;
}

/** İki nokta arası (hizalı / yatay / dikey) ölçü geometrisi */
function linear(A: Vec2, B: Vec2, L: Vec2 | undefined, px: number, mode: 'aligned' | 'x' | 'y'): { polys: Vec2[][]; label: Vec2 } {
  let u: Vec2;
  let n: Vec2;
  if (mode === 'x') {
    u = [B[0] >= A[0] ? 1 : -1, 0];
    n = [0, 1];
  } else if (mode === 'y') {
    u = [0, B[1] >= A[1] ? 1 : -1];
    n = [-1, 0];
  } else {
    u = dist(A, B) > 1e-12 ? norm(sub(B, A)) : [1, 0];
    // Etiket varsayılanı: yatayda üst, dikeyde sol
    n = perp(u);
    if (n[1] < -1e-9 || (Math.abs(n[1]) < 1e-9 && n[0] > 0)) n = mul(n, -1);
  }
  const mid = lerp(A, B, 0.5);
  let label: Vec2;
  if (L) label = L;
  else if (mode === 'x') label = [mid[0], Math.max(A[1], B[1]) + 22 * px];
  else if (mode === 'y') label = [Math.max(A[0], B[0]) + 22 * px, mid[1]];
  else label = add(mid, mul(n, 22 * px));
  const offA = dot(sub(label, A), n);
  const offB = dot(sub(label, B), n);
  const A2 = add(A, mul(n, offA));
  const B2 = add(B, mul(n, offB));
  const ext = 4 * px;
  const polys: Vec2[][] = [];
  const sgn = (v: number) => (v >= 0 ? 1 : -1);
  if (Math.abs(offA) > 1e-9) polys.push([add(A, mul(n, sgn(offA) * 2 * px)), add(A2, mul(n, sgn(offA) * ext))]);
  if (Math.abs(offB) > 1e-9) polys.push([add(B, mul(n, sgn(offB) * 2 * px)), add(B2, mul(n, sgn(offB) * ext))]);
  const dimLen = dot(sub(B2, A2), u);
  polys.push([A2, B2]);
  // Etiket ölçü çizgisinin dışındaysa çizgiyi uzat
  const t = dot(sub(label, A2), u);
  if (t < 0) polys.push([A2, add(A2, mul(u, t))]);
  else if (t > dimLen) polys.push([B2, add(A2, mul(u, t))]);
  if (Math.abs(dimLen) > 1e-9) {
    polys.push(arrow(A2, mul(u, -1), px));
    polys.push(arrow(B2, u, px));
  }
  return { polys, label };
}

export function dimGeometry(c: SkConstraint, r: DimRefs, px: number): DimGeom | null {
  const e0 = r.get(c.refs[0]);
  const e1 = c.refs[1] ? r.get(c.refs[1]) : undefined;
  if (!e0) return null;
  const text = dimText(c);
  const L = c.label;
  const P = (e: SkEntity | undefined): Vec2 | null => (e && e.kind === 'point' ? v2(e) : null);
  switch (c.type) {
    case 'distance': {
      let A: Vec2 | null = null;
      let B: Vec2 | null = null;
      if (e0.kind === 'line' && !e1) {
        const lp = linePts(e0, r.pm);
        if (lp) [A, B] = lp;
      } else if (e0.kind === 'point' && e1?.kind === 'point') {
        A = v2(e0);
        B = v2(e1);
      } else if (e0.kind === 'point' && e1?.kind === 'line') {
        const lp = linePts(e1, r.pm);
        if (lp) {
          A = v2(e0);
          B = projectToLine(A, lp[0], lp[1]);
        }
      }
      if (!A || !B) return null;
      const g = linear(A, B, L, px, 'aligned');
      return { id: c.id, polys: g.polys, label: g.label, text };
    }
    case 'distanceX':
    case 'distanceY': {
      const a = P(e0);
      if (!a) return null;
      const b = P(e1);
      const A: Vec2 = b ? a : [0, 0];
      const B: Vec2 = b ?? a;
      const g = linear(A, B, L, px, c.type === 'distanceX' ? 'x' : 'y');
      return { id: c.id, polys: g.polys, label: g.label, text };
    }
    case 'radius':
    case 'diameter': {
      if (e0.kind !== 'circle' && e0.kind !== 'arc') return null;
      const cp = r.pm.get(e0.c);
      if (!cp) return null;
      const C = v2(cp);
      const rad = e0.r;
      const label = L ?? polar(C, rad + 18 * px, Math.PI / 4);
      const dir = dist(label, C) > 1e-12 ? norm(sub(label, C)) : ([1, 0] as Vec2);
      const P2 = add(C, mul(dir, rad));
      const polys: Vec2[][] = [];
      if (c.type === 'radius') {
        polys.push([C, dist(label, C) > rad ? label : P2]);
        polys.push(arrow(P2, dir, px));
      } else {
        const P1 = sub(C, mul(dir, rad));
        polys.push([P1, dist(label, C) > rad ? label : P2]);
        polys.push(arrow(P2, dir, px));
        polys.push(arrow(P1, mul(dir, -1), px));
      }
      return { id: c.id, polys, label, text };
    }
    case 'angle': {
      if (e0.kind !== 'line' || e1?.kind !== 'line') return null;
      const la = linePts(e0, r.pm);
      const lb = linePts(e1, r.pm);
      if (!la || !lb) return null;
      const X = intersectLines(la[0], la[1], lb[0], lb[1]);
      if (!X) return null;
      const ua = norm(sub(la[1], la[0]));
      const ub = norm(sub(lb[1], lb[0]));
      // Varsayılan: çizgilerin orta noktalarına doğru olan yönler
      const towards = (u: Vec2, lp: [Vec2, Vec2]) => (dot(sub(lerp(lp[0], lp[1], 0.5), X), u) >= 0 ? u : mul(u, -1));
      const da0 = towards(ua, la);
      const db0 = towards(ub, lb);
      const label =
        L ?? add(X, mul(norm(add(da0, db0)), Math.max(40 * px, Math.min(dist(X, lerp(la[0], la[1], 0.5)), dist(X, lerp(lb[0], lb[1], 0.5))) * 0.5)));
      const angL = Math.atan2(label[1] - X[1], label[0] - X[0]);
      let best: { a0: number; sweep: number } | null = null;
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          const a = Math.atan2(ua[1] * sa, ua[0] * sa);
          const b = Math.atan2(ub[1] * sb, ub[0] * sb);
          let a0 = a;
          let sweep = wrapAngle(b - a);
          if (sweep > Math.PI) {
            a0 = b;
            sweep = TAU - sweep;
          }
          if (wrapAngle(angL - a0) <= sweep && (!best || sweep < best.sweep + 1e-9)) best = { a0, sweep };
        }
      }
      if (!best) best = { a0: Math.atan2(da0[1], da0[0]), sweep: wrapAngle(Math.atan2(db0[1], db0[0]) - Math.atan2(da0[1], da0[0])) };
      const rr = Math.max(dist(label, X), 1e-6);
      const n = Math.max(8, Math.ceil((best.sweep / TAU) * 96));
      const arc: Vec2[] = [];
      for (let i = 0; i <= n; i++) arc.push(polar(X, rr, best.a0 + (best.sweep * i) / n));
      const polys: Vec2[][] = [arc];
      // Kısa uzatma çizgileri (çizgiler yay yarıçapına ulaşmıyorsa)
      for (const [lp, a] of [
        [la, best.a0],
        [lb, best.a0 + best.sweep],
      ] as [[Vec2, Vec2], number][]) {
        const far = Math.max(dist(X, lp[0]), dist(X, lp[1]));
        if (far < rr) polys.push([polar(X, far, a), polar(X, rr + 4 * px, a)]);
      }
      return { id: c.id, polys, label, text };
    }
    default:
      return null;
  }
}

/** Ölçü olmayan kısıtların rozet konumları */
export interface Badge {
  key: string;
  cid: string;
  type: SkConstraintType;
  p: Vec2;
  dx: number;
  dy: number;
}

export function badgesOf(constraints: readonly SkConstraint[], r: DimRefs): Badge[] {
  const out: Badge[] = [];
  const stack = new Map<string, number>();
  const push = (c: SkConstraint, anchorId: string, p: Vec2 | null, i: number) => {
    if (!p) return;
    const n = stack.get(anchorId) ?? 0;
    stack.set(anchorId, n + 1);
    out.push({ key: `${c.id}:${i}`, cid: c.id, type: c.type, p, dx: 14 + n * 17, dy: -13 });
  };
  for (const c of constraints) {
    if (isDimension(c.type)) continue;
    const ents = c.refs.map((id) => r.get(id));
    if (ents.some((e) => !e)) continue;
    const es = ents as SkEntity[];
    switch (c.type) {
      case 'coincident':
      case 'fix':
      case 'pointOnLine':
      case 'pointOnCircle':
      case 'midpoint':
        push(c, es[0].id, anchorOf(es[0], r.pm), 0);
        break;
      case 'horizontal':
      case 'vertical':
        if (es.length === 2 && es[0].kind === 'point' && es[1].kind === 'point') {
          push(c, `${es[0].id}|${es[1].id}`, lerp(v2(es[0]), v2(es[1]), 0.5), 0);
        } else push(c, es[0].id, anchorOf(es[0], r.pm), 0);
        break;
      default:
        es.forEach((e, i) => push(c, e.id, anchorOf(e, r.pm), i));
    }
  }
  return out;
}
