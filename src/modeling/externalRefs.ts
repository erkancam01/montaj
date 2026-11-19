// Dış referanslar: başka parçaların (STEP ya da başka gövde) yüz/kenarlarından sketch düzlemi ve
// projeksiyon geometrisi. Canlı: kaynak taşınınca ya da yeniden üretilince resolveBody ile yenilenir.
//
// Akış: kaynak yüz/kenar → parça-yerel 3B eğriler (Curve3; mesh'ten çıkarılır, önbelleğe alınır)
//       → gövde-yerel (gövde⁻¹ ∘ kaynakDünya) → sketch-2B eğriler → kimlikleri kararlı sketch varlıkları.
// Varlık kimlikleri projeksiyon id'si + sıra numarasıdır; aynı kaynaktan aynı sırada üretildiği sürece
// kullanıcı kısıtları (çakışık, ölçü…) yeniden hesaplamadan sonra da aynı varlığa bağlı kalır.
import { getFaceGeom } from '../lib/faceGeometry';
import { geometryCache, type ParsedMesh } from '../lib/geometryCache';
import { composeT, invertT, partWorld } from '../lib/math';
import { isSketchSolverReady, solveSketch } from '../sketch/solver';
import type {
  Body,
  Doc,
  EdgeSig,
  ExtRef,
  FaceGeom,
  FaceRef,
  Part,
  PlaneDef,
  SkEntity,
  SketchFeature,
  SkProjection,
  Transform,
  Vec2,
  Vec3,
} from '../types';
import { bodyFileId, isBodyFileId } from '../types';
import { faceArea, matchFace } from './faceMatch';
import { liveSourcesOf } from './refLocks';

// ---------------------------------------------------------------- Vektör yardımcıları

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function rot(q: readonly number[], v: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
}
const tPoint = (t: Transform, p: Vec3): Vec3 => add3(rot(t.quaternion, p), t.position);
const tDir = (t: Transform, d: Vec3): Vec3 => rot(t.quaternion, d);

/** Normal'e dik, kararlı bir yön */
function perpOf(n: Vec3): Vec3 {
  return Math.abs(n[2]) < 0.9 ? norm3(cross3([0, 0, 1], n)) : norm3(cross3(n, [1, 0, 0]));
}

// ---------------------------------------------------------------- Belge yardımcıları

/** Gövde çerçevesi (gövde-yerel → dünya) verilen belgede */
export function bodyFrameIn(doc: Doc, bodyId: string): Transform | null {
  const fid = bodyFileId(bodyId);
  const inst = doc.instances.find((i) => i.fileId === fid);
  const part = inst && doc.parts.find((p) => p.instanceId === inst.id);
  return inst && part ? partWorld(inst, part) : null;
}

interface Source {
  part: Part;
  world: Transform;
}

function sourcePart(doc: Doc, partId: string): Source | null {
  const part = doc.parts.find((p) => p.id === partId);
  const inst = part && doc.instances.find((i) => i.id === part.instanceId);
  return part && inst ? { part, world: partWorld(inst, part) } : null;
}

/** Kaynak parça-yerel → gövde-yerel dönüşümü */
function localToBody(doc: Doc, bodyId: string, src: Source): Transform | null {
  const frame = bodyFrameIn(doc, bodyId);
  return frame ? composeT(invertT(frame), src.world) : null;
}

// ---------------------------------------------------------------- Yüz / kenar çözümleme

/** Kaynak yüzü bulur. Gövde kaynaklarında imzayla yeniden eşlenir (ref güncellenmiş olarak döner). */
function resolveFace(part: Part, ref: FaceRef): { ref: FaceRef; geom: FaceGeom; mesh: ParsedMesh } | null {
  const node = geometryCache.get(part.fileId)?.nodes[part.nodeKey];
  if (!node) return null;
  if (isBodyFileId(part.fileId) && ref.sig && ref.sig.kind !== 'other') {
    const m = matchFace(part, ref.sig, ref.sigArea);
    if (!m) return null;
    const same = m.meshIndex === ref.meshIndex && m.faceIndex === ref.faceIndex && JSON.stringify(m.geom) === JSON.stringify(ref.sig);
    const next = same ? ref : { ...ref, meshIndex: m.meshIndex, faceIndex: m.faceIndex, sig: m.geom, sigArea: m.area };
    return { ref: next, geom: m.geom, mesh: node.meshes[m.meshIndex] };
  }
  const g = getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  const mesh = node.meshes[ref.meshIndex];
  return g && mesh ? { ref, geom: g, mesh } : null;
}

