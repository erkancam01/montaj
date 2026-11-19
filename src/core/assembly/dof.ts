// Serbestlik derecesi analizi (saf): mate kısıtlarının Jacobian'ı üzerinden hangi gövdelerin hâlâ hareket
// edebildiği bulunur. Kökler (sabit ya da canlı referansla kilitli gövdeler) hareket etmez; diğer her gövdenin
// 6 bilinmeyeni vardır (küçük dönme ω, öteleme v; nokta hızı = v + ω × (x − c)).
// Jacobian'ın sıfır uzayı bir gövdenin sütunlarına dokunuyorsa o gövde eksik tanımlıdır.
import { Quaternion, Vector3 } from 'three';
import type { Doc, FaceGeom, Mate, Part } from '@/core/types';
import { getFaceGeom } from '@/core/geometry/faceGeometry';
import { lockedPartIds } from '@/core/modeling/refLocks';

export type PartDofState = 'fixed' | 'under' | 'full';

type GeomOf = (part: Part, meshIndex: number, faceIndex: number) => FaceGeom | null;

interface WorldFace {
  p: Vector3;
  d: Vector3;
}

function worldFace(doc: Doc, part: Part, g: FaceGeom): WorldFace | null {
  if (g.kind === 'other') return null;
  const inst = doc.instances.find((i) => i.id === part.instanceId);
  if (!inst) return null;
  const qi = new Quaternion().fromArray(inst.quaternion);
  const qw = qi.clone().multiply(new Quaternion().fromArray(part.quaternion));
  const pw = new Vector3().fromArray(part.position).applyQuaternion(qi).add(new Vector3().fromArray(inst.position));
  const p = new Vector3().fromArray(g.point).applyQuaternion(qw).add(pw);
  const d = new Vector3().fromArray(g.kind === 'plane' ? g.normal : g.axis).applyQuaternion(qw).normalize();
  return { p, d };
}

