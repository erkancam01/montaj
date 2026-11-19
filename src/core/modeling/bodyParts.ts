// Çizilen gövdenin montajdaki parçaları (saf: yalnız belge verisi).
// Gövdenin her ayrı katısı montajda ayrı bir parçadır: ilk katı gövdenin asıl parçası (solidKey yok,
// gövde çerçevesi bu parçadan alınır), "Sonucu birleştir" kapalı üretilen ya da kesmeyle bölünen
// diğer katılar ek parçalardır (solidKey = çekirdekteki katı anahtarı).
import type { Doc, Group, Mate, Part } from '@/core/types';
import { bodyFileId } from '@/core/types';

/** Gövdenin asıl parçası (gövde çerçevesi bunun dünya dönüşümüdür) */
export function bodyPrimaryPart(doc: Pick<Doc, 'parts'>, bodyId: string): Part | undefined {
  const fid = bodyFileId(bodyId);
  return doc.parts.find((p) => p.fileId === fid && !p.solidKey) ?? doc.parts.find((p) => p.fileId === fid);
}

/** Ek parçanın adı: "Parça 1 (2)" */
export function solidPartName(bodyName: string, nodeKey: number): string {
  return `${bodyName} (${nodeKey + 1})`;
}

/**
 * Gövdenin parçalarını çekirdeğin ürettiği katı anahtarlarıyla eşler: asıl parça ilk katıyı gösterir,
 * ek parçalar anahtarlarının yeni sırasını alır, kaybolan katının parçası (ve ona bağlı mate'ler) silinir,
 * yeni katı için asıl parçanın yerinde ek parça açılır. Değişiklik yoksa aynı belge döner.
 */
export function syncSolidParts(doc: Doc, bodyId: string, keys: string[], newId: () => string): Doc {
  const fid = bodyFileId(bodyId);
  const primary = bodyPrimaryPart(doc, bodyId);
  const body = doc.bodies.find((b) => b.id === bodyId);
  if (!primary || !body) return doc;
  let changed = false;
  const removed = new Set<string>();
  const parts: Part[] = [];
  for (const p of doc.parts) {
    if (p.fileId !== fid) {
      parts.push(p);
      continue;
    }
    if (p === primary) {
      if (p.nodeKey !== 0 || p.solidKey) {
        changed = true;
        const { solidKey: _k, ...rest } = p;
        void _k;
        parts.push({ ...rest, nodeKey: 0 });
      } else parts.push(p);
      continue;
    }
    const idx = p.solidKey ? keys.indexOf(p.solidKey) : -1;
    if (idx < 1) {
      changed = true;
      removed.add(p.id);
      continue;
    }
    if (idx !== p.nodeKey) {
      changed = true;
      parts.push({ ...p, nodeKey: idx });
    } else parts.push(p);
  }
  const claimed = new Set(parts.filter((p) => p.fileId === fid && p.solidKey).map((p) => p.solidKey));
  keys.forEach((key, i) => {
    if (i === 0 || claimed.has(key)) return;
    changed = true;
    const { solidKey: _k, fixed, ...base } = primary;
    void _k;
    parts.push({
      ...base,
      id: newId(),
      nodeKey: i,
      solidKey: key,
      name: solidPartName(body.name, i),
      // Yeni katı serbest başlar (asıl parça sabit olsa da taşınabilsin)
      ...(fixed !== undefined ? { fixed: false } : {}),
    });
  });
  if (!changed) return doc;
  if (!removed.size) return { ...doc, parts };
  const mates: Mate[] = doc.mates.filter((m) => !removed.has(m.a.partId) && !removed.has(m.b.partId));
  const groups: Group[] = doc.groups
    .map((g) => (g.partIds.some((id) => removed.has(id)) ? { ...g, partIds: g.partIds.filter((id) => !removed.has(id)) } : g))
    .filter((g) => g.partIds.length > 1);
  return { ...doc, parts, mates, groups };
}
