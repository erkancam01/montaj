// Belge üzerinde geri alınabilir işlemler. Arayüz ve kısayollar bunları çağırır.
import { getFaceGeom } from '../lib/faceGeometry';
import { withFaceSig } from '../modeling/bodyManager';
import { geometryCache } from '../lib/geometryCache';
import { FACE_KIND_LABELS, MATE_LABELS, mateCompatible, suggestMateType } from '../lib/mateMeta';
import { initialMateParams } from '../lib/mateSolver';
import { IDENTITY_QUAT, composeT, invertT, uid } from '../lib/math';
import {
  applyWorldDelta,
  bodyIdOf,
  centerOfParts,
  makeGroupFrame,
  partWorldOf,
  partsOfItem,
  selectedPartIds,
  groupOfPart,
} from '../lib/rigid';
import type {
  FaceRef,
  Group,
  Instance,
  Mate,
  MateType,
  ObjKind,
  Part,
  Quat,
  SelKind,
  Selection,
  SourceFileMeta,
  Transform,
  Vec3,
} from '../types';
import { applyTransform, useAssembly } from './useAssembly';

const st = () => useAssembly.getState();

export function setTransform(kind: ObjKind, id: string, position: Vec3, quaternion: Quat, mergeKey?: string) {
  st().commit((doc) => applyTransform(doc, kind, id, position, quaternion), mergeKey);
}

export function resetTransform(sel: Selection) {
  if (!sel) return;
  st().commit((doc) => {
    if (sel.kind === 'instance') {
      return { ...doc, instances: doc.instances.map((i) => (i.id === sel.id ? { ...i, ...i.origin } : i)) };
    }
    const ids = new Set(partsOfItem(doc, sel));
    return { ...doc, parts: doc.parts.map((p) => (ids.has(p.id) ? { ...p, ...p.origin } : p)) };
  });
}

export function rename(kind: SelKind, id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  st().commit((doc) =>
    kind === 'instance'
      ? { ...doc, instances: doc.instances.map((i) => (i.id === id ? { ...i, name: n } : i)) }
      : kind === 'group'
        ? { ...doc, groups: doc.groups.map((g) => (g.id === id ? { ...g, name: n } : g)) }
        : { ...doc, parts: doc.parts.map((p) => (p.id === id ? { ...p, name: n } : p)) },
  );
}

/** Grup için tüm üyelere uygular */
export function setVisible(kind: SelKind, id: string, visible: boolean) {
  st().commit((doc) => {
    if (kind === 'instance') {
      return { ...doc, instances: doc.instances.map((i) => (i.id === id ? { ...i, visible } : i)) };
    }
    const ids = new Set(partsOfItem(doc, { kind, id }));
    return { ...doc, parts: doc.parts.map((p) => (ids.has(p.id) ? { ...p, visible } : p)) };
  });
}

/** Grup: herhangi bir üye görünürse hepsini gizler, değilse hepsini gösterir */
export function toggleVisible(sel: Selection) {
  if (!sel) return;
  const { doc } = st();
  if (sel.kind === 'instance') {
    const inst = doc.instances.find((i) => i.id === sel.id);
    if (inst) setVisible('instance', sel.id, !inst.visible);
    return;
  }
  const ids = new Set(partsOfItem(doc, sel));
  const anyVisible = doc.parts.some((p) => ids.has(p.id) && p.visible);
  setVisible(sel.kind, sel.id, !anyVisible);
}

/** Instance ve grup için tüm parçalarına uygular. null = STEP rengine dön. */
export function setColor(kind: SelKind, id: string, color: string | null) {
  st().commit((doc) => {
    const ids = new Set(partsOfItem(doc, { kind, id }));
    return { ...doc, parts: doc.parts.map((p) => (ids.has(p.id) ? { ...p, color } : p)) };
  }, `color:${id}`);
}

/** Yeni içe aktarılan dosyayı belgeye ekler ve örneği seçer */
export function addImported(file: SourceFileMeta, instance: Instance, parts: Part[]) {
  st().commit((doc) => ({
    ...doc,
    files: doc.files.some((f) => f.id === file.id) ? doc.files : [...doc.files, file],
    instances: [...doc.instances, instance],
    parts: [...doc.parts, ...parts],
  }));
  st().select({ kind: 'instance', id: instance.id });
}

