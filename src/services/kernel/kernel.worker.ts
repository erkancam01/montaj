// Çekirdek Web Worker'ı: OpenCascade (replicad) yükler, gövde üretir, STEP yazar.
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import { exportAssembly } from '@/services/kernel/exportStep';
import { buildBodyMesh, meshTransferables } from '@/services/kernel/mesh';
import type { KernelRequest, KernelResponse } from '@/services/kernel/protocol';

interface WorkerScope {
  postMessage(msg: KernelResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<KernelRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let ready: Promise<void> | null = null;

/** OpenCascade'i bir kez yükler (başarısızsa sonraki istekte yeniden dener) */
function init(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        const oc = await opencascade({ locateFile: () => wasmUrl });
        setOC(oc);
      } catch (e) {
        ready = null;
        const m = e instanceof Error ? e.message : String(e);
        throw new Error(`Geometri çekirdeği yüklenemedi: ${m}`);
      }
    })();
  }
  return ready;
}

const isFatal = (e: unknown) =>
  (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) ||
  (e instanceof Error && /abort|out of memory|memory access out of bounds/i.test(e.message));

function message(e: unknown): string {
  if (typeof e === 'number') return 'Geometri çekirdeği hatası';
  const m = e instanceof Error ? e.message : String(e);
  return m || 'Bilinmeyen çekirdek hatası';
}

// İstekler sırayla işlenir (OCC tek iş parçacıklı; export içindeki await araya girmesin)
let chain: Promise<void> = Promise.resolve();

ctx.onmessage = (ev) => {
  const req = ev.data;
  chain = chain.then(() => handle(req));
};

async function handle(req: KernelRequest) {
  try {
    await init();
    if (req.type === 'init') {
      ctx.postMessage({ id: req.id, ok: true, result: null });
    } else if (req.type === 'build') {
      const result = buildBodyMesh(req.body);
      ctx.postMessage({ id: req.id, ok: true, result }, meshTransferables(result));
    } else if (req.type === 'export') {
      const result = await exportAssembly(req.items, req.blobs);
      ctx.postMessage({ id: req.id, ok: true, result });
    }
  } catch (e) {
    const fatal = isFatal(e);
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: fatal ? `Geometri çekirdeği çöktü: ${message(e)}` : message(e),
      fatal,
    });
  }
}
