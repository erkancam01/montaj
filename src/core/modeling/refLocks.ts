// Canlı dış referansların bağımlılık bilgisi (saf: yalnız belge verisine bakar; store/çözücü buradan okur).
// Bir gövdenin sketch'i başka bir parçanın yüzüne/kenarına canlı bağlıysa gövde "kilitli"dir: konumunu
// referanslarından alır, doğrudan taşınamaz.
import type { Body, Doc } from '@/core/types';
import { bodyFileId, isBodyFileId, bodyIdOfFile } from '@/core/types';

/** Gövdenin kendi parça id'leri */
export function ownPartIds(doc: Doc, bodyId: string): Set<string> {
  const fid = bodyFileId(bodyId);
  return new Set(doc.parts.filter((p) => p.fileId === fid).map((p) => p.id));
}

/** Gövdenin canlı referans verdiği (başka) parça id'leri; yalnız var olan parçalar */
export function liveSourcesOf(doc: Doc, body: Body): string[] {
  const own = ownPartIds(doc, body.id);
  const out = new Set<string>();
  for (const f of body.features) {
    if (f.type !== 'sketch' || f.suppressed) continue;
    if (f.planeRef) out.add(f.planeRef.ref.partId);
    for (const p of f.projections ?? []) {
      if (p.frozen) continue;
      const pid = p.source.face?.partId ?? p.source.edge?.partId;
      if (pid) out.add(pid);
    }
  }
  const exists = new Set(doc.parts.map((p) => p.id));
  return [...out].filter((id) => !own.has(id) && exists.has(id));
}

/** Gövdede canlı dış referans var mı */
export function hasLiveRefs(doc: Doc, bodyId: string): boolean {
  const b = doc.bodies.find((x) => x.id === bodyId);
  return !!b && liveSourcesOf(doc, b).length > 0;
}

/** Kilitli (canlı referanslı gövdelere ait) parça id'leri */
export function lockedPartIds(doc: Doc): Set<string> {
  const out = new Set<string>();
  if (!doc.bodies?.length) return out;
  for (const b of doc.bodies) {
    if (!liveSourcesOf(doc, b).length) continue;
    for (const id of ownPartIds(doc, b.id)) out.add(id);
  }
  return out;
}

/** Parça bir gövdeye aitse gövde id'si */
function bodyOfPart(doc: Doc, partId: string): string | null {
  const p = doc.parts.find((x) => x.id === partId);
  return p && isBodyFileId(p.fileId) ? bodyIdOfFile(p.fileId) : null;
}

/** fromBodyId (dolaylı da olsa) targetBodyId'nin geometrisine canlı bağlı mı */
export function bodyDependsOn(doc: Doc, fromBodyId: string, targetBodyId: string): boolean {
  const seen = new Set<string>();
  const stack = [fromBodyId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === targetBodyId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const b = doc.bodies.find((x) => x.id === id);
    if (!b) continue;
    for (const pid of liveSourcesOf(doc, b)) {
      const sb = bodyOfPart(doc, pid);
      if (sb) stack.push(sb);
    }
  }
  return false;
}

/** bodyId'ye sourcePartId'den canlı referans eklemek döngü oluşturur mu */
export function wouldCycle(doc: Doc, bodyId: string, sourcePartId: string): boolean {
  const sb = bodyOfPart(doc, sourcePartId);
  return !!sb && sb !== bodyId && bodyDependsOn(doc, sb, bodyId);
}