/** Gövde kaynağında kenarı imzasıyla bulur (birebir yoksa en yakın aynı tür kenar) */
function resolveEdge(part: Part, sig: EdgeSig): { index: number; sig: EdgeSig; mesh: ParsedMesh } | null {
  const node = geometryCache.get(part.fileId)?.nodes[part.nodeKey];
  const mesh = node?.meshes.find((m) => m.brepEdges);
  const be = mesh?.brepEdges;
  if (!mesh || !be || !node) return null;
  const diag = Math.max(1, Math.hypot(...node.size));
  let best: { i: number; score: number } | null = null;
  be.sigs.forEach((s, i) => {
    if (s.kind !== sig.kind) return;
    let score = len3(sub3(s.mid, sig.mid)) + Math.abs(s.length - sig.length);
    if (s.kind === 'circle') score += Math.abs((s.radius ?? 0) - (sig.radius ?? 0)) * 4;
    if (!best || score < best.score) best = { i, score };
  });
  const b = best as { i: number; score: number } | null;
  if (!b || b.score > diag * 0.5) return null;
  return { index: b.i, sig: be.sigs[b.i], mesh };
}

// ---------------------------------------------------------------- 3B eğriler (parça-yerel)

type Curve3 =
  | { kind: 'line'; a: Vec3; b: Vec3 }
  | { kind: 'circle'; c: Vec3; n: Vec3; r: number }
  /** n etrafında s'den e'ye ccw yay */
  | { kind: 'arc'; c: Vec3; n: Vec3; r: number; s: Vec3; e: Vec3 };

const curveCache = new WeakMap<ParsedMesh, Map<string, Curve3[] | null>>();

function cached(mesh: ParsedMesh, key: string, fn: () => Curve3[] | null): Curve3[] | null {
  let m = curveCache.get(mesh);
  if (!m) curveCache.set(mesh, (m = new Map()));
  if (m.has(key)) return m.get(key)!;
  const v = fn();
  m.set(key, v);
  return v;
}

/** Yüzün üçgenlerinden sınır döngüleri (parça-yerel köşe dizileri, sargı yönünde) */
function boundaryLoops(mesh: ParsedMesh, faceIndex: number): Vec3[][] {
  const f = mesh.faces[faceIndex];
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.index;
  if (!f || !pos) return [];
  const triMax = (idx ? idx.count : pos.count) / 3 - 1;
  const keyId = new Map<string, number>();
  const pts: Vec3[] = [];
  const vid = (i: number): number => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = keyId.get(k);
    if (id === undefined) {
      id = pts.length;
      keyId.set(k, id);
      pts.push([x, y, z]);
    }
    return id;
  };
  const edges = new Map<string, { a: number; b: number; n: number }>();
  for (let t = Math.max(0, f.first); t <= Math.min(f.last, triMax); t++) {
    const v = [0, 1, 2].map((k) => vid(idx ? idx.getX(t * 3 + k) : t * 3 + k));
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const e = edges.get(key);
      if (e) e.n++;
      else edges.set(key, { a, b, n: 1 });
    }
  }
  const next = new Map<number, number[]>();
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    const l = next.get(e.a);
    if (l) l.push(e.b);
    else next.set(e.a, [e.b]);
  }
  const loops: Vec3[][] = [];
  for (const [start] of next) {
    while (next.get(start)?.length) {
      const loop: number[] = [start];
      let cur = start;
      for (let guard = 0; guard < 1e6; guard++) {
        const l = next.get(cur);
        if (!l?.length) break;
        const nx = l.shift()!;
        if (nx === start) break;
        loop.push(nx);
        cur = nx;
      }
      if (loop.length >= 3) loops.push(loop.map((i) => pts[i]));
    }
  }
  return loops;
}

