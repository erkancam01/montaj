// Gövde uzlaştırıcısı: belgedeki gövdelerin (ve açık özellik taslağının) geometrisini çekirdekte
// yeniden üretir, geometryCache'e yazar, dosya durumunu günceller ve mate yüzey referanslarını
// yeni geometriye yeniden eşler. App açılışında startBodyManager() bir kez çağrılır.
import { BufferAttribute, BufferGeometry } from 'three';
import { buildBody, type BodyMesh } from '../kernel/kernelApi';
import { getFaceGeom } from '../lib/faceGeometry';
import { geometryCache, type ParsedFile, type ParsedMesh } from '../lib/geometryCache';
import { afterRender } from '../lib/viewerApi';
import { useAssembly } from '../store/useAssembly';
import type { Body, Doc, FaceGeom, FaceRef, Feature, Mate, Part, Vec3 } from '../types';
import { bodyFileId, isBodyFileId, bodyIdOfFile } from '../types';

const st = () => useAssembly.getState();

interface Built {
  key: string;
  /** Son üretimde kullanılan mesh (önbellek kontrolü için) */
  file: ParsedFile;
}

const built = new Map<string, Built>();
const inflight = new Map<string, { key: string; seq: number }>();
let seq = 0;
let started = false;

/** Gövdenin etkin özellik listesi: açık özellik taslağı varsa uygulanmış hâli (önizleme) */
function effectiveFeatures(body: Body): Feature[] {
  const fs = st().modeling.feature;
  if (!fs || fs.bodyId !== body.id) return body.features;
  const d = fs.draft;
  return fs.isNew ? [...body.features, d] : body.features.map((f) => (f.id === d.id ? d : f));
}

function toParsed(body: Body, mesh: BodyMesh | null): ParsedFile {
  const meshes: ParsedMesh[] = [];
  let size: Vec3 = [0, 0, 0];
  if (mesh && mesh.index.length) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(mesh.position, 3));
    if (mesh.normal.length === mesh.position.length) g.setAttribute('normal', new BufferAttribute(mesh.normal, 3));
    g.setIndex(new BufferAttribute(mesh.index, 1));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const bb = g.boundingBox!;
    size = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    meshes.push({
      geometry: g,
      color: null,
      hasVertexColors: false,
      faces: mesh.faces.length ? mesh.faces : [{ first: 0, last: mesh.index.length / 3 - 1 }],
      brepEdges: mesh.edges,
    });
  }
  return {
    nodes: [{ key: 0, name: body.name, path: [], center: [0, 0, 0], size, meshes }],
    center: [0, 0, 0],
    size,
  };
}

function disposeFile(f: ParsedFile | undefined) {
  if (!f) return;
  for (const n of f.nodes) for (const m of n.meshes) {
    m.geometry.dispose();
    m.edges?.dispose();
  }
}

// ---------------------------------------------------------------- Yüz referansı yeniden eşleme

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** sig'e en uygun yüzü bulur (aynı tür; düzlemde aynı yön ve düzlem, silindirde aynı eksen/yarıçap) */
export function matchFace(part: Pick<Part, 'fileId' | 'nodeKey'>, sig: FaceGeom): { meshIndex: number; faceIndex: number } | null {
  const node = geometryCache.get(part.fileId)?.nodes[part.nodeKey];
  if (!node || sig.kind === 'other') return null;
  let best = null as { meshIndex: number; faceIndex: number; score: number } | null;
  node.meshes.forEach((m, mi) => {
    for (let fi = 0; fi < m.faces.length; fi++) {
      const g = getFaceGeom(part, mi, fi);
      if (!g || g.kind !== sig.kind) continue;
      let score: number;
      if (g.kind === 'plane' && sig.kind === 'plane') {
        if (dot(g.normal, sig.normal) < 0.9999) continue;
        const off = Math.abs(dot(sub(g.point, sig.point), sig.normal));
        if (off > 0.05) continue;
        score = off * 100 + len(sub(g.point, sig.point));
      } else if (g.kind === 'cylinder' && sig.kind === 'cylinder') {
        if (Math.abs(Math.abs(dot(g.axis, sig.axis)) - 1) > 1e-4 || Math.abs(g.radius - sig.radius) > 0.01) continue;
        const v = sub(g.point, sig.point);
        const along = dot(v, sig.axis);
        const perp = len([v[0] - along * sig.axis[0], v[1] - along * sig.axis[1], v[2] - along * sig.axis[2]]);
        if (perp > 0.05) continue;
        score = perp * 100 + Math.abs(along);
      } else continue;
      if (!best || score < best.score) best = { meshIndex: mi, faceIndex: fi, score };
    }
  });
  return best ? { meshIndex: best.meshIndex, faceIndex: best.faceIndex } : null;
}

