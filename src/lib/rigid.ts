// Rijit gruplar ve çoklu seçim için ortak yardımcılar (saf fonksiyonlar).
import type { Doc, ExtraSel, Group, Selection, Transform } from '../types';
import { IDENTITY_QUAT, composeT, invertT, partLocalFromWorld, partWorld, relT } from './math';

/** Parçanın dünya dönüşümü (instance ∘ part); bulunamazsa null */
export function partWorldOf(doc: Doc, partId: string): Transform | null {
  const part = doc.parts.find((p) => p.id === partId);
  const inst = part && doc.instances.find((i) => i.id === part.instanceId);
  return part && inst ? partWorld(inst, part) : null;
}

/** Parçanın ait olduğu grup (yoksa undefined) */
export function groupOfPart(doc: Doc, partId: string): Group | undefined {
  return doc.groups.find((g) => g.partIds.includes(partId));
}

/** Grubun dünya çerçevesi (pivot) = partWorld(anchor) ∘ frame */
export function groupFrameWorld(doc: Doc, group: Group): Transform | null {
  const anchor = partWorldOf(doc, group.partIds[0]);
  return anchor ? composeT(anchor, group.frame) : null;
}

/**
 * Verilen parçaları dünyada aynı delta ile taşır: yeniDünya = delta ∘ eskiDünya.
 * Grup çerçeveleri anchor'a bağlı olduğundan kendiliğinden takip eder.
 */
export function applyWorldDelta(doc: Doc, partIds: string[], delta: Transform): Doc {
  if (!partIds.length) return doc;
  const ids = new Set(partIds);
  const inst = new Map(doc.instances.map((i) => [i.id, i]));
  let changed = false;
  const parts = doc.parts.map((p) => {
    if (!ids.has(p.id)) return p;
    const i = inst.get(p.instanceId);
    if (!i) return p;
    const local = partLocalFromWorld(i, composeT(delta, partWorld(i, p)));
    changed = true;
    return { ...p, position: local.position, quaternion: local.quaternion };
  });
  return changed ? { ...doc, parts } : doc;
}

/** Bir seçim öğesinin kapsadığı parça id'leri */
export function partsOfItem(doc: Doc, item: { kind: string; id: string }): string[] {
  if (item.kind === 'part') return doc.parts.some((p) => p.id === item.id) ? [item.id] : [];
  if (item.kind === 'group') return doc.groups.find((g) => g.id === item.id)?.partIds ?? [];
  if (item.kind === 'instance') return doc.parts.filter((p) => p.instanceId === item.id).map((p) => p.id);
  return [];
}

/** Birincil seçim + ek seçimlerin kapsadığı tüm parça id'leri (tekrarsız, sıralı) */
export function selectedPartIds(doc: Doc, selection: Selection, extra: ExtraSel[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...(selection ? [selection] : []), ...extra]) {
    for (const id of partsOfItem(doc, item)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Parça kümesinin dünya merkezi (parça pivotları = parça bounding box merkezleri; min/max ortası) */
export function centerOfParts(doc: Doc, partIds: string[]): [number, number, number] | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of partIds) {
    const w = partWorldOf(doc, id);
    if (!w) continue;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], w.position[k]);
      max[k] = Math.max(max[k], w.position[k]);
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/**
 * Gizmo ve özellik paneli için "rijit küme": birlikte taşınacak parçalar ve pivot (dünya).
 * - Grup seçiliyse (ek seçim yok): üyeler + grup çerçevesi.
 * - Ek seçim varsa: tüm seçili parçalar + merkezde, dönüşsüz pivot.
 * - Tek parça / instance seçimi: null (normal yol kullanılır).
 */
export function rigidSetOf(
  doc: Doc,
  selection: Selection,
  extra: ExtraSel[],
): { partIds: string[]; pivot: Transform } | null {
  if (!selection || selection.kind === 'instance') return null;
  if (selection.kind === 'group' && !extra.length) {
    const g = doc.groups.find((x) => x.id === selection.id);
    const pivot = g && groupFrameWorld(doc, g);
    return g && pivot ? { partIds: [...g.partIds], pivot } : null;
  }
  if (!extra.length) return null;
  const partIds = selectedPartIds(doc, selection, extra);
  const c = centerOfParts(doc, partIds);
  return c ? { partIds, pivot: { position: c, quaternion: [...IDENTITY_QUAT] } } : null;
}

/** Yeni grup çerçevesi: dünyada `center`'da, dönüşsüz; anchor'ın yerel koordinatında ifade edilir */
export function makeGroupFrame(doc: Doc, anchorId: string, center: [number, number, number]): Transform | null {
  const anchor = partWorldOf(doc, anchorId);
  return anchor ? relT(anchor, { position: center, quaternion: [...IDENTITY_QUAT] }) : null;
}

/**
 * Parça silme/ekleme sonrası grupları tutarlı tutar (store.commit her değişiklikte çağırır):
 * var olmayan parçaları gruptan çıkarır, 2'den az üyeli grubu siler,
 * anchor değiştiyse çerçeveyi dünyadaki yeri değişmeyecek şekilde yeni anchor'a taşır.
 * prev = değişiklikten önceki belge (eski anchor'ın dünyası için).
 */
export function cleanupGroups(prev: Doc, next: Doc): Doc {
  if (!next.groups.length) return next;
  const alive = new Set(next.parts.map((p) => p.id));
  let changed = false;
  const groups: Group[] = [];
  for (const g of next.groups) {
    const partIds = g.partIds.filter((id) => alive.has(id));
    if (partIds.length < 2) {
      changed = true;
      continue;
    }
    if (partIds.length === g.partIds.length) {
      groups.push(g);
      continue;
    }
    changed = true;
    let frame = g.frame;
    if (partIds[0] !== g.partIds[0]) {
      const oldWorld = groupFrameWorld(prev, g);
      const newAnchor = partWorldOf(next, partIds[0]);
      if (oldWorld && newAnchor) frame = composeT(invertT(newAnchor), oldWorld);
    }
    groups.push({ ...g, partIds, frame });
  }
  return changed ? { ...next, groups } : next;
}

/** Bir parça hangi rijit gövdeye ait: grup id'si ya da parça id'si (mate çözücü ve kontroller için) */
export function bodyIdOf(doc: Doc, partId: string): string {
  return groupOfPart(doc, partId)?.id ?? partId;
}