// ---- 2B döngü bölütleme (yüz düzleminde)

type Seg2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  /** sıra yönünde a → b; ccw: sıra yönü saat yönü tersi mi */
  | { kind: 'arc'; c: Vec2; r: number; a: Vec2; b: Vec2; ccw: boolean };

function fitCircle2(p: Vec2[]): { c: Vec2; r: number } | null {
  const n = p.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const q of p) {
    mx += q[0];
    my += q[1];
  }
  mx /= n;
  my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const q of p) {
    const u = q[0] - mx, v = q[1] - my;
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-18)) return null;
  const b1 = 0.5 * (suuu + suvv);
  const b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return Number.isFinite(r) ? { c: [uc + mx, vc + my], r } : null;
}

const d2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cr2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dt2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const sb2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];

function turnAt(p: Vec2[], i: number): number {
  const n = p.length;
  const a = sb2(p[i], p[(i - 1 + n) % n]);
  const b = sb2(p[(i + 1) % n], p[i]);
  return Math.abs(Math.atan2(cr2(a, b), dt2(a, b)));
}

function segmentLoop(raw: Vec2[], tol: number): Seg2[] {
  // Ardışık çift noktaları at
  const p: Vec2[] = [];
  for (const q of raw) if (!p.length || d2(p[p.length - 1], q) > tol * 0.01) p.push(q);
  while (p.length > 1 && d2(p[0], p[p.length - 1]) <= tol * 0.01) p.pop();
  const n = p.length;
  if (n < 3) return [];

  // Tam daire
  if (n >= 6) {
    const f = fitCircle2(p);
    if (f && f.r > tol * 10) {
      let ok = true;
      let sign = 0;
      for (let i = 0; i < n && ok; i++) {
        if (Math.abs(d2(p[i], f.c) - f.r) > tol) ok = false;
        const s = Math.sign(cr2(sb2(p[i], f.c), sb2(p[(i + 1) % n], f.c)));
        if (sign === 0) sign = s;
        else if (s !== 0 && s !== sign) ok = false;
      }
      if (ok) return [{ kind: 'circle', c: f.c, r: f.r }];
    }
  }

  // Başlangıç: en keskin köşe
  let start = 0;
  let maxTurn = -1;
  for (let i = 0; i < n; i++) {
    const t = turnAt(p, i);
    if (t > maxTurn + 1e-9) {
      maxTurn = t;
      start = i;
    }
  }
  const q: Vec2[] = [];
  for (let k = 0; k <= n; k++) q.push(p[(start + k) % n]);

  const lineOk = (i: number, j: number): boolean => {
    const a = q[i], b = q[j];
    const L = d2(a, b);
    if (L < tol) return false;
    const u: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let lastT = 0;
    for (let k = i + 1; k < j; k++) {
      const v = sb2(q[k], a);
      if (Math.abs(cr2(u, v)) > tol) return false;
      const t = dt2(u, v);
      if (t < lastT - tol || t > L + tol) return false;
      lastT = t;
    }
    return true;
  };

  const arcFit = (i: number, j: number): { c: Vec2; r: number; ccw: boolean } | null => {
    if (j - i < 3) return null;
    const pts = q.slice(i, j + 1);
    const f = fitCircle2(pts);
    if (!f || f.r < tol * 5) return null;
    const chord = d2(pts[0], pts[pts.length - 1]);
    if (f.r > 1e3 * Math.max(chord, tol)) return null;
    let sign = 0;
    let sweep = 0;
    for (let k = 0; k < pts.length; k++) {
      if (Math.abs(d2(pts[k], f.c) - f.r) > tol) return null;
      if (k + 1 < pts.length) {
        const a = sb2(pts[k], f.c), b = sb2(pts[k + 1], f.c);
        const ang = Math.atan2(cr2(a, b), dt2(a, b));
        const s = Math.sign(ang);
        if (Math.abs(ang) > (70 * Math.PI) / 180) return null;
        if (sign === 0) sign = s;
        else if (s !== 0 && s !== sign) return null;
        sweep += Math.abs(ang);
      }
      // İç noktalarda kırılma açısı küçük olmalı (köşelerden geçen yanlış yayları önler)
      if (k > 0 && k + 1 < pts.length) {
        const a = sb2(pts[k], pts[k - 1]), b = sb2(pts[k + 1], pts[k]);
        if (Math.abs(Math.atan2(cr2(a, b), dt2(a, b))) > (50 * Math.PI) / 180) return null;
      }
    }
    if (sweep >= 2 * Math.PI - 1e-3) return null;
    return { c: f.c, r: f.r, ccw: sign > 0 };
  };

  const out: Seg2[] = [];
  let i = 0;
  while (i < n) {
    let jl = i + 1;
    while (jl + 1 <= n && lineOk(i, jl + 1)) jl++;
    let ja = -1;
    let arc: { c: Vec2; r: number; ccw: boolean } | null = null;
    for (let j = i + 3; j <= n; j++) {
      const f = arcFit(i, j);
      if (!f) {
        if (j > i + 4) break;
        continue;
      }
      ja = j;
      arc = f;
    }
    if (arc && ja > jl) {
      out.push({ kind: 'arc', c: arc.c, r: arc.r, a: q[i], b: q[ja], ccw: arc.ccw });
      i = ja;
    } else {
      out.push({ kind: 'line', a: q[i], b: q[jl] });
      i = jl;
    }
  }

  // Başlangıç bir yayın ya da doğrunun ortasına düştüyse ilk ve son parçayı birleştir
  if (out.length > 2) {
    const f = out[0], l = out[out.length - 1];
    if (f.kind === 'arc' && l.kind === 'arc' && f.ccw === l.ccw && d2(f.c, l.c) < tol && Math.abs(f.r - l.r) < tol) {
      out[0] = { ...f, a: l.a };
      out.pop();
    } else if (f.kind === 'line' && l.kind === 'line') {
      const u = sb2(l.b, l.a), v = sb2(f.b, f.a);
      const L = Math.hypot(...u) * Math.hypot(...v);
      if (L > 0 && Math.abs(cr2(u, v)) / L < 1e-6 && dt2(u, v) > 0) {
        out[0] = { kind: 'line', a: l.a, b: f.b };
        out.pop();
      }
    }
  }
  return out;
}

