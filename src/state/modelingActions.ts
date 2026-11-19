// Parametrik modelleme işlemleri (gövde, sketch ve özellik oturumları). Arayüz bunları çağırır.
import { warmupKernel } from '@/services/kernel/kernelApi';
import { worldFaceGeom } from '@/core/geometry/faceGeometry';
import { IDENTITY_QUAT, invertT, partWorld, uid } from '@/core/math/math';
import { useAssembly } from '@/state/useAssembly';
import type {
  Body,
  Feature,
  FeatureType,
  Instance,
  Part,
  PlaneDef,
  SketchFeature,
  Transform,
  Vec3,
} from '@/core/types';
import { bodyFileId, isBodyFileId, bodyIdOfFile } from '@/core/types';
import { faceRefWithSig, localPlaneOf } from '@/core/modeling/externalRefs';
import { ownPartIds, wouldCycle } from '@/core/modeling/refLocks';
import { Quaternion, Vector3 } from 'three';
import { BASE_PLANES } from '@/core/modeling/planes';
import { dependentsOf, FEATURE_LABELS, featureDefaults } from '@/core/features/registry';

const st = () => useAssembly.getState();

// Özellik tanımları (ad, varsayılanlar, bağımlılıklar) core/features/registry.ts'te; eski import'lar için:
export { dependentsOf, FEATURE_LABELS };

// ---------------------------------------------------------------- Yardımcılar

export function getBody(bodyId: string): Body | undefined {
  return st().doc.bodies.find((b) => b.id === bodyId);
}

/** Gövdenin ilk instance'ı (yerleşim) */
export function bodyInstance(bodyId: string): Instance | undefined {
  const fid = bodyFileId(bodyId);
  return st().doc.instances.find((i) => i.fileId === fid);
}

export function bodyPart(bodyId: string): Part | undefined {
  const inst = bodyInstance(bodyId);
  return inst ? st().doc.parts.find((p) => p.instanceId === inst.id) : undefined;
}

