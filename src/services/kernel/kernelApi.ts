// Çekirdek istemcisi: geometri işleri (replicad/OpenCascade) bir Web Worker'da çalışır.
// Worker tembel kurulur; çökerse bekleyen istekler reddedilir ve sonraki istekte yeniden kurulur.
import type { Body, EdgeSig, Transform } from '@/core/types';
import type { KernelRequest, KernelResponse, KernelResult } from '@/services/kernel/protocol';

/** Gövdenin tessellation'ı (gövde-yerel, mm). Yapı ParsedMesh ile uyumlu. */
export interface BodyMesh {
  position: Float32Array;
  normal: Float32Array;
  index: Uint32Array;
  /** B-rep yüz başına üçgen aralığı (first..last dahil) */
  faces: { first: number; last: number }[];
  /** B-rep kenarları: LineSegments köşeleri, kenar başına parça aralığı ve imza */
  edges: { position: Float32Array; ranges: { first: number; last: number }[]; sigs: EdgeSig[] };
}

export interface BodyBuildResult {
  /**
   * Ayrı katılar (oluşma sırasıyla). İlk katı gövdenin asıl parçasıdır; diğerleri montajda ayrı parça olur.
   * Katı yoksa (yalnız sketch'ler) boş.
   */
  solids: { key: string; mesh: BodyMesh }[];
  /** featureId → hata (Türkçe). Hatalı özellik atlanır, sonrakiler denenir. */
  featureErrors: Record<string, string>;
}

// ---------------------------------------------------------------- worker bağlantısı

type Pending = { resolve: (r: KernelResult) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(message: string) {
  const list = [...pending.values()];
  pending.clear();
  for (const p of list) p.reject(new Error(message));
  // Gövde kuyrukları da boşalır (çalışan istekleri reddedildi)
  for (const [id, q] of bodyQueue) {
    bodyQueue.delete(id);
    for (const w of q.waiting) w.reject(new Error(message));
  }
}

function resetWorker(message: string) {
  const w = worker;
  worker = null;
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.terminate();
  }
  failAll(message);
}

function getWorker(): Worker {
  if (worker) return worker;
  let w: Worker;
  try {
    w = new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    throw new Error(`Geometri çekirdeği başlatılamadı: ${e instanceof Error ? e.message : String(e)}`);
  }
  w.onmessage = (ev: MessageEvent<KernelResponse>) => {
    const res = ev.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else {
      p.reject(new Error(res.error));
      if (res.fatal) resetWorker(res.error);
    }
  };
  w.onerror = (ev) => {
    ev.preventDefault?.();
    resetWorker(`Geometri çekirdeği çöktü${ev.message ? `: ${ev.message}` : ''}`);
  };
  w.onmessageerror = () => resetWorker('Geometri çekirdeği mesajı okunamadı');
  worker = w;
  return w;
}

type ReqBody<T> = T extends unknown ? Omit<T, 'id'> : never;

function call(req: ReqBody<KernelRequest>): Promise<KernelResult> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ ...req, id } as KernelRequest);
    } catch (e) {
      pending.delete(id);
      reject(new Error(`Çekirdeğe veri gönderilemedi: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

// ---------------------------------------------------------------- gövde üretimi

/**
 * Gövde başına en fazla bir çalışan + bir bekleyen istek. Çalışan varken gelen yeni istek bekleyenin
 * yerine geçer; bekleyen (eski) çağıranlar da en yeni sonucu alır. Böylece hızlı düzenlemelerde kuyruk şişmez.
 */
interface BodyQueue {
  running: boolean;
  next: Body | null;
  waiting: { resolve: (r: BodyBuildResult) => void; reject: (e: Error) => void }[];
}
const bodyQueue = new Map<string, BodyQueue>();

function runBody(id: string) {
  const q = bodyQueue.get(id);
  if (!q || q.running || !q.next) return;
  const body = q.next;
  const waiting = q.waiting;
  q.next = null;
  q.waiting = [];
  q.running = true;
  call({ type: 'build', body }).then(
    (r) => {
      for (const w of waiting) w.resolve(r as BodyBuildResult);
    },
    (e: Error) => {
      for (const w of waiting) w.reject(e);
    },
  ).finally(() => {
    const cur = bodyQueue.get(id);
    if (cur !== q) return;
    q.running = false;
    if (q.next) runBody(id);
    else bodyQueue.delete(id);
  });
}

/** Gövdeyi özellik geçmişinden yeniden üretir. Bastırılmış (suppressed) özellikler atlanır. */
export async function buildBody(body: Body): Promise<BodyBuildResult> {
  return new Promise<BodyBuildResult>((resolve, reject) => {
    let q = bodyQueue.get(body.id);
    if (!q) {
      q = { running: false, next: null, waiting: [] };
      bodyQueue.set(body.id, q);
    }
    q.next = body;
    q.waiting.push({ resolve, reject });
    runBody(body.id);
  });
}

let warm: Promise<unknown> | null = null;

/** Çekirdeği arka planda önceden yükler (modelleme moduna girince çağrılır) */
export function warmupKernel(): void {
  if (warm && worker) return;
  warm = call({ type: 'init' }).catch(() => {
    warm = null;
  });
}

// ---------------------------------------------------------------- STEP

/** STEP'e yazılacak montaj öğesi */
export type ExportItem =
  | {
      kind: 'body';
      name: string;
      /** sRGB #rrggbb ya da null */
      color: string | null;
      body: Body;
      /** Gövdenin kaçıncı katısı (Part.nodeKey) */
      solid: number;
      /** gövde-yerel → dünya */
      world: Transform;
    }
  | {
      kind: 'import';
      name: string;
      color: string | null;
      fileId: string;
      fileName: string;
      /**
       * Parçanın kaynak dosyadaki kimliği: occt-import-js düğümünün dosya koordinatındaki
       * bounding box merkezi ve boyutu. Çekirdek, STEP'i B-rep olarak okuyup bu kutuya uyan katıyı bulur.
       */
      nodeCenter: [number, number, number];
      nodeSize: [number, number, number];
      /** dosya koordinatı → dünya ( = partWorld ∘ öteleme(-nodeCenter) ) */
      world: Transform;
    };

/**
 * Montajı tek bir STEP dosyası olarak dışa aktarır (mm).
 * blobs: fileId → orijinal STEP dosyası (import öğeleri için).
 * Eşleşmeyen import parçaları atlanır; uyarılar döner.
 */
export async function exportAssemblySTEP(
  items: ExportItem[],
  blobs: Record<string, Blob>,
): Promise<{ blob: Blob; warnings: string[] }> {
  // Yalnız kullanılan dosyaları gönder
  const used: Record<string, Blob> = {};
  for (const it of items) if (it.kind === 'import' && blobs[it.fileId]) used[it.fileId] = blobs[it.fileId];
  const r = (await call({ type: 'export', items, blobs: used })) as { blob: Blob; warnings: string[] };
  return { blob: r.blob, warnings: r.warnings };
}
