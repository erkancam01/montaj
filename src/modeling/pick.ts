// Modelleme seçim isteği süzgeçleri (sahne bileşenleri kullanır)
import { getFaceGeom } from '../lib/faceGeometry';
import { useAssembly } from '../store/useAssembly';
import type { EdgeSig, FaceRef, PickRequest } from '../types';
import { bodyFileId } from '../types';

/** Yüzey bu istek için seçilebilir mi (gövde ve tür süzgeci) */
export function pickableFace(pick: PickRequest, ref: FaceRef): boolean {
  const part = useAssembly.getState().doc.parts.find((p) => p.id === ref.partId);
  if (!part) return false;
  if (pick.bodyId && part.fileId !== bodyFileId(pick.bodyId)) return false;
  const faceFilter = pick.filter?.filter((f) => f === 'plane' || f === 'cylinder');
  if (!faceFilter?.length) return true;
  const g = getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  return !!g && (faceFilter as string[]).includes(g.kind);
}

/** Kenar bu istek için seçilebilir mi */
export function pickableEdge(pick: PickRequest, partId: string, sig: EdgeSig): boolean {
  if (!pick.kinds.includes('edge')) return false;
  const part = useAssembly.getState().doc.parts.find((p) => p.id === partId);
  if (!part) return false;
  if (pick.bodyId && part.fileId !== bodyFileId(pick.bodyId)) return false;
  const edgeFilter = pick.filter?.filter((f) => f === 'line' || f === 'circle');
  return !edgeFilter?.length || (edgeFilter as string[]).includes(sig.kind);
}