/** Parça bir gövdeye aitse gövde id'si */
export function bodyIdOfPart(partId: string): string | null {
  const p = st().doc.parts.find((x) => x.id === partId);
  return p && isBodyFileId(p.fileId) ? bodyIdOfFile(p.fileId) : null;
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** normal'e dik, dünya eksenlerinden türetilmiş kararlı bir x yönü */
export function defaultXDir(normal: Vec3): Vec3 {
  const n = norm(normal);
  // normal Z'ye yakınsa X, değilse Z × n (yatay)
  if (Math.abs(n[2]) > 0.9) {
    const x: Vec3 = [1, 0, 0];
    const p = dot(x, n);
    return norm([x[0] - p * n[0], x[1] - p * n[1], x[2] - p * n[2]]);
  }
  return norm(cross([0, 0, 1], n));
}

/** Temel düzlemler (gövde-yerel): tanımı core/modeling/planes.ts */
export { BASE_PLANES };

function applyT(t: Transform, p: Vec3, isDir: boolean): Vec3 {
  const v = new Vector3(...p).applyQuaternion(new Quaternion(...t.quaternion));
  if (!isDir) v.add(new Vector3(...t.position));
  return [v.x, v.y, v.z];
}

/** Dünya düzlemini gövde-yerel düzleme çevirir */
/** Gövde çerçevesi (gövde-yerel → dünya) = parçanın dünya dönüşümü (instance ∘ part) */
export function bodyFrame(bodyId: string): Transform | null {
  const inst = bodyInstance(bodyId);
  const part = bodyPart(bodyId);
  return inst && part ? partWorld(inst, part) : null;
}

export function worldPlaneToBody(bodyId: string, plane: PlaneDef): PlaneDef {
  const frame = bodyFrame(bodyId);
  if (!frame) return plane;
  const inv = invertT(frame);
  return {
    origin: applyT(inv, plane.origin, false),
    xDir: norm(applyT(inv, plane.xDir, true)),
    normal: norm(applyT(inv, plane.normal, true)),
  };
}

/** Gövde-yerel düzlemi dünyaya çevirir (çizim kamerası ve sketch çizimi için) */
export function bodyPlaneToWorld(bodyId: string, plane: PlaneDef): PlaneDef {
  const frame = bodyFrame(bodyId);
  if (!frame) return plane;
  return {
    origin: applyT(frame, plane.origin, false),
    xDir: norm(applyT(frame, plane.xDir, true)),
    normal: norm(applyT(frame, plane.normal, true)),
  };
}

/**
 * Bir parçanın düz yüzeyinden gövde-yerel çizim düzlemi (sabit koordinat; yüze bağlanmaz).
 * Düz yüzey değilse null.
 */
export function planeFromFace(bodyId: string, ref: import('@/core/types').FaceRef): PlaneDef | null {
  const g = worldFaceGeom(ref, st().doc);
  if (!g || g.kind !== 'plane') return null;
  const world: PlaneDef = { origin: g.point, xDir: defaultXDir(g.normal), normal: norm(g.normal) };
  return worldPlaneToBody(bodyId, world);
}

/**
 * Yüze sketch başlatır. Yüz başka bir parçaya aitse düzlem o yüze canlı bağlanır (kaynak taşınınca
 * sketch de gider); gövdenin kendi yüzüyse sabit koordinat olarak kopyalanır.
 */
export function startSketchOnFace(bodyId: string, ref: import('@/core/types').FaceRef): boolean {
  const s = st();
  const plane = planeFromFace(bodyId, ref);
  if (!plane) {
    s.showToast('Seçilen yüzey düz değil; düz bir yüzey seçin.', 'error');
    return false;
  }
  const own = ownPartIds(s.doc, bodyId).has(ref.partId);
  if (own) {
    startSketch(bodyId, plane);
    return true;
  }
  if (wouldCycle(s.doc, bodyId, ref.partId)) {
    s.showToast('Bu parça zaten bu parçaya bağlı; döngü oluşmaması için yüzey sabit kopya olarak alındı.');
    startSketch(bodyId, plane);
    return true;
  }
  const g = worldFaceGeom(ref, s.doc);
  if (!g || g.kind !== 'plane') return false;
  const world: PlaneDef = { origin: g.point, xDir: defaultXDir(g.normal), normal: norm(g.normal) };
  const local = localPlaneOf(s.doc, ref.partId, world);
  startSketch(bodyId, plane, local ? { ref: faceRefWithSig(s.doc, ref), local } : undefined);
  return true;
}

/** Gövdenin tüm canlı dış referanslarını sabit kopyaya çevirir (kilit kalkar; geri alınabilir) */
export function breakExternalRefs(bodyId: string) {
  setFeatures(bodyId, (fs) =>
    fs.map((f) => {
      if (f.type !== 'sketch' || (!f.planeRef && !f.projections?.some((p) => !p.frozen))) return f;
      const { planeRef: _drop, ...rest } = f;
      void _drop;
      return { ...rest, projections: f.projections?.map((p) => (p.frozen ? p : { ...p, frozen: true, broken: undefined })) };
    }),
  );
  st().showToast('Bağlantılar koparıldı: referans geometri sabit kopya olarak kaldı.');
}

/** Boş (hiç özelliği olmayan) gövdeyi siler: yeni parça oluşturulup çizime başlanmadan vazgeçildiyse */
export function discardIfEmpty(bodyId: string) {
  const s = st();
  const b = getBody(bodyId);
  if (!b || b.features.length || s.modeling.sketch?.bodyId === bodyId) return;
  const fid = bodyFileId(bodyId);
  s.commit((d) => ({
    ...d,
    bodies: d.bodies.filter((x) => x.id !== bodyId),
    instances: d.instances.filter((i) => i.fileId !== fid),
    parts: d.parts.filter((p) => p.fileId !== fid),
  }));
  if (s.modeling.activeBodyId === bodyId) exitBody();
}

function nextName(base: string, existing: string[]): string {
  let n = 1;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// ---------------------------------------------------------------- Gövde

/** Yeni boş gövde oluşturur (montajda orijinde), düzenleme moduna girer ve id'sini döndürür */
export function createBody(): string {
  const id = uid();
  const s = st();
  const name = nextName('Parça', s.doc.bodies.map((b) => b.name));
  const instId = uid();
  const fileId = bodyFileId(id);
  const T: Transform = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
  const inst: Instance = { id: instId, fileId, name, ...T, origin: { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] }, visible: true };
  const part: Part = {
    id: uid(),
    instanceId: instId,
    fileId,
    nodeKey: 0,
    name,
    position: [0, 0, 0],
    quaternion: [...IDENTITY_QUAT],
    origin: { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] },
    visible: true,
    color: null,
  };
  s.commit((d) => ({ ...d, bodies: [...d.bodies, { id, name, features: [] }], instances: [...d.instances, inst], parts: [...d.parts, part] }));
  enterBody(id);
  return id;
}

