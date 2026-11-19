// Sketch düzenleme oturumu: yerel geri al/yinele, id üretimi, varlık/kısıt yardımcıları, çözüm ve arayüz durumu.
// Taslak store.modeling.sketch.data'dadır (updateSketchDraft ile yazılır); buradaki geçmiş yalnız oturum içindir.
import { create } from 'zustand';
import { updateSketchDraft } from '../modeling/actions';
import type { ExtRef, SkConstraint, SkConstraintType, SkEntity, SketchFeature, SkProjection, Vec2 } from '../modeling/types';
import { buildProjectionEntities, faceRefWithSig, projectSource } from '../modeling/externalRefs';
import { ownPartIds, wouldCycle } from '../modeling/refLocks';
import { useAssembly } from '../store/useAssembly';
import {
  applicableConstraints,
  CONSTRAINT_LABELS,
  initSketchSolver,
  isSketchSolverReady,
  measureConstraint,
  solveSketch,
  type SketchSolveResult,
} from './solver';
import {
  arcAngles,
  curvePointIds,
  dist,
  isCurve,
  linePts,
  pointMap,
  projectToLine,
  sub,
  v2,
  type PtMap,
} from '../components/sketch/geom';

// ---------------------------------------------------------------- Arayüz durumu

export type SketchTool = 'select' | 'line' | 'rect' | 'rectCenter' | 'circle' | 'arc' | 'point' | 'dimension' | 'project';

export interface SolveStatus {
  /** Çözücü bu taslağı çözdü mü (hazır değilse false) */
  known: boolean;
  ok: boolean;
  dof: number;
  conflicting: string[];
  redundant: string[];
}

export interface SketchUiState {
  /** Oturumun featureId'si (oturum değişimini algılamak için) */
  sessionId: string | null;
  tool: SketchTool;
  /** Seçili varlık ve kısıt id'leri */
  sel: string[];
  /** İmleç altındaki varlık / kısıt */
  hover: string | null;
  /** Yeni çizilen geometri yardımcı mı */
  construction: boolean;
  status: SolveStatus;
  solverReady: boolean;
  solverError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Değeri düzenlenen ölçü kısıtı */
  editing: string | null;
}

const UNKNOWN: SolveStatus = { known: false, ok: true, dof: -1, conflicting: [], redundant: [] };

export const useSketchUi = create<SketchUiState>(() => ({
  sessionId: null,
  tool: 'select',
  sel: [],
  hover: null,
  construction: false,
  status: UNKNOWN,
  solverReady: false,
  solverError: null,
  canUndo: false,
  canRedo: false,
  editing: null,
}));

const ui = () => useSketchUi.getState();
const setUi = (p: Partial<SketchUiState>) => useSketchUi.setState(p);

export function currentSketch(): SketchFeature | null {
  return useAssembly.getState().modeling.sketch?.data ?? null;
}

// ---------------------------------------------------------------- Id üretimi

