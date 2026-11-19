// Oturum yönetimi: içe aktarma, açılışta geri yükleme, otomatik kayıt, proje paketi.
import type { Doc } from '@/core/types';
import { addImported, buildInstance } from '@/state/assemblyActions';
import { emptyDoc, useAssembly } from '@/state/useAssembly';
import { formatFromName, isProjectZip } from '@/services/io/formats';
import { geometryCache, type ParsedFile } from '@/core/geometry/geometryCache';
import { uid } from '@/core/math/math';
import {
  buildProjectZip,
  clearAll,
  deleteBlob,
  loadBlob,
  loadDoc,
  pruneBlobs,
  readProjectZip,
  saveBlob,
  saveDoc,
} from '@/services/io/persistence';
import { parseCadFile } from '@/services/io/stepLoader';
import { afterRender, viewerApi } from '@/services/viewerApi';

const st = () => useAssembly.getState();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fitAll = () => afterRender(() => viewerApi.fit('all'));

/** Yükleme nesli: her yeni belge yüklemesi öncekini geçersiz kılar */
let generation = 0;
/** İçe aktarılmakta olan (henüz belgeye eklenmemiş) dosya id'leri; pruneBlobs bunları silmesin */
const inflight = new Set<string>();

let restorePromise: Promise<void> | null = null;
/** Kayıtlı belge store'a yerleşince çözülür (içe aktarma bunu bekler, yoksa geri yükleme onu ezer) */
let restoreApplied: Promise<void> | null = null;
let autosaveStarted = false;

function disposeParsed(files: ParsedFile[]) {
  for (const f of files) {
    for (const n of f.nodes) {
      for (const m of n.meshes) {
        m.geometry.dispose();
        m.edges?.dispose();
      }
    }
  }
}

/**
 * Belgeyi store'a yerleştirir (senkron) ve dosyalarını sırayla ayrıştıran promise'i döndürür.
 */
function applyDoc(input: Doc): Promise<void> {
  const gen = ++generation;
  const used = new Set(input.instances.map((i) => i.fileId));
  const doc: Doc = { ...input, files: input.files.filter((f) => used.has(f.id)) };

  const old = st()
    .doc.files.map((f) => geometryCache.get(f.id))
    .filter((p): p is ParsedFile => !!p);
  geometryCache.clear();
  st().replaceDoc(doc);
  for (const f of doc.files) st().setFileStatus(f.id, { status: 'loading' });
  // Eski geometriler sahneden kalktıktan sonra GPU belleğini bırak
  if (old.length) afterRender(() => disposeParsed(old));

  const keep = new Set([...doc.files.map((f) => f.id), ...inflight]);

  return (async () => {
    try {
      await pruneBlobs(keep);
    } catch (e) {
      console.error('Kullanılmayan dosyalar silinemedi:', e);
    }
    let firstReady = true;
    for (const f of doc.files) {
      if (gen !== generation) return;
      try {
        const blob = await loadBlob(f.id);
        if (gen !== generation) return;
        if (!blob) throw new Error('Kaynak dosya bulunamadı');
        const format = formatFromName(f.name);
        if (!format) throw new Error('Desteklenmeyen dosya türü');
        const parsed = await parseCadFile(await blob.arrayBuffer(), format);
        if (gen !== generation) {
          disposeParsed([parsed]);
          return;
        }
        geometryCache.set(f.id, parsed);
        st().setFileStatus(f.id, { status: 'ready' });
        if (firstReady) {
          firstReady = false;
          fitAll();
        }
      } catch (e) {
        if (gen !== generation) return;
        console.error(`"${f.name}" yüklenemedi:`, e);
        st().setFileStatus(f.id, { status: 'error', error: errText(e) });
      }
    }
    if (gen === generation && doc.files.length) fitAll();
  })();
}

function startAutosave() {
  if (autosaveStarted) return;
  autosaveStarted = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    saveDoc(st().doc).catch((e) => {
      if (!warned) {
        warned = true;
        console.error('Proje otomatik kaydedilemedi:', e);
      }
    });
  };

  useAssembly.subscribe((s, prev) => {
    if (s.doc === prev.doc) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 400);
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (timer) flush();
    });
  }
}

