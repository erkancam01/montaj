// Sketch projeksiyon aracı: tıklanan noktadaki parça yüzünü ya da (çizilmiş gövdelerde) B-rep kenarını bulur.
// Sketch oturumunda sahne tıklamaları sketch katmanına gittiği için burada kendi raycast'imizi yaparız.
import { Raycaster, Vector2, Vector3, type Mesh, type Object3D } from 'three';
import { faceAtTriangle } from '@/core/geometry/faceGeometry';
import { geometryCache } from '@/core/geometry/geometryCache';
import { objectRegistry } from '@/ui/viewport/registry';
import { useAssembly } from '@/state/useAssembly';
import type { ExtRef } from '@/core/types';
import { isBodyFileId } from '@/core/types';
import { view } from '@/ui/sketch/view';

const EDGE_PX = 7;
const _ray = new Raycaster();
const _a = new Vector3();
const _b = new Vector3();

function visibleParts() {
  const doc = useAssembly.getState().doc;
  const instVisible = new Map(doc.instances.map((i) => [i.id, i.visible]));
  return doc.parts.filter((p) => p.visible && instVisible.get(p.instanceId));
}

/** Ekran (istemci) noktasındaki yüz/kenar referansı */
export function pickProjectionSource(clientX: number, clientY: number): ExtRef | null {
  const cam = view.camera;
  const dom = view.dom;
  if (!cam || !dom) return null;
  const r = dom.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  cam.updateMatrixWorld();
  const parts = visibleParts();

  // 1) Gövde kenarları (ekran mesafesi)
  const toScreen = (v: Vector3) => {
    v.project(cam);
    return v.z >= -1 && v.z <= 1 ? { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height } : null;
  };
  const px = clientX - r.left;
  const py = clientY - r.top;
  let bestEdge: { partId: string; index: number; d: number } | null = null;
  for (const part of parts) {
    if (!isBodyFileId(part.fileId)) continue;
    const group = objectRegistry.get(part.id);
    const mesh = geometryCache.get(part.fileId)?.nodes[part.nodeKey]?.meshes.find((m) => m.brepEdges);
    const be = mesh?.brepEdges;
    if (!group || !be) continue;
    group.updateWorldMatrix(true, false);
    const mw = group.matrixWorld;
    const pos = be.position;
    be.ranges.forEach((rg, ei) => {
      const k = be.sigs[ei]?.kind;
      if (k !== 'line' && k !== 'circle') return;
      for (let s = rg.first; s <= rg.last; s++) {
        const o = s * 6;
        if (o + 5 >= pos.length) break;
        const sa = toScreen(_a.set(pos[o], pos[o + 1], pos[o + 2]).applyMatrix4(mw));
        const sb = toScreen(_b.set(pos[o + 3], pos[o + 4], pos[o + 5]).applyMatrix4(mw));
        if (!sa || !sb) continue;
        const dx = sb.x - sa.x, dy = sb.y - sa.y;
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - sa.x) * dx + (py - sa.y) * dy) / L2)) : 0;
        const d = Math.hypot(sa.x + t * dx - px, sa.y + t * dy - py);
        if (d < EDGE_PX && (!bestEdge || d < bestEdge.d)) bestEdge = { partId: part.id, index: ei, d };
      }
    });
  }
  const be = bestEdge as { partId: string; index: number; d: number } | null;

  // 2) Yüzler (raycast)
  _ray.setFromCamera(ndc, cam);
  const objs: Object3D[] = [];
  for (const p of parts) {
    const o = objectRegistry.get(p.id);
    if (o) objs.push(o);
  }
  const hits = _ray.intersectObjects(objs, true);
  let face: ExtRef | null = null;
  for (const h of hits) {
    const id = h.object.userData as { partId?: unknown; meshIndex?: unknown };
    if (!(h.object as Mesh).isMesh || typeof id.partId !== 'string' || typeof id.meshIndex !== 'number') continue;
    const part = parts.find((p) => p.id === id.partId);
    const mesh = part && geometryCache.get(part.fileId)?.nodes[part.nodeKey]?.meshes[id.meshIndex];
    if (!mesh || h.faceIndex == null) continue;
    const fi = faceAtTriangle(mesh, h.faceIndex);
    if (fi < 0) continue;
    face = { face: { partId: id.partId, meshIndex: id.meshIndex, faceIndex: fi } };
    break;
  }

  if (be) {
    const part = parts.find((p) => p.id === be.partId)!;
    const sig = geometryCache.get(part.fileId)?.nodes[part.nodeKey]?.meshes.find((m) => m.brepEdges)?.brepEdges?.sigs[be.index];
    if (sig) return { edge: { partId: be.partId, sig } };
  }
  return face;
}
