// Katı → BodyMesh (ParsedMesh uyumlu üçgenler + B-rep yüz aralıkları + kenar çizgileri ve imzaları)
import type { Shape3D } from 'replicad';
import type { Body, EdgeSig, Vec3 } from '@/core/types';
import { bboxInfo, buildShape, edgeSig, errText } from '@/services/kernel/build';
import type { BodyBuildResult, BodyMesh } from '@/services/kernel/kernelApi';

/** Gövde boyutuna göre tessellation hassasiyeti */
export function meshOptions(shape: Shape3D): { tolerance: number; angularTolerance: number } {
  const { diag } = bboxInfo(shape);
  return { tolerance: Math.max(0.01, diag * 1e-3), angularTolerance: 0.2 };
}

export function meshShape(shape: Shape3D, opts = meshOptions(shape)): BodyMesh {
  const m = shape.mesh(opts);
  const position = new Float32Array(m.vertices);
  const normal = new Float32Array(m.normals.length === m.vertices.length ? m.normals : []);
  const index = new Uint32Array(m.triangles);
  const faces = m.faceGroups
    .filter((g) => g.count >= 3)
    .sort((a, b) => a.start - b.start)
    .map((g) => ({ first: g.start / 3, last: (g.start + g.count) / 3 - 1 }));

  const em = shape.meshEdges(opts);
  const byHash = new Map<number, ReturnType<typeof shapeEdges>[number][]>();
  for (const e of shapeEdges(shape)) {
    const list = byHash.get(e.hashCode);
    if (list) list.push(e);
    else byHash.set(e.hashCode, [e]);
  }
  const ranges: { first: number; last: number }[] = [];
  const sigs: EdgeSig[] = [];
  for (const g of em.edgeGroups) {
    if (g.count < 2) continue;
    const first = g.start / 2;
    const last = first + g.count / 2 - 1;
    let sig: EdgeSig | null = null;
    const cands = byHash.get(g.edgeId);
    if (cands && cands.length) {
      try {
        sig = edgeSig(cands[0]);
      } catch {
        sig = null;
      }
    }
    if (!sig) {
      // Yedek: çizgi parçalarından yaklaşık imza
      const k = g.start + Math.floor(g.count / 2) - (Math.floor(g.count / 2) % 2);
      const mid: Vec3 = [em.lines[k * 3], em.lines[k * 3 + 1], em.lines[k * 3 + 2]];
      let length = 0;
      for (let i = g.start; i < g.start + g.count; i += 2) {
        length += Math.hypot(
          em.lines[(i + 1) * 3] - em.lines[i * 3],
          em.lines[(i + 1) * 3 + 1] - em.lines[i * 3 + 1],
          em.lines[(i + 1) * 3 + 2] - em.lines[i * 3 + 2],
        );
      }
      sig = { kind: 'other', mid, length };
    }
    ranges.push({ first, last });
    sigs.push(sig);
  }
  return {
    position,
    normal,
    index,
    faces,
    edges: { position: new Float32Array(em.lines), ranges, sigs },
  };
}

const shapeEdges = (s: Shape3D) => s.edges;

/** postMessage için aktarılabilir tamponlar */
export function meshTransferables(r: BodyBuildResult): ArrayBuffer[] {
  return r.solids.flatMap(({ mesh: m }) => [m.position.buffer, m.normal.buffer, m.index.buffer, m.edges.position.buffer] as ArrayBuffer[]);
}

/** Gövdeyi üretir ve mesh'ler (worker ve testler için senkron giriş noktası) */
export function buildBodyMesh(body: Body): BodyBuildResult {
  const { shape, solids, featureErrors } = buildShape(body);
  if (!shape) return { solids: [], featureErrors };
  try {
    // Tüm katılar aynı hassasiyetle (gövde boyutuna göre)
    const opts = meshOptions(shape);
    return { solids: solids.map((s) => ({ key: s.key, mesh: meshShape(s.shape, opts) })), featureErrors };
  } catch (e) {
    throw new Error(errText(e, 'Görüntü ağı üretilemedi'));
  }
}