/** Yüzün parça-yerel sınır eğrileri (düzlem: dış hat + delikler; silindir: daire ya da yay) */
function faceCurves(mesh: ParsedMesh, faceIndex: number, g: FaceGeom): Curve3[] | null {
  return cached(mesh, `f${faceIndex}`, () => {
    if (g.kind === 'cylinder') return cylinderCurve(mesh, faceIndex, g);
    if (g.kind !== 'plane') return null;
    const n = norm3(g.normal);
    const x = perpOf(n);
    const y = cross3(n, x);
    const o = g.point;
    const loops = boundaryLoops(mesh, faceIndex);
    if (!loops.length) return null;
    let size = 0;
    for (const l of loops) for (const p of l) size = Math.max(size, len3(sub3(p, o)));
    const tol = 2e-3 + size * 2e-5;
    const P = (u: Vec2): Vec3 => add3(add3(o, mul3(x, u[0])), mul3(y, u[1]));
    const out: Curve3[] = [];
    for (const loop of loops) {
      const p2 = loop.map((p): Vec2 => {
        const d = sub3(p, o);
        return [dot3(d, x), dot3(d, y)];
      });
      for (const s of segmentLoop(p2, tol)) {
        if (s.kind === 'line') out.push({ kind: 'line', a: P(s.a), b: P(s.b) });
        else if (s.kind === 'circle') out.push({ kind: 'circle', c: P(s.c), n, r: s.r });
        else {
          const [sa, sb] = s.ccw ? [s.a, s.b] : [s.b, s.a];
          out.push({ kind: 'arc', c: P(s.c), n, r: s.r, s: P(sa), e: P(sb) });
        }
      }
    }
    return out.length ? out : null;
  });
}

