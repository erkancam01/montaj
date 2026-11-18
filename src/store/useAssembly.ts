import { create } from 'zustand';
import { solveMates } from '../lib/mateSolver';
import { cleanupGroups } from '../lib/rigid';
import type { Doc, ExtraSel, FaceRef, FileStatus, Job, MateStatus, ObjKind, Quat, Selection, UiState, Vec3 } from '../types';

const HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 800;

export const emptyDoc = (): Doc => ({ files: [], instances: [], parts: [], mates: [], groups: [] });

/** Eski kayıtları güncel şemaya tamamlar */
export const normalizeDoc = (doc: Doc): Doc =>
  Array.isArray(doc.mates) && Array.isArray(doc.groups)
    ? doc
    : { ...doc, mates: Array.isArray(doc.mates) ? doc.mates : [], groups: Array.isArray(doc.groups) ? doc.groups : [] };

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
  updateLive(fn: (base: Doc) => Doc): void;
  endDrag(): void;
  undo(): void;
  redo(): void;
  setFileStatus(fileId: string, s: FileStatus): void;
  addJob(job: Job): void;
  updateJob(id: string, p: Partial<Job>): void;
  removeJob(id: string): void;
  showToast(text: string, kind?: 'info' | 'error'): void;
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

/** Mate'leri çözer; mate yoksa belgeyi olduğu gibi döndürür */
function solve(prev: Doc, next: Doc): { doc: Doc; mateStatus: Record<string, MateStatus> } {
  if (!next.mates.length) return { doc: next, mateStatus: {} };
  try {
    const r = solveMates(prev, next);
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
  ui: {
    mode: 'translate',
    space: 'world',
    snap: true,
    snapMove: 1,
    snapAngle: 15,
    selectMode: 'part',
    showEdges: true,
    tool: 'select',
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
    const changed = cleanupGroups(prev, raw);
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
    });
  },

  beginDrag: () => {
    dragSnapshot = get().doc;
  },
  setTransformLive: (kind, id, position, quaternion) =>
    set((s) => {
      const { doc, mateStatus } = solve(s.doc, applyTransform(s.doc, kind, id, position, quaternion));
      return { doc, mateStatus };
    }),
  updateLive: (fn) =>
    set((s) => {
      const base = dragSnapshot ?? s.doc;
      // prev = başlangıç belgesi: sürüklenen gövde doğrudan değişmiş sayılır, ona bağlı gövdeler
      // başlangıç pozlarından rijit takip eder (prev = son kare olsaydı takip kaybolurdu)
      const { doc, mateStatus } = solve(base, fn(base));
      return { doc, mateStatus };
    }),
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
}));