function perpPair(d: Vector3): [Vector3, Vector3] {
  const u = Math.abs(d.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u1 = u.addScaledVector(d, -u.dot(d)).normalize();
  const u2 = new Vector3().crossVectors(d, u1).normalize();
  return [u1, u2];
}

function compatible(type: Mate['type'], a: FaceGeom, b: FaceGeom): boolean {
  if (type === 'coincident') return a.kind === 'plane' && b.kind === 'plane';
  if (type === 'concentric') return a.kind === 'cylinder' && b.kind === 'cylinder';
  return a.kind !== 'other' && b.kind !== 'other';
}

/**
 * Her parçanın durumu: fixed (Part.fixed), full (tam tanımlı: sabit / kilitli gövdeye göre hareket edemez,
 * sabit grubun diğer üyeleri ve kilitli gövdeler dahil), under (en az bir serbestlik kalmış).
 */
export function partDofStates(doc: Doc, geomOf: GeomOf = getFaceGeom): Map<string, PartDofState> {
  const out = new Map<string, PartDofState>();
  const parts = new Map(doc.parts.map((p) => [p.id, p]));
  const groupOf = new Map<string, string>();
  for (const g of doc.groups ?? []) for (const id of g.partIds) if (!groupOf.has(id)) groupOf.set(id, g.id);
  const bodyOf = (id: string) => groupOf.get(id) ?? id;

  const locked = lockedPartIds(doc);
  const roots = new Set<string>();
  for (const p of doc.parts) if (p.fixed === true || locked.has(p.id)) roots.add(bodyOf(p.id));

  // Gövde merkezleri (koşullama için): üye parça pivotlarının ortalaması
  const centerSum = new Map<string, { c: Vector3; n: number }>();
  for (const p of doc.parts) {
    const inst = doc.instances.find((i) => i.id === p.instanceId);
    if (!inst) continue;
    const w = new Vector3().fromArray(p.position).applyQuaternion(new Quaternion().fromArray(inst.quaternion)).add(new Vector3().fromArray(inst.position));
    const b = bodyOf(p.id);
    const e = centerSum.get(b);
    if (e) {
      e.c.add(w);
      e.n++;
    } else centerSum.set(b, { c: w, n: 1 });
  }
  const center = (b: string) => {
    const e = centerSum.get(b);
    return e ? e.c.clone().divideScalar(e.n) : new Vector3();
  };

  // Bilinmeyen sütunları: kök olmayan, mate'i olan gövdeler
  const col = new Map<string, number>();
  const rows: Map<number, number>[] = [];
  const colOf = (b: string): number => {
    let c = col.get(b);
    if (c === undefined) {
      c = col.size * 6;
      col.set(b, c);
    }
    return c;
  };
  /** Satıra gövde katkısı: ω katsayısı w, v katsayısı t (işaret s) */
  const add = (row: Map<number, number>, b: string, w: Vector3, t: Vector3 | null, s: number) => {
    if (roots.has(b)) return;
    const c0 = colOf(b);
    const vals = [w.x, w.y, w.z, t ? t.x : 0, t ? t.y : 0, t ? t.z : 0];
    for (let k = 0; k < 6; k++) if (vals[k] !== 0) row.set(c0 + k, (row.get(c0 + k) ?? 0) + s * vals[k]);
  };
  /** f = d_b · u (u a'ya bağlı) */
  const dirRow = (A: string, B: string, db: Vector3, u: Vector3) => {
    const row = new Map<number, number>();
    const w = new Vector3().crossVectors(db, u);
    add(row, B, w, null, 1);
    add(row, A, w, null, -1);
    rows.push(row);
  };
  /** f = (x_b − x_a) · u (u a'ya bağlı) */
  const posRow = (A: string, B: string, xb: Vector3, u: Vector3) => {
    const row = new Map<number, number>();
    add(row, B, new Vector3().subVectors(xb, center(B)).cross(u), u, 1);
    add(row, A, new Vector3().subVectors(xb, center(A)).cross(u), u, -1);
    rows.push(row);
  };

  for (const m of doc.mates) {
    if (m.suppressed) continue;
    const pa = parts.get(m.a.partId);
    const pb = parts.get(m.b.partId);
    if (!pa || !pb || pa.id === pb.id) continue;
    const A = bodyOf(pa.id);
    const B = bodyOf(pb.id);
    if (A === B || (roots.has(A) && roots.has(B))) continue;
    const ga = geomOf(pa, m.a.meshIndex, m.a.faceIndex);
    const gb = geomOf(pb, m.b.meshIndex, m.b.faceIndex);
    if (!ga || !gb || !compatible(m.type, ga, gb)) continue;
    const fa = worldFace(doc, pa, ga);
    const fb = worldFace(doc, pb, gb);
    if (!fa || !fb) continue;
    const [u1, u2] = perpPair(fa.d);
    let parallel = m.type === 'coincident' || m.type === 'concentric' || m.type === 'parallel';
    if (m.type === 'angle') {
      const a = ((m.flip ? 180 - m.angle : m.angle) % 180 + 180) % 180;
      parallel = a < 1e-3 || a > 180 - 1e-3;
    }
    if (parallel) {
      dirRow(A, B, fb.d, u1);
      dirRow(A, B, fb.d, u2);
    } else dirRow(A, B, fb.d, fa.d);
    if (m.type === 'coincident') posRow(A, B, fb.p, fa.d);
    else if (m.type === 'concentric') {
      posRow(A, B, fb.p, u1);
      posRow(A, B, fb.p, u2);
    }
  }

  const n = col.size * 6;
  const underBodies = new Set<string>();
  if (n) {
    // Yoğun matris, sütun ölçekleme (dönme sütunları mm mertebesinde)
    const M = rows.map((r) => {
      const a = new Float64Array(n);
      for (const [k, v] of r) a[k] = v;
      return a;
    });
    const scale = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let mx = 0;
      for (const r of M) mx = Math.max(mx, Math.abs(r[j]));
      scale[j] = mx > 0 ? 1 / mx : 1;
      for (const r of M) r[j] *= scale[j];
    }
    const TOL = 1e-7;
    const pivotCols: number[] = [];
    const isPivot = new Uint8Array(n);
    let rank = 0;
    for (let j = 0; j < n && rank < M.length; j++) {
      let best = rank;
      for (let i = rank + 1; i < M.length; i++) if (Math.abs(M[i][j]) > Math.abs(M[best][j])) best = i;
      if (Math.abs(M[best][j]) < TOL) continue;
      [M[rank], M[best]] = [M[best], M[rank]];
      const pr = M[rank];
      const pv = pr[j];
      for (let k = j; k < n; k++) pr[k] /= pv;
      for (let i = 0; i < M.length; i++) {
        if (i === rank) continue;
        const f = M[i][j];
        if (f === 0) continue;
        const ri = M[i];
        for (let k = j; k < n; k++) ri[k] -= f * pr[k];
      }
      pivotCols.push(j);
      isPivot[j] = 1;
      rank++;
    }
    // Sıfır uzayı: her serbest sütun f için x_f = 1, x_pivot(i) = −M[i][f]
    const bodyOfCol = (j: number) => Math.floor(j / 6);
    const names = [...col.keys()];
    const touched = new Uint8Array(col.size);
    for (let f = 0; f < n; f++) {
      if (isPivot[f]) continue;
      touched[bodyOfCol(f)] = 1;
      for (let i = 0; i < pivotCols.length; i++) if (Math.abs(M[i][f]) > 1e-6) touched[bodyOfCol(pivotCols[i])] = 1;
    }
    for (let b = 0; b < names.length; b++) if (touched[b]) underBodies.add(names[b]);
  }

  for (const p of doc.parts) {
    const b = bodyOf(p.id);
    if (p.fixed === true) out.set(p.id, 'fixed');
    else if (roots.has(b)) out.set(p.id, 'full');
    else if (!col.has(b) || underBodies.has(b)) out.set(p.id, 'under');
    else out.set(p.id, 'full');
  }
  return out;
}
