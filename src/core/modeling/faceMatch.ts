// Gövde yüzlerinin imzayla yeniden eşlenmesi (parametrik değişiklik sonrası aynı yüzü bulmak için).
import { getFaceGeom } from '@/core/geometry/faceGeometry';
import { geometryCache } from '@/core/geometry/geometryCache';
import type { FaceGeom, FaceOrigin, FaceRef, Part, Vec3 } from '@/core/types';
import { originCandidates, originsOf } from '@/core/modeling/faceOrigin';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/**
 * sig'e en uygun yüzü bulur. Önce birebir (aynı düzlem / aynı eksen-yarıçap), yoksa parametrik
 * değişikliğe dayanıklı eşleşme: aynı tür ve yön, en yakın konum (ör. yüksekliği değişen üst yüz).
 */
/** Yüzün alanı (mm², parça-yerel) */
export function faceArea(part: Pick<Part, 'fileId' | 'nodeKey'>, meshIndex: number, faceIndex: number): number {
  const m = geometryCache.get(part.fileId)?.nodes[part.nodeKey]?.meshes[meshIndex];
  const f = m?.faces[faceIndex];
  if (!m || !f) return 0;
  const pos = m.geometry.getAttribute('position');
  const idx = m.geometry.index;
  let a = 0;
  for (let t = f.first; t <= f.last; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const ux = pos.getX(i1) - pos.getX(i0), uy = pos.getY(i1) - pos.getY(i0), uz = pos.getZ(i1) - pos.getZ(i0);
    const vx = pos.getX(i2) - pos.getX(i0), vy = pos.getY(i2) - pos.getY(i0), vz = pos.getZ(i2) - pos.getZ(i0);
    a += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return a;
}

/**
 * sig'e göre aday yüzün puanı (küçük = iyi; null = uyumsuz: farklı tür/yön). diag: parça köşegeni (alan
 * uyumsuzluğu bir parça boyu kaymaya denk cezalandırılır). Saf fonksiyon.
 */
export function faceScore(sig: FaceGeom, sigArea: number | undefined, g: FaceGeom, area: number, diag: number): number | null {
  let score: number;
  if (g.kind === 'plane' && sig.kind === 'plane') {
    if (dot(g.normal, sig.normal) < 0.999) return null;
    const off = Math.abs(dot(sub(g.point, sig.point), sig.normal));
    // düzlem kayması önce, sonra yüz merkezinin yakınlığı
    score = off * 10 + len(sub(g.point, sig.point));
  } else if (g.kind === 'cylinder' && sig.kind === 'cylinder') {
    if (Math.abs(Math.abs(dot(g.axis, sig.axis)) - 1) > 1e-3) return null;
    const v = sub(g.point, sig.point);
    const along = dot(v, sig.axis);
    const perp = len([v[0] - along * sig.axis[0], v[1] - along * sig.axis[1], v[2] - along * sig.axis[2]]);
    score = perp * 10 + Math.abs(along) + Math.abs(g.radius - sig.radius) * 20;
  } else return null;
  if (sigArea && sigArea > 0 && area > 0) score += Math.abs(Math.log(area / sigArea)) * diag;
  return score;
}

export interface FaceMatch {
  meshIndex: number;
  faceIndex: number;
  geom: FaceGeom;
  area: number;
}

export function matchFace(
  part: Pick<Part, 'fileId' | 'nodeKey'>,
  sig: FaceGeom,
  sigArea?: number,
  /** Yalnız bu yüzler arasında ara */
  only?: { meshIndex: number; faceIndex: number }[],
): FaceMatch | null {
  const node = geometryCache.get(part.fileId)?.nodes[part.nodeKey];
  if (!node || sig.kind === 'other') return null;
  const diag = Math.max(1, Math.hypot(...node.size));
  const list = only ?? node.meshes.flatMap((m, mi) => m.faces.map((_, fi) => ({ meshIndex: mi, faceIndex: fi })));
  let best = null as (FaceMatch & { score: number }) | null;
  for (const { meshIndex: mi, faceIndex: fi } of list) {
    const g = getFaceGeom(part, mi, fi);
    if (!g || g.kind !== sig.kind) continue;
    const area = faceArea(part, mi, fi);
    const score = faceScore(sig, sigArea, g, area, diag);
    if (score === null) continue;
    if (!best || score < best.score) best = { meshIndex: mi, faceIndex: fi, geom: g, score, area };
  }
  return best ? { meshIndex: best.meshIndex, faceIndex: best.faceIndex, geom: best.geom, area: best.area } : null;
}

/**
 * Gövde yüz referansını güncel geometride bulur: önce aynı kökenli yüzler (tek aday → o; birden çok →
 * imza+alan yakınlığı), köken yoksa/bulunamazsa imzayla en yakın yüz. origin: yeni referansa yazılacak köken
 * (eski köken bulunamadıysa korunur — özellik geri gelince yeniden bağlanır).
 */
export function matchFaceRef(part: Pick<Part, 'fileId' | 'nodeKey'>, ref: FaceRef): (FaceMatch & { origin?: FaceOrigin }) | null {
  const origins = originsOf(part.fileId, part.nodeKey);
  if (ref.origin && origins) {
    const cands = originCandidates(origins, ref.origin);
    if (cands.length) {
      let m: FaceMatch | null = null;
      if (cands.length > 1 && ref.sig && ref.sig.kind !== 'other') m = matchFace(part, ref.sig, ref.sigArea, cands);
      if (!m) {
        const c = cands[0];
        const g = getFaceGeom(part, c.meshIndex, c.faceIndex);
        if (g && g.kind !== 'other') m = { ...c, geom: g, area: faceArea(part, c.meshIndex, c.faceIndex) };
      }
      if (m) return { ...m, origin: ref.origin };
    }
  }
  if (!ref.sig || ref.sig.kind === 'other') return null;
  const m = matchFace(part, ref.sig, ref.sigArea);
  if (!m) return null;
  return { ...m, origin: ref.origin ?? origins?.[m.meshIndex]?.[m.faceIndex] };
}

/** matchFaceRef sonucunu referansa uygular; değişiklik yoksa aynı nesne döner */
export function applyFaceMatch(ref: FaceRef, m: FaceMatch & { origin?: FaceOrigin }): FaceRef {
  const same =
    m.meshIndex === ref.meshIndex &&
    m.faceIndex === ref.faceIndex &&
    JSON.stringify(m.geom) === JSON.stringify(ref.sig) &&
    JSON.stringify(m.origin) === JSON.stringify(ref.origin);
  if (same) return ref;
  const next: FaceRef = { ...ref, meshIndex: m.meshIndex, faceIndex: m.faceIndex, sig: m.geom, sigArea: m.area };
  if (m.origin) next.origin = m.origin;
  else delete next.origin;
  return next;
}

/** Gövde yüz referansına imza + köken ekler (mate/projeksiyon kurulurken) */
export function faceRefSig(part: Pick<Part, 'fileId' | 'nodeKey'>, ref: FaceRef): FaceRef {
  const g = getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  if (!g || g.kind === 'other') return ref;
  const next: FaceRef = { ...ref, sig: g, sigArea: faceArea(part, ref.meshIndex, ref.faceIndex) };
  const o = originsOf(part.fileId, part.nodeKey)?.[ref.meshIndex]?.[ref.faceIndex];
  if (o) next.origin = o;
  else delete next.origin;
  return next;
}

