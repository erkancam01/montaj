// Gövde yüzlerinin imzayla yeniden eşlenmesi (parametrik değişiklik sonrası aynı yüzü bulmak için).
import { getFaceGeom } from '../lib/faceGeometry';
import { geometryCache } from '../lib/geometryCache';
import type { FaceGeom, Part, Vec3 } from '../types';

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

export function matchFace(
  part: Pick<Part, 'fileId' | 'nodeKey'>,
  sig: FaceGeom,
  sigArea?: number,
): { meshIndex: number; faceIndex: number; geom: FaceGeom; area: number } | null {
  const node = geometryCache.get(part.fileId)?.nodes[part.nodeKey];
  if (!node || sig.kind === 'other') return null;
  // Alan uyumsuzluğu, parçanın bir boyu kadar kaymaya denk cezalandırılır
  const diag = Math.max(1, Math.hypot(...node.size));
  const areaPenalty = (a: number) => (sigArea && sigArea > 0 && a > 0 ? Math.abs(Math.log(a / sigArea)) * diag : 0);
  let best = null as { meshIndex: number; faceIndex: number; geom: FaceGeom; score: number; area: number } | null;
  node.meshes.forEach((m, mi) => {
    for (let fi = 0; fi < m.faces.length; fi++) {
      const g = getFaceGeom(part, mi, fi);
      if (!g || g.kind !== sig.kind) continue;
      let score: number;
      if (g.kind === 'plane' && sig.kind === 'plane') {
        if (dot(g.normal, sig.normal) < 0.999) continue;
        const off = Math.abs(dot(sub(g.point, sig.point), sig.normal));
        // düzlem kayması önce, sonra yüz merkezinin yakınlığı
        score = off * 10 + len(sub(g.point, sig.point));
      } else if (g.kind === 'cylinder' && sig.kind === 'cylinder') {
        if (Math.abs(Math.abs(dot(g.axis, sig.axis)) - 1) > 1e-3) continue;
        const v = sub(g.point, sig.point);
        const along = dot(v, sig.axis);
        const perp = len([v[0] - along * sig.axis[0], v[1] - along * sig.axis[1], v[2] - along * sig.axis[2]]);
        score = perp * 10 + Math.abs(along) + Math.abs(g.radius - sig.radius) * 20;
      } else continue;
      const area = faceArea(part, mi, fi);
      score += areaPenalty(area);
      if (!best || score < best.score) best = { meshIndex: mi, faceIndex: fi, geom: g, score, area };
    }
  });
  return best ? { meshIndex: best.meshIndex, faceIndex: best.faceIndex, geom: best.geom, area: best.area } : null;
}