/** Gövdeyi düzenleme moduna alır (özellik ağacı gösterilir) */
export function enterBody(bodyId: string) {
  warmupKernel();
  const s = st();
  s.setModeling({ activeBodyId: bodyId, sketch: null, feature: null, pick: null });
  s.setUi({ tool: 'select' });
  const inst = bodyInstance(bodyId);
  if (inst) s.select({ kind: 'instance', id: inst.id });
}

/** Düzenleme modundan çıkar (açık sketch/özellik oturumu iptal edilir) */
export function exitBody() {
  st().setModeling({ activeBodyId: null, sketch: null, feature: null, pick: null });
}

export function renameBody(bodyId: string, name: string) {
  const n = name.trim();
  if (!n) return;
  const fid = bodyFileId(bodyId);
  st().commit((d) => ({
    ...d,
    bodies: d.bodies.map((b) => (b.id === bodyId ? { ...b, name: n } : b)),
    instances: d.instances.map((i) => (i.fileId === fid ? { ...i, name: n } : i)),
    parts: d.parts.map((p) => (p.fileId === fid ? { ...p, name: n } : p)),
  }));
}

function setFeatures(bodyId: string, fn: (f: Feature[]) => Feature[], mergeKey?: string) {
  st().commit(
    (d) => ({ ...d, bodies: d.bodies.map((b) => (b.id === bodyId ? { ...b, features: fn(b.features) } : b)) }),
    mergeKey,
  );
}

// ---------------------------------------------------------------- Sketch oturumu

/** Yeni sketch başlatır (düzlem gövde-yerel) */
export function startSketch(bodyId: string, plane: PlaneDef, planeRef?: SketchFeature['planeRef']) {
  const body = getBody(bodyId);
  if (!body) return;
  const data: SketchFeature = {
    id: uid(),
    type: 'sketch',
    name: nextName('Sketch', body.features.map((f) => f.name)),
    suppressed: false,
    plane,
    entities: [],
    constraints: [],
    ...(planeRef ? { planeRef } : {}),
  };
  const s = st();
  s.setModeling({ activeBodyId: bodyId, sketch: { bodyId, featureId: data.id, isNew: true, data }, feature: null, pick: null });
  s.setUi({ tool: 'select' });
  s.select(null);
}

/** Var olan sketch'i düzenlemeye açar */
export function editSketch(bodyId: string, featureId: string) {
  const f = getBody(bodyId)?.features.find((x) => x.id === featureId);
  if (!f || f.type !== 'sketch') return;
  const s = st();
  s.setModeling({
    activeBodyId: bodyId,
    sketch: { bodyId, featureId, isNew: false, data: structuredClone(f) },
    feature: null,
    pick: null,
  });
  s.setUi({ tool: 'select' });
  s.select(null);
}

/** Sketch taslağını günceller (geçmişe yazılmaz) */
export function updateSketchDraft(data: SketchFeature) {
  const s = st();
  const sk = s.modeling.sketch;
  if (!sk) return;
  s.setModeling({ sketch: { ...sk, data } });
}

/** Sketch'i bitirir: özelliğe işler (geri alınabilir), bağlı özellikler yeniden üretilir */
export function finishSketch() {
  const s = st();
  const sk = s.modeling.sketch;
  if (!sk) return;
  const data = sk.data;
  if (sk.isNew && !data.entities.length) {
    cancelSketch();
    return;
  }
  setFeatures(sk.bodyId, (fs) => (sk.isNew ? [...fs, data] : fs.map((f) => (f.id === data.id ? data : f))));
  s.setModeling({ sketch: null });
}

export function cancelSketch() {
  st().setModeling({ sketch: null });
}

// ---------------------------------------------------------------- Özellik oturumu

/** Yeni özellik taslağı başlatır (canlı önizlenir) */
export function startFeature(bodyId: string, draft: Feature) {
  const s = st();
  s.setModeling({ activeBodyId: bodyId, feature: { bodyId, isNew: true, draft }, sketch: null, pick: null });
}

