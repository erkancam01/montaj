import { create } from 'zustand';
import { solveMates } from '../lib/mateSolver';
import { cleanupGroups } from '../lib/rigid';
import { lockedPartIds } from '../modeling/refLocks';
import type {
  BodyBuildStatus,
  Doc,
  ExtraSel,
  FaceRef,
  FileStatus,
  Job,
  MateStatus,
  ModelingState,
  ObjKind,
  PickRequest,
  PickTarget,
  Quat,
  Selection,
  UiState,
  Vec3,
} from '../types';

const HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 800;

export const emptyDoc = (): Doc => ({ files: [], instances: [], parts: [], mates: [], groups: [], bodies: [] });

/**
 * Sabitlik varsayılanı: belgede hiçbir parçada `fixed` alanı yoksa (eski kayıt ya da montaja ilk ekleme)
 * ilk instance'ın parçaları sabitlenir. Kullanıcı tümünü serbest bıraktıysa (fixed: false) dokunulmaz.
 */
export function withDefaultFixed(doc: Doc): Doc {
  const first = doc.instances[0];
  if (!first || doc.parts.some((p) => p.fixed !== undefined)) return doc;
  if (!doc.parts.some((p) => p.instanceId === first.id)) return doc;
  return { ...doc, parts: doc.parts.map((p) => (p.instanceId === first.id ? { ...p, fixed: true } : p)) };
}

/** Eski kayıtları güncel şemaya tamamlar */
export const normalizeDoc = (doc: Doc): Doc =>
  withDefaultFixed(
    Array.isArray(doc.mates) && Array.isArray(doc.groups) && Array.isArray(doc.bodies)
      ? doc
      : {
          ...doc,
          mates: Array.isArray(doc.mates) ? doc.mates : [],
          groups: Array.isArray(doc.groups) ? doc.groups : [],
          bodies: Array.isArray(doc.bodies) ? doc.bodies : [],
        },
  );

/**
 * Commit sonrası sabitlik: montaja ilk parçalar eklenince varsayılan sabitlik; kopyalanan (yeni id'li)
 * parçalar sabitliği devralmaz.
 */
function fixDefaults(prev: Doc, next: Doc): Doc {
  if (!prev.parts.length) return withDefaultFixed(next);
  if (next.parts === prev.parts) return next;
  const old = new Set(prev.parts.map((p) => p.id));
  let changed = false;
  const parts = next.parts.map((p) => {
    if (old.has(p.id) || p.fixed === undefined) return p;
    changed = true;
    const { fixed: _f, ...rest } = p;
    void _f;
    return rest;
  });
  return changed ? { ...next, parts } : next;
}

/** Instance'ı kalmayan gövdeleri atar (gövdenin son örneği silinince gövde de gider; geri alınabilir) */
function pruneBodies(doc: Doc): Doc {
  if (!doc.bodies.length) return doc;
  const used = new Set(doc.instances.map((i) => i.fileId));
  const kept = doc.bodies.filter((b) => used.has(`body:${b.id}`));
  return kept.length === doc.bodies.length ? doc : { ...doc, bodies: kept };
}

const emptyModeling = (): ModelingState => ({ activeBodyId: null, sketch: null, feature: null, pick: null, build: {} });

export interface AssemblyState {
  doc: Doc;
  /** Birincil seçim. Gruptaki bir parçaya sahnede tıklanınca grup seçilir. */
  selection: Selection;
  /** Ctrl/Shift+tık ile eklenen ek seçimler (parça ya da grup). Birincil seçim yoksa boştur. */
  extraSel: ExtraSel[];
  past: Doc[];
  future: Doc[];
  /** fileId → ayrıştırma durumu (kaydedilmez) */
  fileStatus: Record<string, FileStatus>;
  /** Devam eden / hatalı içe aktarma işleri */
  jobs: Job[];
  toast: { id: number; text: string; kind: 'info' | 'error' } | null;
  ui: UiState;
  /** Izgara hücre boyutu (mm), sığdırmada sahne boyutuna göre ayarlanır */
  gridCell: number;
  /** Seçili mate (selection ile birlikte dolu olmaz) */
  mateSelection: string | null;
  /** Mate aracında seçilen ilk yüzey (referans) */
  pendingFace: FaceRef | null;
  /** Mate aracında imlecin altındaki yüzey */
  hoverFace: FaceRef | null;
  /** mateId → çözüm durumu (kaydedilmez, her çözümde yenilenir) */
  mateStatus: Record<string, MateStatus>;
  /** Parametrik modelleme oturumu (kaydedilmez) */
  modeling: ModelingState;