/** Gövde parçalarına ait mate referanslarını imzalarına göre günceller (geçmişe yazmadan) */
function remapMates(bodyId: string) {
  const s = st();
  const fid = bodyFileId(bodyId);
  const partOf = new Map(s.doc.parts.filter((p) => p.fileId === fid).map((p) => [p.id, p]));
  if (!partOf.size || !s.doc.mates.length) return;
  let changed = false;
  const fix = (ref: FaceRef): FaceRef => {
    const part = partOf.get(ref.partId);
    if (!part || !ref.sig) return ref;
    const m = matchFace(part, ref.sig);
    if (!m || (m.meshIndex === ref.meshIndex && m.faceIndex === ref.faceIndex)) return ref;
    changed = true;
    return { ...ref, ...m };
  };
  const mates: Mate[] = s.doc.mates.map((m) => {
    const a = fix(m.a);
    const b = fix(m.b);
    return a === m.a && b === m.b ? m : { ...m, a, b };
  });
  if (!changed) return;
  // Yüz indeksi önbelleğidir; gerçek referans imzadır. Geçmişe yazmadan güncellenir ve yeniden çözülür.
  const doc: Doc = { ...s.doc, mates };
  s.replaceDocKeepHistory(doc);
}

// ---------------------------------------------------------------- Uzlaştırma

function schedule(body: Body) {
  const features = effectiveFeatures(body);
  const key = JSON.stringify({ n: body.name, features });
  const fid = bodyFileId(body.id);
  const have = built.get(body.id);
  const cached = geometryCache.get(fid);
  if (have && have.key === key && cached === have.file) return;
  const run = inflight.get(body.id);
  if (run && run.key === key) return;
  const my = ++seq;
  inflight.set(body.id, { key, seq: my });
  const s = st();
  if (!cached) s.setFileStatus(fid, { status: 'loading' });
  s.setBuildStatus(body.id, { state: 'building', featureErrors: s.modeling.build[body.id]?.featureErrors ?? {} });
  buildBody({ ...body, features })
    .then((res) => {
      if (inflight.get(body.id)?.seq !== my) return; // daha yeni istek var
      inflight.delete(body.id);
      if (!st().doc.bodies.some((b) => b.id === body.id)) return;
      const file = toParsed(body, res.mesh);
      const old = geometryCache.get(fid);
      geometryCache.set(fid, file);
      built.set(body.id, { key, file });
      const errs = res.featureErrors;
      const nErr = Object.keys(errs).length;
      st().setBuildStatus(body.id, {
        state: nErr ? 'error' : 'ok',
        featureErrors: errs,
        message: nErr ? `${nErr} özellik üretilemedi` : undefined,
      });
      // Yeni geometri nesnesi → PartNode yeniden render (fileStatus nesnesi değişir)
      st().setFileStatus(fid, { status: 'ready' });
      remapMates(body.id);
      if (old && old !== file) afterRender(() => disposeFile(old));
    })
    .catch((e: unknown) => {
      if (inflight.get(body.id)?.seq !== my) return;
      inflight.delete(body.id);
      const message = e instanceof Error ? e.message : String(e);
      st().setBuildStatus(body.id, { state: 'error', featureErrors: {}, message: `Çekirdek hatası: ${message}` });
      if (!geometryCache.get(fid)) {
        geometryCache.set(fid, toParsed(body, null));
        st().setFileStatus(fid, { status: 'ready' });
      }
    });
}

function reconcile() {
  const s = st();
  for (const b of s.doc.bodies) schedule(b);
  // Silinen gövdelerin önbelleğini bırak
  for (const id of [...built.keys()]) {
    if (!s.doc.bodies.some((b) => b.id === id)) {
      built.delete(id);
      inflight.delete(id);
      const fid = bodyFileId(id);
      const f = geometryCache.get(fid);
      if (f) {
        geometryCache.delete(fid);
        afterRender(() => disposeFile(f));
      }
    }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
function reconcileSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    reconcile();
  }, 60);
}

/** Uygulama açılışında bir kez çağrılır */
export function startBodyManager() {
  if (started) return;
  started = true;
  useAssembly.subscribe((s, prev) => {
    if (
      s.doc.bodies !== prev.doc.bodies ||
      s.modeling.feature !== prev.modeling.feature ||
      // replaceDoc (proje yükleme) dosya durumlarını sıfırlar
      s.fileStatus !== prev.fileStatus
    ) {
      reconcileSoon();
    }
  });
  reconcile();
}

/** Parça bir gövdeye aitse yüz referansına imza ekler (mate kurarken) */
export function withFaceSig(ref: FaceRef): FaceRef {
  const part = st().doc.parts.find((p) => p.id === ref.partId);
  if (!part || !isBodyFileId(part.fileId)) return ref;
  const g = getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  return g && g.kind !== 'other' ? { ...ref, sig: g } : ref;
}

export { bodyIdOfFile };
