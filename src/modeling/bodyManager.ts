// Gövde uzlaştırıcısı: belgedeki gövdelerin (ve açık özellik taslağının) geometrisini çekirdekte
// yeniden üretir, geometryCache'e yazar, dosya durumunu günceller ve mate yüzey referanslarını
// yeni geometriye yeniden eşler. App açılışında startBodyManager() bir kez çağrılır.
import { BufferAttribute, BufferGeometry } from 'three';
import { buildBody, type BodyMesh } from '../kernel/kernelApi';
import { geometryCache, type ParsedFile, type ParsedMesh } from '../lib/geometryCache';
import { afterRender } from '../lib/viewerApi';
import { useAssembly } from '../store/useAssembly';
import type { Body, Doc, FaceRef, Feature, Mate, Vec3 } from '../types';
import { bodyFileId, isBodyFileId, bodyIdOfFile } from '../types';
import { applyFaceMatch, faceArea, faceRefSig, matchFace, matchFaceRef } from './faceMatch';
import { computeAndCacheOrigins, dropOrigins } from './faceOrigin';
import { resolveBody, sourcesKey } from './externalRefs';
import { liveSourcesOf } from './refLocks';
import { initSketchSolver, isSketchSolverReady } from '../sketch/solver';
import { gizmoBusy } from '../components/viewport/sceneRefs';

export { faceArea, matchFace };

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

/**
 * Gövde parçalarına ait mate referanslarını yeniden eşler (geçmişe yazmadan): önce yüz kökeni (özellik +
 * sketch eğrisi), sonra imza (sig + alan).
 */
function remapMates(bodyId: string) {
  const s = st();
  const fid = bodyFileId(bodyId);
  const partOf = new Map(s.doc.parts.filter((p) => p.fileId === fid).map((p) => [p.id, p]));
  if (!partOf.size || !s.doc.mates.length) return;
  let changed = false;
  const fix = (ref: FaceRef): FaceRef => {
    const part = partOf.get(ref.partId);
    if (!part || (!ref.sig && !ref.origin)) return ref;
    const m = matchFaceRef(part, ref);
    if (!m) return ref;
    // İmza da güncellenir: sonraki parametrik değişiklik yeni konumdan izlenir
    const next = applyFaceMatch(ref, m);
    if (next !== ref) changed = true;
    return next;
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
      // Yüz kökenleri (topolojik adlar): mate/projeksiyon yeniden eşlemesinden önce
      computeAndCacheOrigins(fid, features, errs);
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

// ---------------------------------------------------------------- Canlı dış referanslar

/** Son çözülen kaynak anahtarı (gövde id → anahtar + özellik dizisi) */
const resolved = new Map<string, { key: string; features: Feature[] }>();

/**
 * Canlı referanslı gövdelerin sketch'lerini kaynakların güncel konum/geometrisiyle yeniler.
 * Değişiklik varsa belgeye geçmişe yazmadan uygulanır ve true döner (abonelik yeniden uzlaştırır).
 */
function resolveLiveRefs(): boolean {
  const s = st();
  const doc = s.doc;
  if (!doc.bodies.some((b) => liveSourcesOf(doc, b).length)) return false;
  // Sürükleme sürerken bekle: bırakınca yeniden denenir
  if (gizmoBusy()) {
    setTimeout(reconcileSoon, 250);
    return false;
  }
  // Kullanıcı geometrisi referanslarla birlikte gelsin diye sketch çözücüsü gerekir
  if (!isSketchSolverReady()) {
    initSketchSolver().then(reconcileSoon, (e: unknown) => console.error('Sketch çözücü yüklenemedi', e));
    return false;
  }
  let changed = false;
  const bodies = doc.bodies.map((b) => {
    const key = sourcesKey(doc, b);
    if (!key) {
      resolved.delete(b.id);
      return b;
    }
    const last = resolved.get(b.id);
    if (last && last.key === key && last.features === b.features) return b;
    const r = resolveBody(doc, b);
    resolved.set(b.id, { key, features: r.features });
    if (r !== b) changed = true;
    return r;
  });
  if (!changed) return false;
  s.replaceDocKeepHistory({ ...doc, bodies });
  return true;
}

function reconcile() {
  if (resolveLiveRefs()) return;
  const s = st();
  for (const b of s.doc.bodies) schedule(b);
  // Silinen gövdelerin önbelleğini bırak
  for (const id of [...built.keys()]) {
    if (!s.doc.bodies.some((b) => b.id === id)) {
      built.delete(id);
      inflight.delete(id);
      const fid = bodyFileId(id);
      const f = geometryCache.get(fid);
      dropOrigins(fid);
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
      s.fileStatus !== prev.fileStatus ||
      // Canlı referans kaynağı taşındı
      ((s.doc.parts !== prev.doc.parts || s.doc.instances !== prev.doc.instances) &&
        s.doc.bodies.some((b) => liveSourcesOf(s.doc, b).length))
    ) {
      reconcileSoon();
    }
  });
  reconcile();
}

/** Parça bir gövdeye aitse yüz referansına imza ve köken ekler (mate kurarken) */
export function withFaceSig(ref: FaceRef): FaceRef {
  const part = st().doc.parts.find((p) => p.id === ref.partId);
  if (!part || !isBodyFileId(part.fileId)) return ref;
  return faceRefSig(part, ref);
}

export { bodyIdOfFile };