let idSeq = 0;
/** Oturumda benzersiz kısa id (p: nokta, l: çizgi, c: daire, a: yay, k: kısıt) */
export function newId(prefix: string, data?: SketchFeature | null): string {
  const taken = (id: string) =>
    !!data && (data.entities.some((e) => e.id === id) || data.constraints.some((c) => c.id === id));
  for (;;) {
    const id = `${prefix}${(Date.now() % 1e8).toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (!taken(id)) return id;
  }
}

// ---------------------------------------------------------------- Geçmiş

const HISTORY_LIMIT = 200;
let past: SketchFeature[] = [];
let future: SketchFeature[] = [];
let gestureBase: SketchFeature | null = null;

function syncHistoryFlags() {
  setUi({ canUndo: past.length > 0, canRedo: future.length > 0 });
}

function pushPast(d: SketchFeature) {
  past.push(d);
  if (past.length > HISTORY_LIMIT) past = past.slice(-HISTORY_LIMIT);
  future = [];
  syncHistoryFlags();
}

/** Sürükleme gibi çok adımlı işlemlerin başı: tek geçmiş adımı olur */
export function beginGesture() {
  gestureBase = currentSketch();
}

export function endGesture() {
  const base = gestureBase;
  gestureBase = null;
  const cur = currentSketch();
  if (base && cur && base !== cur) pushPast(base);
}

export function undoSketch() {
  const cur = currentSketch();
  if (!cur || !past.length) return;
  const prev = past.pop()!;
  future.unshift(cur);
  syncHistoryFlags();
  writeDraft(prev);
  refreshStatus(prev);
}

export function redoSketch() {
  const cur = currentSketch();
  if (!cur || !future.length) return;
  const next = future.shift()!;
  past.push(cur);
  syncHistoryFlags();
  writeDraft(next);
  refreshStatus(next);
}

// ---------------------------------------------------------------- Oturum yaşam döngüsü

/** Yeni oturum açıldığında (SketchLayer çağırır) */
export function beginSession(sessionId: string) {
  past = [];
  future = [];
  gestureBase = null;
  setUi({
    sessionId,
    tool: 'select',
    sel: [],
    hover: null,
    construction: false,
    status: UNKNOWN,
    solverReady: isSketchSolverReady(),
    solverError: null,
    canUndo: false,
    canRedo: false,
    editing: null,
  });
  initSketchSolver()
    .then(() => {
      if (ui().sessionId !== sessionId) return;
      const ready = isSketchSolverReady();
      setUi({ solverReady: ready });
      if (ready) solveInitial();
    })
    .catch((e: unknown) => {
      console.error('Sketch çözücü yüklenemedi', e);
      if (ui().sessionId !== sessionId) return;
      setUi({ solverReady: false, solverError: e instanceof Error ? e.message : String(e) });
    });
  if (isSketchSolverReady()) solveInitial();
}

export function endSession() {
  past = [];
  future = [];
  gestureBase = null;
  setUi({ sessionId: null, sel: [], hover: null, editing: null, status: UNKNOWN, canUndo: false, canRedo: false });
}

function solveInitial() {
  const cur = currentSketch();
  if (!cur) return;
  const r = safeSolve(cur);
  setStatus(r);
  if (r && r.status === 'ok') writeDraft({ ...cur, entities: r.entities });
}

// ---------------------------------------------------------------- Çözüm

function safeSolve(d: SketchFeature, drag?: { pointId: string; x: number; y: number }): SketchSolveResult | null {
  if (!isSketchSolverReady()) return null;
  try {
    return solveSketch(d.entities, d.constraints, drag ? { drag } : undefined);
  } catch (e) {
    console.error('Sketch çözücü hatası', e);
    return { entities: d.entities, status: 'failed', dof: -1, conflicting: [], redundant: [] };
  }
}

function setStatus(r: SketchSolveResult | null) {
  if (!r) {
    setUi({ status: UNKNOWN });
    return;
  }
  setUi({
    status: { known: true, ok: r.status === 'ok', dof: r.dof, conflicting: r.conflicting ?? [], redundant: r.redundant ?? [] },
  });
}

function refreshStatus(d: SketchFeature) {
  setStatus(safeSolve(d));
}

/** Çözücü yokken yayları tutarlı tut: r = |başlangıç − merkez|, bitiş noktası çembere izdüşer */
function normalizeWithoutSolver(d: SketchFeature): SketchFeature {
  if (!d.entities.some((e) => e.kind === 'arc')) return d;
  const pm = pointMap(d.entities);
  const moved = new Map<string, Vec2>();
  const arcs = new Map<string, number>();
  for (const e of d.entities) {
    if (e.kind !== 'arc') continue;
    const c = pm.get(e.c);
    const s = pm.get(e.start);
    const t = pm.get(e.end);
    if (!c || !s || !t) continue;
    const r = Math.hypot(s.x - c.x, s.y - c.y);
    arcs.set(e.id, r);
    const dt = Math.hypot(t.x - c.x, t.y - c.y);
    if (dt > 1e-12 && Math.abs(dt - r) > 1e-9) moved.set(t.id, [c.x + ((t.x - c.x) / dt) * r, c.y + ((t.y - c.y) / dt) * r]);
  }
  return {
    ...d,
    entities: d.entities.map((e) => {
      if (e.kind === 'point' && moved.has(e.id)) {
        const p = moved.get(e.id)!;
        return { ...e, x: p[0], y: p[1] };
      }
      if (e.kind === 'arc' && arcs.has(e.id)) return { ...e, r: arcs.get(e.id)! };
      return e;
    }),
  };
}

function writeDraft(d: SketchFeature) {
  updateSketchDraft(d);
  // Seçimde artık olmayanları at
  const ids = new Set<string>([...d.entities.map((e) => e.id), ...d.constraints.map((c) => c.id)]);
  const s = ui();
  const sel = s.sel.filter((id) => ids.has(id));
  const patch: Partial<SketchUiState> = {};
  if (sel.length !== s.sel.length) patch.sel = sel;
  if (s.hover && !ids.has(s.hover)) patch.hover = null;
  if (s.editing && !ids.has(s.editing)) patch.editing = null;
  if (Object.keys(patch).length) setUi(patch);
}

export interface ApplyOpts {
  /** Geçmişe yaz (varsayılan true; sürüklemede beginGesture/endGesture kullanılır) */
  history?: boolean;
  /** Çözücü sürükleme hedefi */
  drag?: { pointId: string; x: number; y: number };
  /** Başarısızlıkta uyarı gösterme */
  silent?: boolean;
  /** Çözme (yalnız görsel değişiklikler: etiket konumu, ad) */
  noSolve?: boolean;
  /** Başarısızlık uyarısı */
  failMessage?: string;
  /** Çözüm başarısız olsa da uygula (silme işlemleri: çelişki giderilebilsin) */
  allowFail?: boolean;
}

/**
 * Taslağa değişiklik uygular, çözer ve yazar. Çözüm başarısızsa değişiklik uygulanmaz (false döner).
 * Çözücü hazır değilse kısıtlar kaydedilir ama çözülmez.
 */
export function applySketch(fn: (d: SketchFeature) => SketchFeature, opts: ApplyOpts = {}): boolean {
  const cur = currentSketch();
  if (!cur) return false;
  const next = fn(cur);
  if (next === cur) return false;
  let data = next;
  if (!opts.noSolve) {
    const r = safeSolve(next, opts.drag);
    if (r) {
      // Taslak zaten çözülemiyorsa (ör. çelişkili yüklendi) değişiklikler engellenmez; yoksa kullanıcı takılır
      const wasBad = ui().status.known && !ui().status.ok;
      if (r.status !== 'ok' && (opts.allowFail || (wasBad && !opts.drag))) {
        setStatus(r);
        data = next;
      } else if (r.status !== 'ok') {
        if (!opts.silent) {
          const names = (r.conflicting ?? [])
            .map((id) => next.constraints.find((c) => c.id === id))
            .filter((c): c is SkConstraint => !!c)
            .map((c) => constraintLabel(c.type));
          const extra = names.length ? ` Çelişen: ${[...new Set(names)].join(', ')}.` : '';
          useAssembly
            .getState()
            .showToast(`${opts.failMessage ?? 'Kısıtlar çözülemedi; son değişiklik geri alındı.'}${extra}`, 'error');
        }
        return false;
      } else {
        data = { ...next, entities: r.entities };
        setStatus(r);
      }
    } else {
      data = normalizeWithoutSolver(next);
    }
  }
  if (opts.history !== false && !gestureBase) pushPast(cur);
  writeDraft(data);
  return true;
}

// ---------------------------------------------------------------- Varlık / kısıt yardımcıları

/**
 * Varlıkları ve kısıtları siler. Silinen noktayı kullanan eğriler de silinir; silinen eğrilerin artık
 * kullanılmayan noktaları ve silinen varlıklara referans veren kısıtlar da gider.
 */
export function removeItems(d: SketchFeature, ids: Iterable<string>): SketchFeature {
  const del = new Set(ids);
  const ents = d.entities;
  // Silinen noktayı kullanan eğriler
  for (const e of ents) if (isCurve(e) && curvePointIds(e).some((p) => del.has(p))) del.add(e.id);
  const remainingCurves = ents.filter((e) => isCurve(e) && !del.has(e.id));
  const used = new Set(remainingCurves.flatMap(curvePointIds));
  for (const e of ents) {
    if (!isCurve(e) || !del.has(e.id)) continue;
    for (const p of curvePointIds(e)) if (!used.has(p)) del.add(p);
  }
  const entities = ents.filter((e) => !del.has(e.id));
  const alive = new Set(entities.map((e) => e.id));
  const constraints = d.constraints.filter((c) => !del.has(c.id) && c.refs.every((r) => alive.has(r)));
  if (entities.length === ents.length && constraints.length === d.constraints.length) return d;
  return { ...d, entities, constraints };
}

export function addItems(d: SketchFeature, entities: SkEntity[], constraints: SkConstraint[] = []): SketchFeature {
  return { ...d, entities: [...d.entities, ...entities], constraints: [...d.constraints, ...constraints] };
}

export const DIMENSION_TYPES: ReadonlySet<SkConstraintType> = new Set<SkConstraintType>([
  'distance',
  'distanceX',
  'distanceY',
  'radius',
  'diameter',
  'angle',
]);
export const isDimension = (t: SkConstraintType) => DIMENSION_TYPES.has(t);

const FALLBACK_LABELS: Record<SkConstraintType, string> = {
  coincident: 'Çakışık',
  horizontal: 'Yatay',
  vertical: 'Dikey',
  parallel: 'Paralel',
  perpendicular: 'Dik',
  equal: 'Eşit',
  tangent: 'Teğet',
  fix: 'Sabit',
  pointOnLine: 'Çizgi üzerinde',
  pointOnCircle: 'Eğri üzerinde',
  midpoint: 'Orta nokta',
  concentric: 'Eş merkezli',
  distance: 'Mesafe',
  distanceX: 'Yatay mesafe',
  distanceY: 'Dikey mesafe',
  radius: 'Yarıçap',
  diameter: 'Çap',
  angle: 'Açı',
};

export function constraintLabel(t: SkConstraintType): string {
  return CONSTRAINT_LABELS[t] ?? FALLBACK_LABELS[t];
}

/** Uygulanabilir kısıtlar: çözücünün listesi; boşsa (stub dönemi) yerel kurallar */
export function applicableFor(selected: SkEntity[]): SkConstraintType[] {
  let list: SkConstraintType[] = [];
  try {
    list = applicableConstraints(selected);
  } catch (e) {
    console.error(e);
  }
  return list.length ? list : fallbackApplicable(selected);
}

function fallbackApplicable(sel: SkEntity[]): SkConstraintType[] {
  const pts = sel.filter((e) => e.kind === 'point').length;
  const lines = sel.filter((e) => e.kind === 'line').length;
  const circs = sel.filter((e) => e.kind === 'circle' || e.kind === 'arc').length;
  const n = sel.length;
  const out: SkConstraintType[] = [];
  if (n === 1 && lines === 1) out.push('horizontal', 'vertical', 'distance');
  if (n === 1 && pts === 1) out.push('fix', 'distanceX', 'distanceY');
  if (n === 1 && circs === 1) out.push('radius', 'diameter');
  if (n === 2 && pts === 2) out.push('coincident', 'horizontal', 'vertical', 'distance', 'distanceX', 'distanceY');
  if (n === 2 && lines === 2) out.push('parallel', 'perpendicular', 'equal', 'angle');
  if (n === 2 && pts === 1 && lines === 1) out.push('pointOnLine', 'midpoint', 'distance');
  if (n === 2 && pts === 1 && circs === 1) out.push('pointOnCircle');
  if (n === 2 && circs === 2) out.push('equal', 'concentric', 'tangent');
  if (n === 2 && lines === 1 && circs === 1) out.push('tangent');
  if (n > 2 && lines === n) out.push('horizontal', 'vertical', 'parallel', 'equal');
  return out;
}

/** Kısıt refs'ini kanonik sıraya koyar (nokta önce, sonra çizgi, sonra daire/yay) */
export function orderRefs(type: SkConstraintType, refs: string[], ents: readonly SkEntity[]): string[] {
  const rank = (id: string) => {
    const e = ents.find((x) => x.id === id);
    return !e ? 9 : e.kind === 'point' ? 0 : e.kind === 'line' ? 1 : 2;
  };
  if (type === 'tangent') return [...refs].sort((a, b) => rank(a) - rank(b));
  if (refs.length === 2 && rank(refs[0]) > rank(refs[1])) return [refs[1], refs[0]];
  return refs;
}

/** Mevcut geometriden ölçü değeri (çözücü yoksa yerel hesap) */
export function measure(type: SkConstraintType, refs: string[], ents: readonly SkEntity[]): number | null {
  try {
    const v = measureConstraint(type, refs, ents as SkEntity[]);
    if (v !== null && Number.isFinite(v)) return v;
  } catch (e) {
    console.error(e);
  }
  return fallbackMeasure(type, refs, pointMap(ents), ents);
}

function fallbackMeasure(type: SkConstraintType, refs: string[], pm: PtMap, ents: readonly SkEntity[]): number | null {
  const get = (id: string) => ents.find((e) => e.id === id);
  const a = get(refs[0]);
  const b = refs[1] ? get(refs[1]) : undefined;
  if (!a) return null;
  switch (type) {
    case 'distance': {
      if (a.kind === 'line' && !b) {
        const lp = linePts(a, pm);
        return lp ? dist(lp[0], lp[1]) : null;
      }
      if (a.kind === 'point' && b?.kind === 'point') return dist(v2(a), v2(b));
      if (a.kind === 'point' && b?.kind === 'line') {
        const lp = linePts(b, pm);
        return lp ? dist(v2(a), projectToLine(v2(a), lp[0], lp[1])) : null;
      }
      return null;
    }
    case 'distanceX':
    case 'distanceY': {
      const k = type === 'distanceX' ? 0 : 1;
      if (a.kind !== 'point') return null;
      const p0 = b?.kind === 'point' ? v2(a) : ([0, 0] as Vec2);
      const p1 = b?.kind === 'point' ? v2(b) : v2(a);
      return Math.abs(p1[k] - p0[k]);
    }
    case 'radius':
    case 'diameter':
      if (a.kind === 'circle' || a.kind === 'arc') return type === 'radius' ? a.r : 2 * a.r;
      return null;
    case 'angle': {
      if (a.kind !== 'line' || b?.kind !== 'line') return null;
      const la = linePts(a, pm);
      const lb = linePts(b, pm);
      if (!la || !lb) return null;
      const da = sub(la[1], la[0]);
      const db = sub(lb[1], lb[0]);
      const ang = Math.atan2(da[0] * db[1] - da[1] * db[0], da[0] * db[0] + da[1] * db[1]);
      return Math.abs((ang * 180) / Math.PI);
    }
    default:
      return null;
  }
}

/** Aynı tür ve refs'li kısıt */
export function findConstraint(d: SketchFeature, type: SkConstraintType, refs: string[]): SkConstraint | undefined {
  return d.constraints.find(
    (c) => c.type === type && c.refs.length === refs.length && c.refs.every((r, i) => r === refs[i]),
  );
}

/** Kısıt ekler (çözülür). Başarılıysa kısıt id'si. */
export function addConstraint(
  type: SkConstraintType,
  refsIn: string[],
  value?: number,
  label?: Vec2,
): string | null {
  const cur = currentSketch();
  if (!cur) return null;
  const refs = orderRefs(type, refsIn, cur.entities);
  const existing = findConstraint(cur, type, refs);
  if (existing && !isDimension(type)) {
    useAssembly.getState().showToast(`"${constraintLabel(type)}" ilişkisi zaten var.`);
    return null;
  }
  let v = value;
  if (isDimension(type) && v === undefined) v = measure(type, refs, cur.entities) ?? undefined;
  if (isDimension(type) && (v === undefined || !Number.isFinite(v))) {
    useAssembly.getState().showToast('Ölçü değeri hesaplanamadı.', 'error');
    return null;
  }
  const id = newId('k', cur);
  const c: SkConstraint = { id, type, refs, ...(v !== undefined ? { value: v } : {}), ...(label ? { label } : {}) };
  const ok = applySketch((d) => ({ ...d, constraints: [...d.constraints, c] }), {
    failMessage: `"${constraintLabel(type)}" eklenemedi: kısıtlar çelişiyor ya da fazla tanımlı.`,
  });
  return ok ? id : null;
}

/** Ölçü değerini değiştirir (çözülür) */
export function setConstraintValue(id: string, value: number): boolean {
  const cur = currentSketch();
  const c = cur?.constraints.find((x) => x.id === id);
  if (!cur || !c) return false;
  if (c.value === value) return true;
  if ((c.type === 'radius' || c.type === 'diameter' || c.type === 'distance') && value <= 0) {
    useAssembly.getState().showToast('Değer sıfırdan büyük olmalı.', 'error');
    return false;
  }
  return applySketch((d) => ({ ...d, constraints: d.constraints.map((x) => (x.id === id ? { ...x, value } : x)) }), {
    failMessage: 'Bu değerle çözüm bulunamadı; değişiklik geri alındı.',
  });
}

/** Ölçü etiketini taşır (çözülmez) */
export function setConstraintLabel(id: string, label: Vec2, history = true) {
  applySketch((d) => ({ ...d, constraints: d.constraints.map((x) => (x.id === id ? { ...x, label } : x)) }), {
    noSolve: true,
    history,
  });
}

/** Seçili eğrilerin yardımcı durumunu değiştirir (hepsi yardımcıysa normal yapar) */
export function toggleConstruction(ids: string[]): boolean {
  const cur = currentSketch();
  if (!cur) return false;
  const curves = cur.entities.filter((e) => ids.includes(e.id) && isCurve(e));
  if (!curves.length) return false;
  const allCons = curves.every((e) => isCurve(e) && e.construction);
  const set = new Set(curves.map((e) => e.id));
  applySketch(
    (d) => ({
      ...d,
      entities: d.entities.map((e) => (set.has(e.id) && isCurve(e) ? { ...e, construction: !allCons } : e)),
    }),
    { noSolve: true },
  );
  return true;
}

export function deleteSelection() {
  const sel = ui().sel;
  if (!sel.length) return;
  applySketch((d) => removeWithProjections(d, sel), { allowFail: true });
  setUi({ sel: [], hover: null });
}

/** Silme: projeksiyon geometrisinden biri seçiliyse o projeksiyonun tamamı (ve kaydı) silinir */
export function removeWithProjections(d: SketchFeature, ids: string[]): SketchFeature {
  const projIds = new Set<string>();
  for (const id of ids) {
    const e = d.entities.find((x) => x.id === id);
    if (e?.ext) projIds.add(e.ext);
  }
  if (!projIds.size) return removeItems(d, ids);
  const all = new Set(ids);
  for (const e of d.entities) if (e.ext && projIds.has(e.ext)) all.add(e.id);
  const out = removeItems(d, all);
  return { ...out, projections: (d.projections ?? []).filter((p) => !projIds.has(p.id)) };
}

// ---------------------------------------------------------------- Projeksiyon (dış referans)

/**
 * Başka bir parçanın yüzünü/kenarını sketch'e aktarır. Kaynak başka bir parçaysa canlı bağlanır;
 * gövdenin kendi geometrisiyse (ya da döngü oluşacaksa) sabit kopya olur.
 */
export function addProjection(source: ExtRef): boolean {
  const s = useAssembly.getState();
  const sk = s.modeling.sketch;
  const cur = currentSketch();
  if (!sk || !cur) return false;
  const pid = source.face?.partId ?? source.edge?.partId;
  if (!pid) return false;
  const src: ExtRef = source.face ? { face: faceRefWithSig(s.doc, source.face) } : source;
  const dup = (cur.projections ?? []).some((p) => JSON.stringify(p.source) === JSON.stringify(src));
  if (dup) {
    s.showToast('Bu yüzey/kenar zaten aktarıldı.');
    return false;
  }
  const own = ownPartIds(s.doc, sk.bodyId).has(pid);
  const frozen = own || wouldCycle(s.doc, sk.bodyId, pid);
  const r = projectSource(s.doc, sk.bodyId, cur.plane, src);
  if (typeof r === 'string') {
    s.showToast(`Aktarılamadı: ${r}.`, 'error');
    return false;
  }
  const projId = newId('j', cur);
  const ents = buildProjectionEntities(projId, r.curves);
  const proj: SkProjection = { id: projId, source: r.source, entityIds: ents.map((e) => e.id), ...(frozen ? { frozen: true } : {}) };
  const ok = applySketch((d) => ({ ...d, entities: [...d.entities, ...ents], projections: [...(d.projections ?? []), proj] }), {
    failMessage: 'Aktarılan geometri mevcut kısıtlarla çözülemedi.',
  });
  if (ok) {
    const n = ents.filter((e) => e.kind !== 'point').length;
    s.showToast(`${n} eğri aktarıldı${frozen ? ' (sabit kopya)' : ' — kaynağa bağlı'}.`);
  }
  return ok;
}

// ---------------------------------------------------------------- Seçim

export function setSelection(sel: string[]) {
  setUi({ sel });
}

export function toggleSelected(id: string) {
  const s = ui().sel;
  setUi({ sel: s.includes(id) ? s.filter((x) => x !== id) : [...s, id] });
}

export function setTool(tool: SketchTool) {
  setUi({ tool });
}

export function setHover(id: string | null) {
  if (ui().hover !== id) setUi({ hover: id });
}

// ---------------------------------------------------------------- Adlar

const KIND_NAMES: Record<SkEntity['kind'], string> = { point: 'Nokta', line: 'Çizgi', circle: 'Daire', arc: 'Yay' };

/** "Çizgi 3" gibi görünen ad (türüne göre sıra) */
export function entityName(d: SketchFeature, id: string): string {
  const e = d.entities.find((x) => x.id === id);
  if (!e) return '?';
  let n = 0;
  for (const x of d.entities) {
    if (x.kind === e.kind) n++;
    if (x.id === id) break;
  }
  return `${KIND_NAMES[e.kind]} ${n}`;
}

export const kindName = (k: SkEntity['kind']) => KIND_NAMES[k];

/** Yay için güncel açılar (inspector) */
export function arcInfo(d: SketchFeature, id: string) {
  const e = d.entities.find((x) => x.id === id);
  if (!e || e.kind !== 'arc') return null;
  return arcAngles(e, pointMap(d.entities));
}