  setUi(p: Partial<UiState>): void;
  /** Nesne seçer; mate seçimini ve ek seçimleri temizler */
  select(sel: Selection): void;
  /**
   * Ek seçime öğe ekler/çıkarır (Ctrl/Shift+tık). Birincil seçim yoksa öğe birincil olur;
   * öğe birincil seçimin kendisiyse birincil kaldırılır ve ilk ek öğe birincil olur.
   * Birincil seçim instance ise önce öğe tek başına seçilir.
   */
  toggleExtra(item: ExtraSel): void;
  /** Mate seçer, nesne seçimini temizler */
  selectMate(id: string | null): void;
  setPendingFace(f: FaceRef | null): void;
  setHoverFace(f: FaceRef | null): void;
  /**
   * Belgeyi değiştirir ve geri alma geçmişine ekler.
   * mergeKey verilirse ve son commit aynı anahtarla kısa süre önce yapıldıysa tek adım sayılır
   * (renk seçici sürükleme, ok tuşuyla değer artırma gibi).
   * Her commit'ten sonra mate'ler çözülür (bağlı parçalar yerini günceller).
   */
  commit(fn: (doc: Doc) => Doc, mergeKey?: string): void;
  /** Belgeyi geçmişsiz değiştirir (proje yükleme). Seçim, geçmiş ve dosya durumları sıfırlanır. */
  replaceDoc(doc: Doc): void;
  /** Gizmo sürükleme: başlangıçta beginDrag, her harekette setTransformLive / updateLive, bırakınca endDrag */
  beginDrag(): void;
  setTransformLive(kind: ObjKind, id: string, position: Vec3, quaternion: Quat): void;
  /**
   * Sürükleme sırasında belgeyi, sürüklemenin BAŞLANGIÇ belgesinden türetir (birikimli hata olmaz):
   * doc = çöz(fn(başlangıç)). Rijit küme sürüklemede kullanılır (rigid.applyWorldDelta).
   * Sürükleme yoksa mevcut belgeden türetir (geçmişe yazmaz).
   */
  updateLive(fn: (base: Doc) => Doc, held?: string[]): void;
  /** Sürüklemenin başlangıç belgesi (sürükleme yoksa null) */
  dragBase(): Doc | null;
  endDrag(): void;
  undo(): void;
  redo(): void;
  setFileStatus(fileId: string, s: FileStatus): void;
  addJob(job: Job): void;
  updateJob(id: string, p: Partial<Job>): void;
  removeJob(id: string): void;
  showToast(text: string, kind?: 'info' | 'error'): void;

  /**
   * Belgeyi geçmişe yazmadan değiştirir ve mate'leri yeniden çözer; seçim korunur.
   * Yalnız türetilmiş veriyi düzeltmek için (ör. gövde yeniden üretiminden sonra yüz indeksleri).
   */
  replaceDocKeepHistory(doc: Doc): void;
  /** Modelleme durumunu kısmen günceller (geçmişe yazılmaz) */
  setModeling(p: Partial<ModelingState>): void;
  setBuildStatus(bodyId: string, s: BodyBuildStatus | null): void;
  /** Sahneden seçim ister (önceki istek iptal olur) */
  startPick(req: Omit<PickRequest, 'picked'> & { picked?: PickTarget[] }): void;
  /** Sahne bir hedef seçince çağırır: multi ise ekler/çıkarır (aynı hedef ikinci kez → çıkar), değilse yerine koyar */
  addPicked(t: PickTarget): void;
  /** picked listesini dışarıdan değiştirir (panelde tek tek silme) */
  setPicked(list: PickTarget[]): void;
  endPick(): void;
}

