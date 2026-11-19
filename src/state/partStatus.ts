// Parça sabitlik / tanımlılık durumu (SolidWorks tarzı ağaç işaretleri: (f) sabit, (-) eksik tanımlı).
import { useAssembly } from '@/state/useAssembly';
import type { Doc, FileStatus } from '@/core/types';
import { partDofStates, type PartDofState } from '@/core/assembly/dof';

export type PartStatusMark = '' | '(-)' | '(f)';

// Belge (ve geometri yükleme durumu) değişmedikçe tüm parçaların durumu bir kez hesaplanır
const cache = new WeakMap<Doc, { fs: Record<string, FileStatus>; states: Map<string, PartDofState> }>();

/** Tüm parçaların serbestlik durumu (önbellekli) */
export function partStates(doc: Doc, fileStatus: Record<string, FileStatus>): Map<string, PartDofState> {
  const hit = cache.get(doc);
  if (hit && hit.fs === fileStatus) return hit.states;
  let states: Map<string, PartDofState>;
  try {
    states = partDofStates(doc);
  } catch (e) {
    console.error('Serbestlik analizi hatası', e);
    states = new Map();
  }
  cache.set(doc, { fs: fileStatus, states });
  return states;
}

export function markOf(state: PartDofState | undefined): PartStatusMark {
  return state === 'fixed' ? '(f)' : state === 'full' ? '' : '(-)';
}

/** Ağaç satırı işareti: '(f)' sabit, '(-)' serbestlik kalmış, '' tam tanımlı */
export function usePartStatusMark(partId: string): '' | '(-)' | '(f)' {
  return useAssembly((s) => markOf(partStates(s.doc, s.fileStatus).get(partId)));
}

export function isPartFixed(partId: string): boolean {
  return useAssembly.getState().doc.parts.find((p) => p.id === partId)?.fixed === true;
}

/**
 * Parçayı sabitler / serbest bırakır (geri alınabilir). Parça rijit gruptaysa grubun tüm üyelerine uygulanır
 * (grup tek gövdedir). Serbest bırakma `fixed: false` yazar: varsayılan sabitlik bir daha uygulanmaz.
 */
export function setPartFixed(partId: string, fixed: boolean): void {
  const st = useAssembly.getState();
  const g = st.doc.groups.find((x) => x.partIds.includes(partId));
  const ids = new Set(g ? g.partIds : [partId]);
  if (!st.doc.parts.some((p) => ids.has(p.id) && (p.fixed === true) !== fixed)) return;
  st.commit((d) => ({ ...d, parts: d.parts.map((p) => (ids.has(p.id) ? { ...p, fixed } : p)) }));
}