async function doRestore(): Promise<void> {
  let markApplied!: () => void;
  restoreApplied = new Promise<void>((r) => (markApplied = r));
  try {
    const doc = await loadDoc();
    if (doc) {
      const parsing = applyDoc(doc);
      markApplied();
      startAutosave();
      await parsing;
    }
  } catch (e) {
    console.error('Kayıtlı proje geri yüklenemedi:', e);
  } finally {
    markApplied();
    startAutosave();
  }
}

async function importProjectZip(file: File) {
  const { doc, blobs } = await readProjectZip(file);
  await clearAll();
  for (const [id, blob] of blobs) await saveBlob(id, blob);
  const parsing = applyDoc(doc);
  try {
    await saveDoc(st().doc);
  } catch (e) {
    console.error('Proje kaydedilemedi:', e);
  }
  await parsing;
}

/** CAD (.step/.stp/.iges/.igs/.brep/.brp) ve proje (.zip) dosyalarını içe aktarır */
export async function importFiles(files: File[]): Promise<void> {
  if (restoreApplied) await restoreApplied;

  const zips = files.filter((f) => isProjectZip(f.name));
  const cad: { file: File; format: NonNullable<ReturnType<typeof formatFromName>>; jobId: string }[] = [];
  for (const file of files) {
    if (isProjectZip(file.name)) continue;
    const format = formatFromName(file.name);
    if (!format) {
      st().showToast(`Desteklenmeyen dosya türü: ${file.name}`, 'error');
      continue;
    }
    cad.push({ file, format, jobId: uid() });
  }

  if (zips.length) {
    if (zips.length > 1) st().showToast(`Yalnızca bir proje açılabilir, "${zips[0].name}" açılıyor.`, 'info');
    try {
      await importProjectZip(zips[0]);
    } catch (e) {
      console.error('Proje açılamadı:', e);
      st().showToast(errText(e), 'error');
    }
  }

  if (!cad.length) return;
  for (const c of cad) st().addJob({ id: c.jobId, name: c.file.name, status: 'loading' });

  let added = 0;
  let saveWarned = false;
  for (const { file, format, jobId } of cad) {
    const fileId = uid();
    inflight.add(fileId);
    try {
      try {
        await saveBlob(fileId, file);
      } catch (e) {
        console.error('Dosya tarayıcıya kaydedilemedi:', e);
        if (!saveWarned) {
          saveWarned = true;
          st().showToast('Dosya tarayıcıya kaydedilemedi; sayfa yenilenince kaybolacak.', 'error');
        }
      }
      const parsed = await parseCadFile(await file.arrayBuffer(), format);
      geometryCache.set(fileId, parsed);
      st().setFileStatus(fileId, { status: 'ready' });
      const built = buildInstance(fileId, file.name);
      if (!built) throw new Error('Dosya sahneye eklenemedi.');
      addImported({ id: fileId, name: file.name, size: file.size }, built.instance, built.parts);
      st().removeJob(jobId);
      added++;
    } catch (e) {
      console.error(`"${file.name}" içe aktarılamadı:`, e);
      const parsed = geometryCache.get(fileId);
      if (parsed) disposeParsed([parsed]);
      geometryCache.delete(fileId);
      st().updateJob(jobId, { status: 'error', error: errText(e) });
      deleteBlob(fileId).catch(() => {});
    } finally {
      inflight.delete(fileId);
    }
  }
  if (added) fitAll();
}

/** Açılışta IndexedDB'deki projeyi yükler, otomatik kaydı başlatır. Birden çok çağrıya dayanıklı. */
export async function restoreSession(): Promise<void> {
  if (!restorePromise) restorePromise = doRestore();
  return restorePromise;
}

/** Projeyi temizler (onay arayüzde sorulur) */
export async function newProject(): Promise<void> {
  try {
    await clearAll();
  } catch (e) {
    console.error('Kayıtlı veriler temizlenemedi:', e);
  }
  await loadProjectDoc(emptyDoc());
}

/** Proje paketini (.zip: project.json + kaynak dosyalar) üretir */
export async function exportProjectZip(): Promise<Blob> {
  return buildProjectZip(st().doc);
}

/** Bir belgeyi yükler ve dosyalarını ayrıştırır */
export async function loadProjectDoc(doc: Doc): Promise<void> {
  await applyDoc(doc);
}
