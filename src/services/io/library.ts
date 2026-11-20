// Parça kütüphanesi (tasarım kütüphanesi) kalıcılığı: projeden ayrı bir IndexedDB veritabanında klasör /
// öğe listesi ve dosya içerikleri. Yeni proje / proje .zip açma kütüphaneyi silmez. Taşımak için
// kütüphane .zip'i dışa / içe aktarılır.
import { createStore, del, get, set } from 'idb-keyval';
import JSZip from 'jszip';
import { uid } from '@/core/math/math';
import { folderSubtree, useLibrary, type LibFolder, type LibItem, type LibraryIndex } from '@/state/libraryStore';
import { useAssembly } from '@/state/useAssembly';
import { formatFromName } from '@/services/io/formats';
import { renderThumbnail } from '@/services/io/libraryThumb';
import { importFiles } from '@/services/io/session';
import { parseCadFile } from '@/services/io/stepLoader';

const store = createStore('step-montaj-lib', 'kv');
const INDEX_KEY = 'index';
const blobKey = (id: string) => `blob:${id}`;

const lib = () => useLibrary.getState();
const toast = (t: string, kind?: 'error' | 'info') => useAssembly.getState().showToast(t, kind);

function isIndex(v: unknown): v is LibraryIndex {
  if (!v || typeof v !== 'object') return false;
  const ix = v as Partial<LibraryIndex>;
  return Array.isArray(ix.folders) && Array.isArray(ix.items);
}

// ---------------------------------------------------------------------------
// Dizin kaydı (yazmalar sıraya dizilir ki eski liste yenisini ezmesin)

let writeChain: Promise<void> = Promise.resolve();

function commit(next: LibraryIndex) {
  lib().setIndex(next);
  const snapshot: LibraryIndex = { folders: next.folders, items: next.items };
  writeChain = writeChain
    .then(() => set(INDEX_KEY, snapshot, store))
    .catch((e) => {
      console.error('Kütüphane kaydedilemedi:', e);
      toast('Kütüphane tarayıcıya kaydedilemedi', 'error');
    });
}

const current = (): LibraryIndex => ({ folders: lib().folders, items: lib().items });

let loadPromise: Promise<void> | null = null;

/** Açılışta kütüphaneyi yükler (birden çok çağrıya dayanıklı); eksik küçük resimleri sıraya koyar */
export function loadLibrary(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const v = await get<unknown>(INDEX_KEY, store);
        lib().setIndex(isIndex(v) ? v : { folders: [], items: [] });
      } catch (e) {
        console.error('Kütüphane okunamadı:', e);
        lib().setIndex({ folders: [], items: [] });
      }
      for (const it of lib().items) if (it.thumb === undefined) queueThumb(it.id);
    })();
  }
  return loadPromise;
}

// ---------------------------------------------------------------------------
// Küçük resimler (arka planda, sırayla)

const thumbQueue: string[] = [];
let thumbRunning = false;

function queueThumb(id: string) {
  if (!thumbQueue.includes(id)) thumbQueue.push(id);
  lib().setBusy(id, true);
  if (!thumbRunning) void runThumbs();
}