/** Silindir yüz: eksene dik daire; yüz tam tur değilse yay */
function cylinderCurve(mesh: ParsedMesh, faceIndex: number, g: FaceGeom & { kind: 'cylinder' }): Curve3[] {
  const a = norm3(g.axis);
  const x = perpOf(a);
  const y = cross3(a, x);
  const f = mesh.faces[faceIndex];
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.index;
  const angs: number[] = [];
  if (f && pos) {
    const triMax = (idx ? idx.count : pos.count) / 3 - 1;
    for (let t = Math.max(0, f.first); t <= Math.min(f.last, triMax); t++) {
      for (let k = 0; k < 3; k++) {
        const i = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        const d = sub3([pos.getX(i), pos.getY(i), pos.getZ(i)], g.point);
        angs.push(Math.atan2(dot3(d, y), dot3(d, x)));
      }
    }
  }
  angs.sort((p, q) => p - q);
  let gap = 0, gi = -1;
  for (let i = 0; i < angs.length; i++) {
    const next = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
    if (next - angs[i] > gap) {
      gap = next - angs[i];
      gi = i;
    }
  }
  if (gi < 0 || gap < (15 * Math.PI) / 180) return [{ kind: 'circle', c: g.point, n: a, r: g.radius }];
  const a0 = gi + 1 < angs.length ? angs[gi + 1] : angs[0];
  const a1 = angs[gi];
  const at = (t: number) => add3(g.point, add3(mul3(x, g.radius * Math.cos(t)), mul3(y, g.radius * Math.sin(t))));
  return [{ kind: 'arc', c: g.point, n: a, r: g.radius, s: at(a0), e: at(a1) }];
}

/** Gövde B-rep kenarının parça-yerel eğrisi */
function edgeCurve(mesh: ParsedMesh, index: number, sig: EdgeSig): Curve3[] | null {
  const be = mesh.brepEdges;
  const r = be?.ranges[index];
  if (!be || !r) return null;
  const pos = be.position;
  const pt = (seg: number, end: 0 | 1): Vec3 => {
    const o = seg * 6 + end * 3;
    return [pos[o], pos[o + 1], pos[o + 2]];
  };
  const a = pt(r.first, 0);
  const b = pt(r.last, 1);
  if (sig.kind === 'line') return [{ kind: 'line', a, b }];
  if (sig.kind === 'circle' && sig.center && sig.axis && sig.radius) {
    const n = norm3(sig.axis);
    if (len3(sub3(a, b)) < 1e-6 * Math.max(1, sig.radius)) return [{ kind: 'circle', c: sig.center, n, r: sig.radius }];
    // Yönü polyline'dan: a → (ikinci nokta) n etrafında ccw mi
    const m = pt(r.first, 1);
    const ccw = dot3(cross3(sub3(a, sig.center), sub3(m, sig.center)), n) > 0;
    return [ccw ? { kind: 'arc', c: sig.center, n, r: sig.radius, s: a, e: b } : { kind: 'arc', c: sig.center, n, r: sig.radius, s: b, e: a }];
  }
  return null;
}

// ---------------------------------------------------------------- Sketch'e izdüşüm

type Curve2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  | { kind: 'arc'; c: Vec2; r: number; s: Vec2; e: Vec2 };

const PARALLEL = 0.9995;

function toSketch(curves: Curve3[], M: Transform, plane: PlaneDef): Curve2[] | string {
  const n = norm3(plane.normal);
  const xs = norm3(plane.xDir);
  const ys = cross3(n, xs);
  const P = (p: Vec3): Vec2 => {
    const d = sub3(tPoint(M, p), plane.origin);
    return [dot3(d, xs), dot3(d, ys)];
  };
  const out: Curve2[] = [];
  for (const c of curves) {
    if (c.kind === 'line') {
      const a = P(c.a), b = P(c.b);
      if (d2(a, b) > 1e-6) out.push({ kind: 'line', a, b });
      continue;
    }
    const ax = dot3(norm3(tDir(M, c.n)), n);
    if (Math.abs(ax) < PARALLEL) return 'Daire/yay sketch düzlemine paralel değil';
    if (c.kind === 'circle') out.push({ kind: 'circle', c: P(c.c), r: c.r });
    else {
      const s = P(c.s), e = P(c.e);
      out.push(ax > 0 ? { kind: 'arc', c: P(c.c), r: c.r, s, e } : { kind: 'arc', c: P(c.c), r: c.r, s: e, e: s });
    }
  }
  return out.length ? out : 'Aktarılacak geometri yok (kenar düzleme dik olabilir)';
}