/** Ayrıştırılmış dosyadan yeni instance + parçalar üretir (orijinal STEP koordinatları korunur) */
export function buildInstance(fileId: string, name: string): { instance: Instance; parts: Part[] } | null {
  const parsed = geometryCache.get(fileId);
  if (!parsed) return null;
  const instanceId = uid();
  const c = parsed.center;
  const instance: Instance = {
    id: instanceId,
    fileId,
    name,
    position: [...c],
    quaternion: [...IDENTITY_QUAT],
    origin: { position: [...c], quaternion: [...IDENTITY_QUAT] },
    visible: true,
  };
  const parts: Part[] = parsed.nodes.map((n) => {
    const position: Vec3 = [n.center[0] - c[0], n.center[1] - c[1], n.center[2] - c[2]];
    return {
      id: uid(),
      instanceId,
      fileId,
      nodeKey: n.key,
      name: n.name,
      position,
      quaternion: [...IDENTITY_QUAT],
      origin: { position: [...position], quaternion: [...IDENTITY_QUAT] },
      visible: true,
      color: null,
    };
  });
  return { instance, parts };
}

/** Seçimi kopyalar; kopya X yönünde boyutu kadar kaydırılır ve seçilir */
export function duplicate(sel: Selection) {
  if (!sel) return;
  const { doc } = st();
  if (sel.kind === 'instance') {
    const inst = doc.instances.find((i) => i.id === sel.id);
    if (!inst) return;
    const dx = (geometryCache.get(inst.fileId)?.size[0] ?? 100) * 1.1;
    const newId = uid();
    const copy: Instance = {
      ...inst,
      id: newId,
      name: `${inst.name} (kopya)`,
      position: [inst.position[0] + dx, inst.position[1], inst.position[2]],
    };
    const parts = doc.parts.filter((p) => p.instanceId === inst.id).map((p) => ({ ...p, id: uid(), instanceId: newId }));
    st().commit((d) => ({ ...d, instances: [...d.instances, copy], parts: [...d.parts, ...parts] }));
    st().select({ kind: 'instance', id: newId });
  } else if (sel.kind === 'group') {
    const g = doc.groups.find((x) => x.id === sel.id);
    if (!g) return;
    const members = g.partIds.map((id) => doc.parts.find((p) => p.id === id)).filter((p): p is Part => !!p);
    // Kopya, grubun X genişliği kadar dünyada yana kaydırılır
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of members) {
      const w = partWorldOf(doc, p.id);
      if (!w) continue;
      const half = (geometryCache.get(p.fileId)?.nodes[p.nodeKey]?.size[0] ?? 0) / 2;
      minX = Math.min(minX, w.position[0] - half);
      maxX = Math.max(maxX, w.position[0] + half);
    }
    const dx = Number.isFinite(minX) ? Math.max(maxX - minX, 1) * 1.1 : 100;
    const idMap = new Map(members.map((p) => [p.id, uid()]));
    const copies = members.map((p) => ({ ...p, id: idMap.get(p.id)!, name: `${p.name} (kopya)` }));
    const newGroup: Group = {
      ...g,
      id: uid(),
      name: `${g.name} (kopya)`,
      partIds: members.map((p) => idMap.get(p.id)!),
    };
    st().commit((d) =>
      applyWorldDelta({ ...d, parts: [...d.parts, ...copies], groups: [...d.groups, newGroup] }, newGroup.partIds, {
        position: [dx, 0, 0],
        quaternion: [...IDENTITY_QUAT],
      }),
    );
    st().select({ kind: 'group', id: newGroup.id });
  } else {
    const part = doc.parts.find((p) => p.id === sel.id);
    if (!part) return;
    const node = geometryCache.get(part.fileId)?.nodes[part.nodeKey];
    const dx = (node?.size[0] ?? 50) * 1.1;
    const copy: Part = {
      ...part,
      id: uid(),
      name: `${part.name} (kopya)`,
      position: [part.position[0] + dx, part.position[1], part.position[2]],
    };
    st().commit((d) => ({ ...d, parts: [...d.parts, copy] }));
    st().select({ kind: 'part', id: copy.id });
  }
}

/** Seçimi siler (grup: üye parçaları siler). Son parçası silinen instance da kaldırılır. */
export function remove(sel: Selection) {
  if (!sel) return;
  if (sel.kind === 'group') {
    removeParts(partsOfItem(st().doc, sel));
    return;
  }
  st().commit((doc) => {
    if (sel.kind === 'instance') {
      const parts = doc.parts.filter((p) => p.instanceId !== sel.id);
      return {
        ...doc,
        instances: doc.instances.filter((i) => i.id !== sel.id),
        parts,
        mates: matesOf(doc, parts),
      };
    }
    const part = doc.parts.find((p) => p.id === sel.id);
    if (!part) return doc;
    const parts = doc.parts.filter((p) => p.id !== sel.id);
    const instances = parts.some((p) => p.instanceId === part.instanceId)
      ? doc.instances
      : doc.instances.filter((i) => i.id !== part.instanceId);
    return { ...doc, parts, instances, mates: matesOf(doc, parts) };
  });
  st().select(null);
}