async function runThumbs() {
  thumbRunning = true;
  try {
    while (thumbQueue.length) {
      const id = thumbQueue.shift()!;
      const item = lib().items.find((i) => i.id === id);
      if (!item) {
        lib().setBusy(id, false);
        continue;
      }
      let thumb: string | null = null;
      try {
        const blob = await get<Blob>(blobKey(id), store);
        const format = formatFromName(item.name);
        if (blob instanceof Blob && format) {
          const parsed = await parseCadFile(await blob.arrayBuffer(), format);
          try {
            thumb = renderThumbnail(parsed);
          } finally {
            for (const n of parsed.nodes) for (const m of n.meshes) m.geometry.dispose();
          }
        }
      } catch (e) {
        console.warn(`"${item.name}" için küçük resim üretilemedi:`, e);
      }
      lib().setBusy(id, false);
      // Bu arada silinmiş olabilir
      if (lib().items.some((i) => i.id === id)) {
        commit({ ...current(), items: lib().items.map((i) => (i.id === id ? { ...i, thumb } : i)) });
      }
    }
  } finally {
    thumbRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Öğeler

/** Dosyaları kütüphaneye ekler (desteklenmeyenler atlanır); eklenen sayısını döndürür */
export async function addFilesToLibrary(files: File[], folderId: string | null): Promise<number> {
  await loadLibrary();
  const cad = files.filter((f) => formatFromName(f.name));
  const skipped = files.length - cad.length;
  if (skipped) {
    toast(cad.length ? `${skipped} dosya desteklenmeyen biçimde, atlandı` : 'Kütüphaneye yalnız STEP, IGES, BREP eklenebilir', 'error');
  }
  const added: LibItem[] = [];
  for (const f of cad) {
    const id = uid();
    try {
      await set(blobKey(id), f, store);
    } catch (e) {
      console.error(e);
      toast(`"${f.name}" kütüphaneye kaydedilemedi`, 'error');
      continue;
    }
    added.push({ id, name: f.name, size: f.size, folderId, addedAt: Date.now() });
  }
  if (added.length) {
    void requestPersistentStorage();
    commit({ ...current(), items: [...lib().items, ...added] });
    for (const it of added) queueThumb(it.id);
    toast(added.length === 1 ? `"${added[0].name}" kütüphaneye eklendi` : `${added.length} dosya kütüphaneye eklendi`, 'info');
  }
  return added.length;
}

/** Projedeki bir kaynak dosyayı (blob) kütüphaneye ekler */
export async function addBlobToLibrary(blob: Blob, name: string, folderId: string | null = null): Promise<void> {
  await addFilesToLibrary([new File([blob], name)], folderId);
}

export function renameItem(id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  commit({ ...current(), items: lib().items.map((i) => (i.id === id ? { ...i, name: keepExt(i.name, n) } : i)) });
}

/** Yeni adda uzantı yoksa eskisininkini korur (dosya türü uzantıdan anlaşılıyor) */
function keepExt(oldName: string, newName: string): string {
  if (formatFromName(newName)) return newName;
  const dot = oldName.lastIndexOf('.');
  return dot > 0 ? newName + oldName.slice(dot) : newName;
}

export function moveItems(ids: string[], folderId: string | null) {
  const s = new Set(ids);
  commit({ ...current(), items: lib().items.map((i) => (s.has(i.id) ? { ...i, folderId } : i)) });
}

export async function removeItems(ids: string[]) {
  const s = new Set(ids);
  commit({ ...current(), items: lib().items.filter((i) => !s.has(i.id)) });
  await Promise.all(ids.map((id) => del(blobKey(id), store).catch(() => {})));
}

/** Öğenin dosyasını döndürür (yoksa null) */
export async function getItemFile(id: string): Promise<File | null> {
  const item = lib().items.find((i) => i.id === id);
  if (!item) return null;
  const blob = await get<Blob>(blobKey(id), store);
  return blob instanceof Blob ? new File([blob], item.name) : null;
}

/** Öğeyi montaja ekler (dosyanın kendi koordinatlarında) */
export async function insertLibraryItem(id: string): Promise<void> {
  const file = await getItemFile(id);
  if (!file) {
    toast('Kütüphane dosyası bulunamadı', 'error');
    return;
  }
  await importFiles([file]);
}

// ---------------------------------------------------------------------------
// Klasörler

export function createFolder(name: string, parentId: string | null): string {
  const id = uid();
  const folder: LibFolder = { id, name: name.trim() || 'Yeni klasör', parentId };
  commit({ ...current(), folders: [...lib().folders, folder] });
  return id;
}

export function renameFolder(id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  commit({ ...current(), folders: lib().folders.map((f) => (f.id === id ? { ...f, name: n } : f)) });
}

/** Klasörü taşır; kendi alt klasörüne taşınamaz */
export function moveFolder(id: string, parentId: string | null): boolean {
  if (parentId && folderSubtree(lib().folders, id).has(parentId)) return false;
  commit({ ...current(), folders: lib().folders.map((f) => (f.id === id ? { ...f, parentId } : f)) });
  return true;
}

/** Klasörü alt klasörleri ve içindeki öğelerle siler */
export async function removeFolder(id: string) {
  const sub = folderSubtree(lib().folders, id);
  const gone = lib()
    .items.filter((i) => i.folderId && sub.has(i.folderId))
    .map((i) => i.id);
  const goneSet = new Set(gone);
  commit({ folders: lib().folders.filter((f) => !sub.has(f.id)), items: lib().items.filter((i) => !goneSet.has(i.id)) });
  await Promise.all(gone.map((x) => del(blobKey(x), store).catch(() => {})));
}

// ---------------------------------------------------------------------------
// Taşıma (.zip)

const ZIP_APP = 'step-montaj-library';
const ZIP_VERSION = 1;

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'dosya';
}

export async function exportLibraryZip(): Promise<Blob | null> {
  await loadLibrary();
  const { folders, items } = current();
  if (!items.length && !folders.length) return null;
  const zip = new JSZip();
  zip.file('library.json', JSON.stringify({ app: ZIP_APP, version: ZIP_VERSION, folders, items }, null, 2));
  for (const it of items) {
    const blob = await get<Blob>(blobKey(it.id), store);
    if (blob instanceof Blob) zip.file(`files/${it.id}/${safeName(it.name)}`, blob, { binary: true });
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Kütüphane .zip'ini mevcut kütüphaneye ekler (üzerine yazmaz; yeni id'lerle) */
export async function importLibraryZip(file: Blob): Promise<number> {
  await loadLibrary();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('Zip açılamadı');
  }
  const entry = zip.file('library.json');
  if (!entry) throw new Error('Bu bir kütüphane dosyası değil (library.json yok)');
  const data = JSON.parse(await entry.async('string')) as Partial<LibraryIndex> & { app?: string };
  if (data.app !== ZIP_APP || !isIndex(data)) throw new Error('Bu bir kütüphane dosyası değil');

  const folderMap = new Map<string, string>();
  for (const f of data.folders) folderMap.set(f.id, uid());
  const folders: LibFolder[] = data.folders.map((f) => ({
    id: folderMap.get(f.id)!,
    name: f.name,
    parentId: f.parentId ? (folderMap.get(f.parentId) ?? null) : null,
  }));

  const items: LibItem[] = [];
  for (const it of data.items) {
    const match = zip.file(new RegExp(`^files/${it.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+$`))[0];
    if (!match) continue;
    const id = uid();
    await set(blobKey(id), await match.async('blob'), store);
    items.push({
      id,
      name: it.name,
      size: it.size,
      folderId: it.folderId ? (folderMap.get(it.folderId) ?? null) : null,
      addedAt: it.addedAt ?? Date.now(),
      thumb: typeof it.thumb === 'string' ? it.thumb : undefined,
    });
  }
  commit({ folders: [...lib().folders, ...folders], items: [...lib().items, ...items] });
  for (const it of items) if (it.thumb === undefined) queueThumb(it.id);
  return items.length;
}

/** Zip bir kütüphane paketi mi (yoksa proje .zip'i) */
export async function isLibraryZip(file: Blob): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(file);
    return !!zip.file('library.json');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Depolama alanı

export interface StorageInfo {
  /** Bu sitenin kullandığı (proje + kütüphane), bayt */
  usage: number;
  /** Tarayıcının bu siteye ayırdığı üst sınır, bayt */
  quota: number;
  /** Kalıcı depolama verildi mi (disk dolarken tarayıcı kendiliğinden silmez) */
  persisted: boolean;
}

export async function storageInfo(): Promise<StorageInfo | null> {
  const sm = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!sm?.estimate) return null;
  try {
    const e = await sm.estimate();
    const persisted = sm.persisted ? await sm.persisted() : false;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
  } catch {
    return null;
  }
}

/**
 * Tarayıcıdan kalıcı depolama ister: verilmezse disk dolduğunda tarayıcı site verisini (kütüphane dahil)
 * kendiliğinden silebilir. Chrome / Edge çoğu zaman sessizce verir, Firefox izin sorar.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const sm = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!sm?.persist) return false;
  try {
    return (await sm.persisted?.()) || (await sm.persist());
  } catch {
    return false;
  }
}