export interface ProjectResult {
  curves: Curve2[];
  /** Güncellenmiş kaynak referansı (gövde kaynaklarında imza yenilenir) */
  source: ExtRef;
}

/** Kaynağı gövdenin sketch düzlemine izdüşürür; hata metni ya da sonuç */
export function projectSource(doc: Doc, bodyId: string, plane: PlaneDef, source: ExtRef): ProjectResult | string {
  const pid = source.face?.partId ?? source.edge?.partId;
  const src = pid ? sourcePart(doc, pid) : null;
  if (!src) return 'Kaynak parça bulunamadı';
  const M = localToBody(doc, bodyId, src);
  if (!M) return 'Gövde bulunamadı';
  if (source.face) {
    const f = resolveFace(src.part, source.face);
    if (!f) return 'Kaynak yüz bulunamadı';
    if (f.geom.kind === 'plane') {
      const fn = norm3(tDir(M, f.geom.normal));
      if (Math.abs(dot3(fn, norm3(plane.normal))) < PARALLEL) return 'Yüzey sketch düzlemine paralel değil';
    } else if (f.geom.kind !== 'cylinder') return 'Yalnız düz ve silindirik yüzeyler aktarılabilir';
    const c3 = faceCurves(f.mesh, f.ref.faceIndex, f.geom);
    if (!c3) return 'Yüzey sınırı çıkarılamadı';
    const c2 = toSketch(c3, M, plane);
    return typeof c2 === 'string' ? c2 : { curves: c2, source: f.ref === source.face ? source : { ...source, face: f.ref } };
  }
  if (source.edge) {
    const e = resolveEdge(src.part, source.edge.sig);
    if (!e) return 'Kaynak kenar bulunamadı';
    const c3 = edgeCurve(e.mesh, e.index, e.sig);
    if (!c3) return 'Bu kenar türü aktarılamaz';
    const c2 = toSketch(c3, M, plane);
    const sameSig = JSON.stringify(e.sig) === JSON.stringify(source.edge.sig);
    return typeof c2 === 'string' ? c2 : { curves: c2, source: sameSig ? source : { ...source, edge: { partId: source.edge.partId, sig: e.sig } } };
  }
  return 'Geçersiz referans';
}

// ---------------------------------------------------------------- Sketch varlıkları

/** Eğrilerden kimlikleri kararlı sketch varlıkları (ext = projeksiyon id) */
export function buildProjectionEntities(projId: string, curves: Curve2[], prev?: Map<string, SkEntity>): SkEntity[] {
  const out: SkEntity[] = [];
  const ptIds = new Map<string, string>();
  let pk = 0, ck = 0;
  const pt = (p: Vec2): string => {
    const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
    let id = ptIds.get(key);
    if (!id) {
      id = `x${projId}_p${pk++}`;
      ptIds.set(key, id);
      out.push({ id, kind: 'point', x: p[0], y: p[1], ext: projId });
    }
    return id;
  };
  const cons = (id: string) => {
    const o = prev?.get(id);
    return o && o.kind !== 'point' && o.construction ? { construction: true } : {};
  };
  for (const c of curves) {
    if (c.kind === 'line') {
      const p1 = pt(c.a), p2 = pt(c.b);
      if (p1 === p2) continue;
      const id = `x${projId}_c${ck++}`;
      out.push({ id, kind: 'line', p1, p2, ext: projId, ...cons(id) });
    } else if (c.kind === 'circle') {
      const cc = pt(c.c);
      const id = `x${projId}_c${ck++}`;
      out.push({ id, kind: 'circle', c: cc, r: c.r, ext: projId, ...cons(id) });
    } else {
      const cc = pt(c.c), s = pt(c.s), e = pt(c.e);
      const id = `x${projId}_c${ck++}`;
      out.push({ id, kind: 'arc', c: cc, start: s, end: e, r: c.r, ext: projId, ...cons(id) });
    }
  }
  return out;
}