/** Silinen parçalara bağlı mate'leri atar */
function matesOf(doc: { mates: Mate[] }, parts: Part[]): Mate[] {
  const ids = new Set(parts.map((p) => p.id));
  const kept = doc.mates.filter((m) => ids.has(m.a.partId) && ids.has(m.b.partId));
  return kept.length === doc.mates.length ? doc.mates : kept;
}

// ---------------------------------------------------------------- Mate'ler

const sameFace = (x: FaceRef, y: FaceRef) =>
  x.partId === y.partId && x.meshIndex === y.meshIndex && x.faceIndex === y.faceIndex;

function faceGeomOf(ref: FaceRef) {
  const part = st().doc.parts.find((p) => p.id === ref.partId);
  return part ? getFaceGeom(part, ref.meshIndex, ref.faceIndex) : null;
}

/**
 * Mate aracında bir yüzeye tıklanınca çağrılır.
 * İlk tıklama referans yüzeyi seçer, ikincisi mate'i kurar (ikinci yüzeyin parçası hareket eder).
 */
export function pickFace(ref: FaceRef) {
  const { pendingFace, setPendingFace, showToast } = st();
  const g = faceGeomOf(ref);
  if (!g) return;
  if (g.kind === 'other') {
    showToast('Bu yüzey düz ya da silindirik değil; mate için kullanılamaz.', 'error');
    return;
  }
  if (!pendingFace) {
    setPendingFace(ref);
    return;
  }
  if (sameFace(pendingFace, ref)) {
    setPendingFace(null);
    return;
  }
  if (pendingFace.partId === ref.partId) {
    showToast('Aynı parçanın iki yüzeyi arasında mate kurulamaz.', 'error');
    return;
  }
  if (sameBody(pendingFace.partId, ref.partId)) {
    showToast('Aynı rijit gruptaki parçalar arasında mate kurulamaz.', 'error');
    return;
  }
  setPendingFace(null);
  addMate(withFaceSig(pendingFace), withFaceSig(ref));
}

/** Yeni mate kurar (tip verilmezse yüzeylere göre önerilir), seçer ve çözer */
export function addMate(a: FaceRef, b: FaceRef, type?: MateType): string | null {
  const ga = faceGeomOf(a);
  const gb = faceGeomOf(b);
  if (!ga || !gb) return null;
  const t = type ?? suggestMateType(ga, gb);
  if (!t || !mateCompatible(t, ga, gb)) {
    st().showToast(
      `${FACE_KIND_LABELS[ga.kind]} ile ${FACE_KIND_LABELS[gb.kind]} arasında bu mate kurulamaz.`,
      'error',
    );
    return null;
  }
  const { doc } = st();
  const n = doc.mates.filter((m) => m.type === t).length + 1;
  const base = { id: uid(), name: `${MATE_LABELS[t]} ${n}`, type: t, a, b, offset: 0, suppressed: false };
  const mate: Mate = { ...base, ...initialMateParams(base, doc) };
  st().commit((d) => ({ ...d, mates: [...d.mates, mate] }));
  st().selectMate(mate.id);
  return mate.id;
}

/** Mate alanlarını değiştirir. Tip değişirse uyumluluk kontrol edilir ve flip/angle yeniden önerilir. */
export function updateMate(id: string, patch: Partial<Omit<Mate, 'id' | 'a' | 'b'>>) {
  const { doc } = st();
  const m = doc.mates.find((x) => x.id === id);
  if (!m) return;
  let next: Mate = { ...m, ...patch };
  if (patch.type && patch.type !== m.type) {
    const ga = faceGeomOf(m.a);
    const gb = faceGeomOf(m.b);
    if (!ga || !gb || !mateCompatible(patch.type, ga, gb)) {
      st().showToast('Bu yüzeyler için bu mate tipi uygun değil.', 'error');
      return;
    }
    next = { ...next, ...initialMateParams(next, doc) };
  }
  // Yalnızca sayı alanlarının art arda değişimleri tek geri alma adımı olur
  const key = 'offset' in patch ? `mate:${id}:offset` : 'angle' in patch ? `mate:${id}:angle` : undefined;
  st().commit((d) => ({ ...d, mates: d.mates.map((x) => (x.id === id ? next : x)) }), key);
}

/** Referans ile hareketli tarafı değiştirir */
export function swapMate(id: string) {
  st().commit((d) => ({
    ...d,
    mates: d.mates.map((m) => {
      if (m.id !== id) return m;
      const swapped = { ...m, a: m.b, b: m.a };
      // Yeni yönlere göre en az dönüş gerektiren flip/açı
      return { ...swapped, ...initialMateParams(swapped, d) };
    }),
  }));
}

