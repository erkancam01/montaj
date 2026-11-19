// IndexedDB kalıcılığı (idb-keyval) ve proje paketi (.zip) okuma/yazma.
import { clear, createStore, del, get, keys, set } from 'idb-keyval';
import JSZip from 'jszip';
import type { Doc } from '@/core/types';

const store = createStore('step-montaj', 'kv');
const DOC_KEY = 'doc';
const FILE_PREFIX = 'file:';
const fileKey = (id: string) => `${FILE_PREFIX}${id}`;

export async function saveBlob(id: string, blob: Blob): Promise<void> {
  await set(fileKey(id), blob, store);
}

export async function loadBlob(id: string): Promise<Blob | undefined> {
  const v = await get<Blob>(fileKey(id), store);
  return v instanceof Blob ? v : undefined;
}

export async function deleteBlob(id: string): Promise<void> {
  await del(fileKey(id), store);
}

export async function saveDoc(doc: Doc): Promise<void> {
  await set(DOC_KEY, doc, store);
}

export async function loadDoc(): Promise<Doc | undefined> {
  const v = await get<unknown>(DOC_KEY, store);
  return isDoc(v) ? v : undefined;
}

export async function clearAll(): Promise<void> {
  await clear(store);
}

/** keepIds dışındaki tüm kaynak dosya blob'larını siler */
export async function pruneBlobs(keepIds: Set<string>): Promise<void> {
  const all = await keys(store);
  const stale = all.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(FILE_PREFIX) && !keepIds.has(k.slice(FILE_PREFIX.length)),
  );
  await Promise.all(stale.map((k) => del(k, store)));
}

// ---------------------------------------------------------------------------
// Proje paketi

const APP_ID = 'step-montaj';
const ZIP_VERSION = 1;
const PROJECT_JSON = 'project.json';

interface ProjectJson {
  app: string;
  version: number;
  doc: Doc;
}

function isDoc(v: unknown): v is Doc {
  if (!v || typeof v !== 'object') return false;
  const d = v as Partial<Doc>;
  return Array.isArray(d.files) && Array.isArray(d.instances) && Array.isArray(d.parts);
}

/** Dosya adını zip içi yol için güvenli hale getirir */
function safeName(name: string): string {
  const n = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return n || 'dosya';
}

export async function buildProjectZip(doc: Doc): Promise<Blob> {
  const zip = new JSZip();
  const data: ProjectJson = { app: APP_ID, version: ZIP_VERSION, doc };
  zip.file(PROJECT_JSON, JSON.stringify(data, null, 2));
  const missing: string[] = [];
  for (const f of doc.files) {
    const blob = await loadBlob(f.id);
    if (!blob) {
      missing.push(f.name);
      continue;
    }
    zip.file(`files/${f.id}/${safeName(f.name)}`, blob, { binary: true });
  }
  if (missing.length) console.warn('Pakete eklenemeyen kaynak dosyalar (bulunamadı):', missing);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function readProjectZip(file: Blob): Promise<{ doc: Doc; blobs: Map<string, Blob> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('Geçersiz proje dosyası: zip açılamadı.');
  }
  const entry = zip.file(PROJECT_JSON);
  if (!entry) throw new Error('Geçersiz proje dosyası: project.json bulunamadı.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await entry.async('string'));
  } catch {
    throw new Error('Geçersiz proje dosyası: project.json okunamadı.');
  }
  const pj = parsed as Partial<ProjectJson> | null;
  if (!pj || pj.app !== APP_ID || !isDoc(pj.doc)) {
    throw new Error('Geçersiz proje dosyası: bu uygulamaya ait bir proje değil.');
  }
  if (typeof pj.version !== 'number' || pj.version > ZIP_VERSION) {
    throw new Error('Proje dosyası bu uygulama sürümünden daha yeni, açılamıyor.');
  }
  const doc = pj.doc;

  const blobs = new Map<string, Blob>();
  for (const f of doc.files) {
    const prefix = `files/${f.id}/`;
    const match = zip.file(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^/]+$`))[0];
    if (match) blobs.set(f.id, await match.async('blob'));
  }
  return { doc, blobs };
}