/** Var olan özelliği düzenlemeye açar (sketch için editSketch kullanılır) */
export function editFeature(bodyId: string, featureId: string) {
  const f = getBody(bodyId)?.features.find((x) => x.id === featureId);
  if (!f) return;
  if (f.type === 'sketch') {
    editSketch(bodyId, featureId);
    return;
  }
  st().setModeling({ activeBodyId: bodyId, feature: { bodyId, isNew: false, draft: structuredClone(f) }, sketch: null, pick: null });
}

/** Taslağı kısmen günceller (önizleme yenilenir) */
export function updateFeatureDraft(patch: Partial<Feature>) {
  const s = st();
  const fs = s.modeling.feature;
  if (!fs) return;
  s.setModeling({ feature: { ...fs, draft: { ...fs.draft, ...patch } as Feature } });
}

/** Taslağı özelliğe işler (geri alınabilir) */
export function applyFeature() {
  const s = st();
  const fs = s.modeling.feature;
  if (!fs) return;
  const d = fs.draft;
  setFeatures(fs.bodyId, (list) => (fs.isNew ? [...list, d] : list.map((f) => (f.id === d.id ? d : f))));
  s.setModeling({ feature: null, pick: null });
}

export function cancelFeature() {
  st().setModeling({ feature: null, pick: null });
}

/** Özelliği ve ona bağlı özellikleri siler (geri alınabilir) */
export function deleteFeature(bodyId: string, featureId: string) {
  const body = getBody(bodyId);
  if (!body) return;
  const deps = dependentsOf(body, featureId);
  const remove = new Set([featureId, ...deps]);
  setFeatures(bodyId, (fs) => fs.filter((f) => !remove.has(f.id)));
  if (deps.length) st().showToast(`${deps.length} bağlı özellik de silindi.`);
}

export function setFeatureSuppressed(bodyId: string, featureId: string, suppressed: boolean) {
  setFeatures(bodyId, (fs) => fs.map((f) => (f.id === featureId ? { ...f, suppressed } : f)));
}

export function renameFeature(bodyId: string, featureId: string, name: string) {
  const n = name.trim();
  if (!n) return;
  setFeatures(bodyId, (fs) => fs.map((f) => (f.id === featureId ? { ...f, name: n } : f)));
}

/** Özelliği bir adım yukarı/aşağı taşır (bağımlılık sırası korunmazsa reddeder) */
export function moveFeature(bodyId: string, featureId: string, dir: -1 | 1) {
  const body = getBody(bodyId);
  if (!body) return;
  const i = body.features.findIndex((f) => f.id === featureId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= body.features.length) return;
  const a = body.features[i];
  const b = body.features[j];
  const first = dir < 0 ? b : a;
  const second = dir < 0 ? a : b;
  if (dependentsOf(body, first.id).includes(second.id)) {
    st().showToast('Bağımlı özellikler arasında sıra değiştirilemez.', 'error');
    return;
  }
  setFeatures(bodyId, (fs) => {
    const c = [...fs];
    [c[i], c[j]] = [c[j], c[i]];
    return c;
  });
}

// ---------------------------------------------------------------- Varsayılan özellik taslakları

function baseOf(bodyId: string, type: FeatureType) {
  const body = getBody(bodyId);
  return { id: uid(), name: nextName(FEATURE_LABELS[type], body?.features.map((f) => f.name) ?? []), suppressed: false };
}

/** Gövdenin en son (bastırılmamış) sketch'i */
export function lastSketchId(bodyId: string): string | null {
  const fs = getBody(bodyId)?.features ?? [];
  for (let i = fs.length - 1; i >= 0; i--) if (fs[i].type === 'sketch' && !fs[i].suppressed) return fs[i].id;
  return null;
}

/** Gövdede katı var mı (ilk ekleme işlemi add olmalı) */
export function bodyHasSolid(bodyId: string): boolean {
  return (getBody(bodyId)?.features ?? []).some(
    (f) => !f.suppressed && (f.type === 'extrude' || f.type === 'revolve') && f.operation === 'add',
  );
}

/** Yeni özellik taslağı: varsayılan değerler core/features/registry.ts'teki tanımdan */
export function newFeatureDraft(bodyId: string, type: Exclude<FeatureType, 'sketch'>): Feature {
  const sketchId = lastSketchId(bodyId) ?? '';
  return { ...baseOf(bodyId, type), ...featureDefaults(type, sketchId) } as Feature;
}