/** Aynı yapı mı (kimlikler, türler, nokta bağlantıları) */
function sameStructure(a: SkEntity[], b: SkEntity[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id || x.kind !== y.kind) return false;
    if (x.kind === 'line' && y.kind === 'line' && (x.p1 !== y.p1 || x.p2 !== y.p2)) return false;
    if (x.kind === 'circle' && y.kind === 'circle' && x.c !== y.c) return false;
    if (x.kind === 'arc' && y.kind === 'arc' && (x.c !== y.c || x.start !== y.start || x.end !== y.end)) return false;
  }
  return true;
}

const EPS = 1e-7;

function entitiesClose(a: SkEntity[], b: SkEntity[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.kind === 'point' && y.kind === 'point') {
      if (Math.abs(x.x - y.x) > EPS || Math.abs(x.y - y.y) > EPS) return false;
    } else if ((x.kind === 'circle' || x.kind === 'arc') && (y.kind === 'circle' || y.kind === 'arc')) {
      if (Math.abs(x.r - y.r) > EPS) return false;
    }
  }
  return true;
}

function planeClose(a: PlaneDef, b: PlaneDef): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.origin[i] - b.origin[i]) > EPS) return false;
    if (Math.abs(a.xDir[i] - b.xDir[i]) > 1e-9) return false;
    if (Math.abs(a.normal[i] - b.normal[i]) > 1e-9) return false;
  }
  return true;
}

// ---------------------------------------------------------------- Düzlem referansı

/** Kaynak yüzün dünya düzleminden parça-yerel düzlem (planeRef.local) */
export function localPlaneOf(doc: Doc, partId: string, world: PlaneDef): PlaneDef | null {
  const src = sourcePart(doc, partId);
  if (!src) return null;
  const inv = invertT(src.world);
  return { origin: tPoint(inv, world.origin), xDir: norm3(tDir(inv, world.xDir)), normal: norm3(tDir(inv, world.normal)) };
}

function resolvePlaneRef(
  doc: Doc,
  bodyId: string,
  pr: NonNullable<SketchFeature['planeRef']>,
): { plane: PlaneDef; ref: FaceRef; local: PlaneDef } | null {
  const src = sourcePart(doc, pr.ref.partId);
  if (!src) return null;
  const f = resolveFace(src.part, pr.ref);
  if (!f || f.geom.kind !== 'plane') return null;
  const n = norm3(f.geom.normal);
  let local = pr.local;
  const old = pr.ref.sig;
  if (old?.kind === 'plane' && f.geom.kind === 'plane') {
    // Gövde kaynağı: yüz (parametrik değişiklikle) kaydıysa düzlem yüz merkezinin kaymasını izler
    const delta = sub3(f.geom.point, old.point);
    if (len3(delta) > 1e-9) local = { ...local, origin: add3(local.origin, delta) };
  } else if (dot3(n, local.normal) > PARALLEL) {
    // İmzasız kaynak: yalnız normal boyunca izle
    const off = dot3(sub3(f.geom.point, local.origin), local.normal);
    if (Math.abs(off) > 1e-9) local = { ...local, origin: add3(local.origin, mul3(local.normal, off)) };
  }
  const M = localToBody(doc, bodyId, src);
  if (!M) return null;
  const plane: PlaneDef = {
    origin: tPoint(M, local.origin),
    xDir: norm3(tDir(M, local.xDir)),
    normal: norm3(tDir(M, local.normal)),
  };
  return { plane, ref: f.ref, local };
}

// ---------------------------------------------------------------- Yenileme