export function removeMate(id: string) {
  st().commit((d) => ({ ...d, mates: d.mates.filter((m) => m.id !== id) }));
  if (st().mateSelection === id) st().selectMate(null);
}

// ---------------------------------------------------------------- Çoklu seçim ve rijit gruplar

/** Parçaları siler; parçası kalmayan instance'lar ve bağlı mate'ler kaldırılır (gruplar commit'te temizlenir) */
export function removeParts(partIds: string[]) {
  if (!partIds.length) return;
  const ids = new Set(partIds);
  st().commit((doc) => {
    const parts = doc.parts.filter((p) => !ids.has(p.id));
    const used = new Set(parts.map((p) => p.instanceId));
    return { ...doc, parts, instances: doc.instances.filter((i) => used.has(i.id)), mates: matesOf(doc, parts) };
  });
  st().select(null);
}

/** Birincil + ek seçimin tamamını siler (Delete tuşu) */
export function removeSelection() {
  const { selection, extraSel, doc } = st();
  if (!selection) return;
  if (!extraSel.length) {
    remove(selection);
    return;
  }
  removeParts(selectedPartIds(doc, selection, extraSel));
}

/**
 * Sahnede / ağaçta bir parçaya tıklanınca seçim kuralı.
 * - additive (Ctrl/Shift): öğeyi ek seçime ekler/çıkarır.
 * - direct=false (sahne): parça bir gruptaysa grup seçilir; selectMode 'instance' ise instance seçilir.
 * - direct=true (ağaç satırı): parçanın kendisi seçilir (gruptaki tek parçayı ayrı oynatmak için).
 */
export function clickPart(partId: string, opts: { additive?: boolean; direct?: boolean } = {}) {
  const s = st();
  const part = s.doc.parts.find((p) => p.id === partId);
  if (!part) return;
  if (!opts.direct && !opts.additive && s.ui.selectMode === 'instance') {
    s.select({ kind: 'instance', id: part.instanceId });
    return;
  }
  const group = opts.direct ? undefined : groupOfPart(s.doc, partId);
  const item = group ? ({ kind: 'group', id: group.id } as const) : ({ kind: 'part', id: partId } as const);
  if (opts.additive) s.toggleExtra(item);
  else s.select(item);
}

/** Seçili parçaları (birincil + ek; seçili grupların üyeleri dahil) tek rijit grupta birleştirir ve grubu seçer */
export function groupSelection(name?: string): string | null {
  const s = st();
  const ids = selectedPartIds(s.doc, s.selection, s.extraSel);
  if (ids.length < 2) {
    s.showToast('Gruplamak için en az iki parça seçin (Ctrl+tık ile ekleyin).', 'error');
    return null;
  }
  const center = centerOfParts(s.doc, ids);
  const frame = center && makeGroupFrame(s.doc, ids[0], center);
  if (!frame) return null;
  const group: Group = { id: uid(), name: name?.trim() || `Grup ${s.doc.groups.length + 1}`, partIds: ids, frame };
  const set = new Set(ids);
  st().commit((d) => ({
    ...d,
    // Seçilen parçalar eski gruplarından çıkar (2'den az üyeli kalan gruplar commit'te silinir)
    groups: [
      ...d.groups.map((g) =>
        g.partIds.some((id) => set.has(id)) ? { ...g, partIds: g.partIds.filter((id) => !set.has(id)) } : g,
      ),
      group,
    ],
  }));
  st().select({ kind: 'group', id: group.id });
  return group.id;
}

/** Grubu çözer; üyeler yerinde kalır ve birlikte seçili kalır */
export function ungroup(groupId: string) {
  const g = st().doc.groups.find((x) => x.id === groupId);
  if (!g) return;
  st().commit((d) => ({ ...d, groups: d.groups.filter((x) => x.id !== groupId) }));
  const [first, ...rest] = g.partIds;
  st().select({ kind: 'part', id: first });
  for (const id of rest) st().toggleExtra({ kind: 'part', id });
}

/** Parçaları dünyada delta ile rijit taşır (geri alınabilir) */
export function moveRigid(partIds: string[], delta: Transform, mergeKey?: string) {
  st().commit((d) => applyWorldDelta(d, partIds, delta), mergeKey);
}

/** Rijit kümenin pivotunu yeni dünya dönüşümüne taşır (özellik panelinden sayısal düzenleme) */
export function setRigidPivot(partIds: string[], oldPivot: Transform, newPivot: Transform, mergeKey?: string) {
  moveRigid(partIds, composeT(newPivot, invertT(oldPivot)), mergeKey);
}

/** İki parça aynı rijit gövdede mi (aynı parça ya da aynı grup) */
export function sameBody(partA: string, partB: string): boolean {
  const { doc } = st();
  return bodyIdOf(doc, partA) === bodyIdOf(doc, partB);
}