let dragSnapshot: Doc | null = null;
let lastMerge: { key: string; time: number } | null = null;
let toastSeq = 0;

export function applyTransform(doc: Doc, kind: ObjKind, id: string, position: Vec3, quaternion: Quat): Doc {
  if (kind === 'instance') {
    return { ...doc, instances: doc.instances.map((i) => (i.id === id ? { ...i, position, quaternion } : i)) };
  }
  return { ...doc, parts: doc.parts.map((p) => (p.id === id ? { ...p, position, quaternion } : p)) };
}

export function selectionExists(sel: Selection, doc: Doc): boolean {
  if (!sel) return false;
  if (sel.kind === 'instance') return doc.instances.some((i) => i.id === sel.id);
  if (sel.kind === 'group') return doc.groups.some((g) => g.id === sel.id);
  return doc.parts.some((p) => p.id === sel.id);
}

const validSel = (sel: Selection, doc: Doc): Selection => (selectionExists(sel, doc) ? sel : null);
/** Ek seçimlerden artık var olmayanları atar; birincil seçim yoksa ek seçim de olmaz */
const validExtra = (extra: ExtraSel[], sel: Selection, doc: Doc): ExtraSel[] => {
  if (!sel) return extra.length ? [] : extra;
  const kept = extra.filter((e) => selectionExists(e, doc));
  return kept.length === extra.length ? extra : kept;
};
const sameItem = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind === b.kind && a.id === b.id;
const validMate = (id: string | null, doc: Doc) => (id && doc.mates.some((m) => m.id === id) ? id : null);
/** Silinen parçaya ait yüzey seçimini temizler */
const validFace = (f: FaceRef | null, doc: Doc) => (f && doc.parts.some((p) => p.id === f.partId) ? f : null);

const sameT = (a: { position: number[]; quaternion: number[] }, b: { position: number[]; quaternion: number[] }) =>
  a.position.every((v, i) => v === b.position[i]) && a.quaternion.every((v, i) => v === b.quaternion[i]);

let lockToastAt = 0;

/**
 * Canlı dış referanslı gövdeler konumlarını referanslarından alır: doğrudan taşınırlarsa (gizmo, sayısal
 * giriş, grup) önceki dönüşüm geri yüklenir.
 */
function enforceLocks(prev: Doc, next: Doc): Doc {
  if (!next.bodies?.length) return next;
  const locked = lockedPartIds(next);
  if (!locked.size) return next;
  let parts = next.parts;
  let instances = next.instances;
  for (const pid of locked) {
    const pn = next.parts.find((p) => p.id === pid);
    const pp = prev.parts.find((p) => p.id === pid);
    if (!pn || !pp) continue;
    const inn = next.instances.find((i) => i.id === pn.instanceId);
    const ip = prev.instances.find((i) => i.id === pp.instanceId);
    if (!inn || !ip || inn.id !== ip.id) continue;
    if (sameT(pn, pp) && sameT(inn, ip)) continue;
    parts = parts.map((p) => (p.id === pid ? { ...p, position: pp.position, quaternion: pp.quaternion } : p));
    instances = instances.map((i) => (i.id === inn.id ? { ...i, position: ip.position, quaternion: ip.quaternion } : i));
  }
  if (parts === next.parts && instances === next.instances) return next;
  const now = Date.now();
  if (now - lockToastAt > 3000) {
    lockToastAt = now;
    queueMicrotask(() =>
      useAssembly
        .getState()
        .showToast('Bu parça başka bir parçaya bağlı; konumunu ondan alır. Taşımak için özellik ağacında "Bağlantıyı kopar".'),
    );
  }
  return { ...next, parts, instances };
}

let fixedToastAt = 0;
export const MSG_FIXED_MOVE = 'Bu parça sabit; taşımak için önce "Serbest bırak" ile sabitliği kaldırın.';

