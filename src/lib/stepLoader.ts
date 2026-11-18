// CAD dosyalarını Web Worker'da (occt-import-js) ayrıştırır ve ParsedFile'a çevirir.
import { Box3, BufferAttribute, BufferGeometry, Color, SRGBColorSpace, Vector3 } from 'three';
import type { CadFormat, Vec3 } from '../types';
import type { ParsedFile, ParsedMesh, ParsedNode } from './geometryCache';

type RGB = [number, number, number];

interface WorkerFace {
  first: number;
  last: number;
  color: RGB | null;
}

interface WorkerMesh {
  name: string;
  color: RGB | null;
  brep_faces: WorkerFace[];
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array | null;
}

interface WorkerNode {
  name?: string;
  meshes?: number[];
  children?: WorkerNode[];
}

interface WorkerResult {
  root: WorkerNode;
  meshes: WorkerMesh[];
}

type WorkerReply = { id: number; ok: true; result: WorkerResult } | { id: number; ok: false; error: string };

interface Pending {
  resolve(r: WorkerResult): void;
  reject(e: Error): void;
}

const DEFAULT_COLOR: RGB = [0.7, 0.72, 0.75];

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function rejectAll(w: Worker, message: string) {
  if (worker === w) worker = null;
  w.terminate();
  const list = [...pending.values()];
  pending.clear();
  for (const p of list) p.reject(new Error(message));
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(`${import.meta.env.BASE_URL}step-worker.js`);
  w.onmessage = (ev: MessageEvent<WorkerReply>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      // wasm abort vb. sonrası modül bozuk kalabilir: worker'ı yenile.
      // Bekleyen başka istek varsa onlar da bu worker'la birlikte gider.
      if (worker === w) worker = null;
      w.terminate();
      p.reject(new Error(`Dosya ayrıştırılamadı: ${msg.error}`));
      const rest = [...pending.values()];
      pending.clear();
      for (const r of rest) r.reject(new Error('Ayrıştırıcı yeniden başlatıldı, dosya işlenemedi.'));
    }
  };
  w.onerror = (ev: ErrorEvent) => {
    ev.preventDefault();
    rejectAll(w, `Ayrıştırıcı çalıştırılamadı${ev.message ? `: ${ev.message}` : '.'}`);
  };
  w.onmessageerror = () => rejectAll(w, 'Ayrıştırıcıdan gelen veri okunamadı.');
  worker = w;
  return w;
}

function runWorker(buffer: ArrayBuffer, format: CadFormat): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      // Arabellek worker'a aktarılır (kopyalanmaz); çağrıdan sonra çağıranda boşalır.
      getWorker().postMessage({ id, format, buffer }, [buffer]);
    } catch (e) {
      pending.delete(id);
      reject(new Error(`Ayrıştırıcı başlatılamadı: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

function srgbToLinear(c: RGB, out: Color): Color {
  return out.setRGB(c[0], c[1], c[2], SRGBColorSpace);
}

function buildGeometry(m: WorkerMesh): { geometry: BufferGeometry; hasVertexColors: boolean } {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(m.position, 3));
  if (m.index && m.index.length) geometry.setIndex(new BufferAttribute(m.index, 1));
  if (m.normal && m.normal.length === m.position.length) {
    geometry.setAttribute('normal', new BufferAttribute(m.normal, 3));
  } else {
    geometry.computeVertexNormals();
  }

  let hasVertexColors = false;
  const index = m.index;
  if (index && m.brep_faces.some((f) => f.color)) {
    const vertexCount = m.position.length / 3;
    const colors = new Float32Array(vertexCount * 3);
    const tmp = new Color();
    srgbToLinear(m.color ?? DEFAULT_COLOR, tmp);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    for (const f of m.brep_faces) {
      if (!f.color) continue;
      srgbToLinear(f.color, tmp);
      const end = Math.min(f.last, index.length / 3 - 1);
      for (let t = Math.max(0, f.first); t <= end; t++) {
        for (let k = 0; k < 3; k++) {
          const v = index[t * 3 + k];
          colors[v * 3] = tmp.r;
          colors[v * 3 + 1] = tmp.g;
          colors[v * 3 + 2] = tmp.b;
        }
      }
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    hasVertexColors = true;
  }
  return { geometry, hasVertexColors };
}

const toVec3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];

function convert(res: WorkerResult): ParsedFile {
  const meshes = res.meshes ?? [];
  const built: ({ geometry: BufferGeometry; hasVertexColors: boolean } | null)[] = meshes.map(() => null);
  const used = new Set<number>();
  const nodes: ParsedNode[] = [];
  const fileBox = new Box3();
  let unnamed = 0;

  const visit = (node: WorkerNode, path: string[]) => {
    const meshIdx = (node.meshes ?? []).filter((i) => i >= 0 && i < meshes.length && meshes[i].position.length >= 9);
    const nm = node.name?.trim();
    // occt-import-js alt montajın yaprak mesh'lerini (cıvata, somun…) montaj düğümüne koyar.
    // Her mesh ayrı taşınabilsin diye her mesh ayrı bir parça (ParsedNode) olur.
    const multi = meshIdx.length > 1;
    meshIdx.forEach((i, k) => {
      let g = built[i];
      if (!g) g = built[i] = buildGeometry(meshes[i]);
      const geometry = used.has(i) ? g.geometry.clone() : g.geometry;
      used.add(i);
      const triCount = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
      const faces = (meshes[i].brep_faces ?? [])
        .map((f) => ({ first: Math.max(0, f.first), last: Math.min(f.last, triCount - 1) }))
        .filter((f) => f.last >= f.first);
      const part: ParsedMesh = {
        geometry,
        color: meshes[i].color ?? null,
        hasVertexColors: g.hasVertexColors,
        // Yüz bilgisi yoksa tüm mesh tek yüz sayılır
        faces: faces.length ? faces : [{ first: 0, last: triCount - 1 }],
      };
      geometry.computeBoundingBox();
      const box = geometry.boundingBox ? geometry.boundingBox.clone() : new Box3();
      const center = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());
      geometry.translate(-center.x, -center.y, -center.z);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      fileBox.union(box);
      const meshName = meshes[i].name?.trim();
      const name = multi
        ? meshName || `${nm || 'Parça'} ${k + 1}`
        : nm || meshName || `Parça ${++unnamed}`;
      const partPath = multi && nm ? [...path, nm] : [...path];
      nodes.push({ key: nodes.length, name, path: partPath, center: toVec3(center), size: toVec3(size), meshes: [part] });
    });
    const childPath = nm ? [...path, nm] : path;
    for (const c of node.children ?? []) visit(c, childPath);
  };

  if (res.root) visit(res.root, []);
  if (!nodes.length) throw new Error('Dosyada geometri bulunamadı.');

  return {
    nodes,
    center: toVec3(fileBox.getCenter(new Vector3())),
    size: toVec3(fileBox.getSize(new Vector3())),
  };
}

/**
 * CAD dosyasını ayrıştırır. Geometriler parça merkezine ötelenmiş olarak döner.
 * Not: buffer worker'a aktarılır (transfer); çağrıdan sonra kullanılamaz.
 */
export async function parseCadFile(buffer: ArrayBuffer, format: CadFormat): Promise<ParsedFile> {
  const res = await runWorker(buffer, format);
  return convert(res);
}