/** Sketch'in canlı referanslarını belgedeki güncel geometriyle yeniler (değişiklik yoksa aynı nesne) */
export function resolveSketch(doc: Doc, bodyId: string, sk: SketchFeature): SketchFeature {
  const live = sk.projections?.some((p) => !p.frozen);
  if (!sk.planeRef && !live) return sk;
  let out = sk;
  let geomChanged = false;

  if (sk.planeRef) {
    const r = resolvePlaneRef(doc, bodyId, sk.planeRef);
    if (!r) {
      if (!sk.planeRef.broken) out = { ...out, planeRef: { ...sk.planeRef, broken: true } };
    } else {
      if (!planeClose(r.plane, sk.plane)) {
        out = { ...out, plane: r.plane };
        geomChanged = true;
      }
      if (r.ref !== sk.planeRef.ref || r.local !== sk.planeRef.local || sk.planeRef.broken) {
        out = { ...out, planeRef: { ref: r.ref, local: r.local } };
      }
    }
  }

  if (live && sk.projections) {
    let entities = out.entities;
    const byId = new Map(entities.map((e) => [e.id, e]));
    const projections: SkProjection[] = sk.projections.map((p) => {
      if (p.frozen) return p;
      const r = projectSource(doc, bodyId, out.plane, p.source);
      if (typeof r === 'string') return p.broken ? p : { ...p, broken: true };
      const fresh = buildProjectionEntities(p.id, r.curves, byId);
      const old = p.entityIds.map((id) => byId.get(id)).filter((e): e is SkEntity => !!e);
      if (old.length !== p.entityIds.length || !sameStructure(old, fresh)) return p.broken ? p : { ...p, broken: true };
      if (!entitiesClose(old, fresh)) {
        const map = new Map(fresh.map((e) => [e.id, e]));
        entities = entities.map((e) => map.get(e.id) ?? e);
        geomChanged = true;
      }
      return p.broken || r.source !== p.source ? { ...p, source: r.source, broken: undefined } : p;
    });
    const projChanged = projections.some((p, i) => p !== sk.projections![i]);
    if (entities !== out.entities || projChanged) out = { ...out, entities, ...(projChanged ? { projections } : {}) };
  }

  // Kullanıcı geometrisi referanslara kısıtlıysa onlarla birlikte gelsin
  if (geomChanged && isSketchSolverReady()) {
    try {
      const r = solveSketch(out.entities, out.constraints);
      if (r.status === 'ok') out = { ...out, entities: r.entities };
    } catch (e) {
      console.error('Sketch çözülemedi (dış referans)', e);
    }
  }
  return out;
}

/** Gövdenin tüm sketch'lerini yeniler (değişiklik yoksa aynı nesne) */
export function resolveBody(doc: Doc, body: Body): Body {
  if (!liveSourcesOf(doc, body).length) return body;
  let changed = false;
  const features = body.features.map((f) => {
    if (f.type !== 'sketch' || f.suppressed) return f;
    const r = resolveSketch(doc, body.id, f);
    if (r !== f) changed = true;
    return r;
  });
  return changed ? { ...body, features } : body;
}

/** Gövdenin kaynak parçalarının konum/geometri anahtarı (değişince yeniden çözülür) */
export function sourcesKey(doc: Doc, body: Body): string {
  const ids = liveSourcesOf(doc, body);
  if (!ids.length) return '';
  const frame = bodyFrameIn(doc, body.id);
  const parts: string[] = [frame ? JSON.stringify(frame) : ''];
  for (const id of ids) {
    const s = sourcePart(doc, id);
    if (!s) continue;
    parts.push(id, JSON.stringify(s.world), String(fileVersion(s.part.fileId)));
  }
  return parts.join('|');
}

const versions = new WeakMap<object, number>();
let versionSeq = 0;
function fileVersion(fileId: string): number {
  const f = geometryCache.get(fileId);
  if (!f) return -1;
  let v = versions.get(f);
  if (v === undefined) versions.set(f, (v = ++versionSeq));
  return v;
}

/** Yüz referansına imza ekler (gövde kaynaklarında yeniden eşleme için) */
export function faceRefWithSig(doc: Doc, ref: FaceRef): FaceRef {
  const part = doc.parts.find((p) => p.id === ref.partId);
  if (!part || !isBodyFileId(part.fileId)) return ref;
  const g = getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  return g && g.kind !== 'other' ? { ...ref, sig: g, sigArea: faceArea(part, ref.meshIndex, ref.faceIndex) } : ref;
}