/** Sabit parça taşınma girişiminde (gizmo, sürükleme) kısıtlı aralıkla bilgi mesajı */
export function toastFixedMove() {
  const now = Date.now();
  if (now - fixedToastAt < 3000) return;
  fixedToastAt = now;
  queueMicrotask(() => useAssembly.getState().showToast(MSG_FIXED_MOVE));
}

const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

/**
 * Sabit parçalar doğrudan taşınamaz (gizmo, sayısal giriş, sıfırla, instance taşıma): dünya konumu değişen
 * sabit parçanın kendisi, instance'ı ve (gruptaysa) tüm grup üyeleri önceki dönüşüme geri döner.
 */
function enforceFixed(prev: Doc, next: Doc): Doc {
  if (next.parts === prev.parts && next.instances === prev.instances) return next;
  const fixedIds = next.parts.filter((p) => p.fixed === true).map((p) => p.id);
  if (!fixedIds.length) return next;
  const prevParts = new Map(prev.parts.map((p) => [p.id, p]));
  const prevInsts = new Map(prev.instances.map((i) => [i.id, i]));
  const nextParts = new Map(next.parts.map((p) => [p.id, p]));
  const nextInsts = new Map(next.instances.map((i) => [i.id, i]));
  const revertParts = new Set<string>();
  const revertInsts = new Set<string>();
  for (const id of fixedIds) {
    const pn = nextParts.get(id)!;
    const pp = prevParts.get(id);
    const inn = nextInsts.get(pn.instanceId);
    const ip = pp && prevInsts.get(pp.instanceId);
    if (!pp || !inn || !ip || inn.id !== ip.id) continue;
    const instMoved = !near(inn.position, ip.position) || !near(inn.quaternion, ip.quaternion);
    const partMoved = !near(pn.position, pp.position) || !near(pn.quaternion, pp.quaternion);
    if (!instMoved && !partMoved) continue;
    if (instMoved) revertInsts.add(inn.id);
    const g = next.groups.find((x) => x.partIds.includes(id));
    for (const m of g ? g.partIds : [id]) revertParts.add(m);
  }
  if (!revertParts.size && !revertInsts.size) return next;
  toastFixedMove();
  return {
    ...next,
    parts: next.parts.map((p) => {
      const pp = revertParts.has(p.id) ? prevParts.get(p.id) : undefined;
      return pp && pp.instanceId === p.instanceId ? { ...p, position: pp.position, quaternion: pp.quaternion } : p;
    }),
    instances: revertInsts.size
      ? next.instances.map((i) => {
          const ip = revertInsts.has(i.id) ? prevInsts.get(i.id) : undefined;
          return ip ? { ...i, position: ip.position, quaternion: ip.quaternion } : i;
        })
      : next.instances,
  };
}

/**
 * Mate'leri çözer; mate yoksa belgeyi olduğu gibi döndürür. held = fareyle/gizmoyla tutulan parçalar
 * (çözücüde sabitlerden sonra öncelikli).
 */
export function solve(
  prev: Doc,
  nextIn: Doc,
  held?: Iterable<string>,
): { doc: Doc; mateStatus: Record<string, MateStatus> } {
  const next = enforceFixed(prev, enforceLocks(prev, nextIn));
  if (!next.mates.length) return { doc: next, mateStatus: {} };
  try {
    const r = solveMates(prev, next, { held });
    return { doc: r.doc, mateStatus: r.status };
  } catch (e) {
    console.error('Mate çözücü hatası', e);
    const message = `Çözücü hatası: ${e instanceof Error ? e.message : String(e)}`;
    return { doc: next, mateStatus: Object.fromEntries(next.mates.map((m) => [m.id, { state: 'error', message }])) };
  }
}

export const useAssembly = create<AssemblyState>()((set, get) => ({
  doc: emptyDoc(),
  selection: null,
  extraSel: [],
  past: [],
  future: [],
  fileStatus: {},
  jobs: [],
  toast: null,
  gridCell: 10,
  mateSelection: null,
  pendingFace: null,
  hoverFace: null,
  mateStatus: {},
  modeling: emptyModeling(),
  ui: {
    mode: 'translate',
    space: 'world',
    snap: true,
    snapMove: 1,
    snapAngle: 15,
    selectMode: 'part',
    showEdges: true,
    tool: 'select',
    invertWheel: false,
  },

  setUi: (p) =>
    set((s) => {
      const ui = { ...s.ui, ...p };
      // Araç değişince yarım kalan yüzey seçimi iptal
      return ui.tool !== s.ui.tool ? { ui, pendingFace: null, hoverFace: null } : { ui };
    }),
  select: (selection) => set(selection ? { selection, extraSel: [], mateSelection: null } : { selection, extraSel: [] }),
  toggleExtra: (item) =>
    set((s) => {
      const sel = s.selection;
      if (!sel || sel.kind === 'instance') return { selection: item, extraSel: [], mateSelection: null };
      if (sameItem(sel, item)) {
        const [first, ...rest] = s.extraSel;
        return { selection: first ?? null, extraSel: rest };
      }
      const has = s.extraSel.some((e) => sameItem(e, item));
      return { extraSel: has ? s.extraSel.filter((e) => !sameItem(e, item)) : [...s.extraSel, item] };
    }),
  selectMate: (id) => set(id ? { mateSelection: id, selection: null } : { mateSelection: null }),
  setPendingFace: (pendingFace) => set({ pendingFace }),
  setHoverFace: (hoverFace) => set({ hoverFace }),

  commit: (fn, mergeKey) => {
    const prev = get().doc;
    const raw = fn(prev);
    if (raw === prev) return;
    const changed = fixDefaults(prev, pruneBodies(cleanupGroups(prev, raw)));
    const { doc: next, mateStatus } = solve(prev, changed);
    const now = Date.now();
    const merge = !!mergeKey && lastMerge?.key === mergeKey && now - lastMerge.time < MERGE_WINDOW_MS;
    lastMerge = mergeKey ? { key: mergeKey, time: now } : null;
    set((s) => ({
      doc: next,
      mateStatus,
      past: merge ? s.past : [...s.past, prev].slice(-HISTORY_LIMIT),
      future: [],
      selection: validSel(s.selection, next),
      extraSel: validExtra(s.extraSel, validSel(s.selection, next), next),
      mateSelection: validMate(s.mateSelection, next),
      pendingFace: validFace(s.pendingFace, next),
      hoverFace: validFace(s.hoverFace, next),
    }));
  },

  replaceDoc: (doc) => {
    lastMerge = null;
    const d = normalizeDoc(doc);
    set({
      doc: d,
      past: [],
      future: [],
      selection: null,
      extraSel: [],
      mateSelection: null,
      pendingFace: null,
      hoverFace: null,
      fileStatus: {},
      // Kayıtlı dönüşümler zaten çözülmüş; durumlar dosyalar yüklendikçe ilk commit'te güncellenir
      mateStatus: {},
      modeling: emptyModeling(),
    });
  },

  beginDrag: () => {
    dragSnapshot = get().doc;
  },
  setTransformLive: (kind, id, position, quaternion) =>
    set((s) => {
      // Gizmoyla tutulan nesne çözücüde önceliklidir (ona bağlı serbest parçalar onu izler)
      const held = kind === 'part' ? [id] : s.doc.parts.filter((p) => p.instanceId === id).map((p) => p.id);
      const { doc, mateStatus } = solve(s.doc, applyTransform(s.doc, kind, id, position, quaternion), held);
      return { doc, mateStatus };
    }),
  updateLive: (fn, held) =>
    set((s) => {
      const base = dragSnapshot ?? s.doc;
      // prev = başlangıç belgesi: sürüklenen gövde doğrudan değişmiş sayılır, ona bağlı gövdeler
      // başlangıç pozlarından rijit takip eder (prev = son kare olsaydı takip kaybolurdu)
      const { doc, mateStatus } = solve(base, fn(base), held);
      return { doc, mateStatus };
    }),
  dragBase: () => dragSnapshot,
  endDrag: () => {
    const snap = dragSnapshot;
    dragSnapshot = null;
    lastMerge = null;
    if (snap && snap !== get().doc) {
      set((s) => ({ past: [...s.past, snap].slice(-HISTORY_LIMIT), future: [] }));
    }
  },

  undo: () => {
    const { past, doc, future, selection } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    lastMerge = null;
    set({
      doc: prev,
      past: past.slice(0, -1),
      future: [doc, ...future],
      selection: validSel(selection, prev),
      extraSel: validExtra(get().extraSel, validSel(selection, prev), prev),
      mateSelection: validMate(get().mateSelection, prev),
      pendingFace: validFace(get().pendingFace, prev),
      hoverFace: validFace(get().hoverFace, prev),
      mateStatus: solve(prev, prev).mateStatus,
    });
  },
  redo: () => {
    const { past, doc, future, selection } = get();
    if (!future.length) return;
    const next = future[0];
    lastMerge = null;
    set({
      doc: next,
      past: [...past, doc],
      future: future.slice(1),
      selection: validSel(selection, next),
      extraSel: validExtra(get().extraSel, validSel(selection, next), next),
      mateSelection: validMate(get().mateSelection, next),
      pendingFace: validFace(get().pendingFace, next),
      hoverFace: validFace(get().hoverFace, next),
      mateStatus: solve(next, next).mateStatus,
    });
  },

  setFileStatus: (fileId, st) =>
    set((s) => ({
      fileStatus: { ...s.fileStatus, [fileId]: st },
      // Geometri hazır olunca mate durumlarını yenile (dönüşümler kayıtlı hâliyle zaten çözülmüş)
      ...(st.status === 'ready' && s.doc.mates.length ? { mateStatus: solve(s.doc, s.doc).mateStatus } : {}),
    })),
  addJob: (job) => set((s) => ({ jobs: [...s.jobs, job] })),
  updateJob: (id, p) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) })),
  removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  showToast: (text, kind = 'info') => set({ toast: { id: ++toastSeq, text, kind } }),

  replaceDocKeepHistory: (doc) =>
    set((s) => {
      const { doc: next, mateStatus } = solve(s.doc, doc);
      return { doc: next, mateStatus };
    }),
  setModeling: (p) => set((s) => ({ modeling: { ...s.modeling, ...p } })),
  setBuildStatus: (bodyId, b) =>
    set((s) => {
      const build = { ...s.modeling.build };
      if (b) build[bodyId] = b;
      else delete build[bodyId];
      return { modeling: { ...s.modeling, build } };
    }),
  startPick: (req) =>
    set((s) => ({ modeling: { ...s.modeling, pick: { ...req, picked: req.picked ?? [] } }, hoverFace: null })),
  addPicked: (t) =>
    set((s) => {
      const pick = s.modeling.pick;
      if (!pick) return {};
      const same = (a: PickTarget, b: PickTarget) =>
        a.kind === 'face' && b.kind === 'face'
          ? a.ref.partId === b.ref.partId && a.ref.meshIndex === b.ref.meshIndex && a.ref.faceIndex === b.ref.faceIndex
          : a.kind === 'edge' && b.kind === 'edge'
            ? a.partId === b.partId && a.edgeIndex === b.edgeIndex
            : false;
      let picked: PickTarget[];
      if (pick.multi) {
        picked = pick.picked.some((x) => same(x, t)) ? pick.picked.filter((x) => !same(x, t)) : [...pick.picked, t];
      } else picked = [t];
      return { modeling: { ...s.modeling, pick: { ...pick, picked } } };
    }),
  setPicked: (list) =>
    set((s) => (s.modeling.pick ? { modeling: { ...s.modeling, pick: { ...s.modeling.pick, picked: list } } } : {})),
  endPick: () => set((s) => ({ modeling: { ...s.modeling, pick: null }, hoverFace: null })),
}));
