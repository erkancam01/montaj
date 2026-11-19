// Sketch araç denetleyicisi: fare/klavye girdisi, yakalama (snap), çizim durum makinesi, ölçü aracı.
// Canvas DOM olaylarını SketchLayer bağlar; DOM katmanları (giriş kutusu, araç çubuğu) buradaki fonksiyonları çağırır.
import { create } from 'zustand';
import { cancelSketch, finishSketch } from '../../modeling/actions';
import type { SkConstraint, SkConstraintType, SkEntity, SketchFeature, Vec2 } from '../../modeling/types';
import { useAssembly } from '../../store/useAssembly';
import {
  addConstraint,
  addItems,
  addProjection,
  applySketch,
  beginGesture,
  currentSketch,
  deleteSelection,
  endGesture,
  measure,
  newId,
  redoSketch,
  setHover,
  setSelection,
  toggleConstruction,
  toggleSelected,
  undoSketch,
  useSketchUi,
  type SketchTool,
} from '../../sketch/session';
import {
  add,
  arcAngles,
  curvePointIds,
  curvePolyline,
  dist,
  distToCurve,
  isCurve,
  linePts,
  mul,
  norm,
  parseNum,
  pointMap,
  polar,
  sub,
  TAU,
  v2,
  fmt,
  intersectLines,
} from './geom';
import { clientToOverlay, clientToSketch, pxSize, sketchToOverlay } from './view';
import { pickProjectionSource } from './projectPick';

// ---------------------------------------------------------------- Çizim durumu (görsel)

export interface Preview {
  /** Önizleme çoklu çizgileri */
  polys: Vec2[][];
  /** Yardımcı (kesikli) önizleme çizgileri */
  guides: Vec2[][];
  points: Vec2[];
  /** Ölçü aracı önizlemesi */
  dim?: SkConstraint;
}

export type TypedKind = 'line' | 'circle' | 'rect';

export interface TypedInput {
  kind: TypedKind;
  values: string[];
  active: number;
}

export interface DrawState {
  preview: Preview | null;
  /** Yakalama işaretçisi (sketch-2B) */
  marker: Vec2 | null;
  /** İmleç (overlay px) */
  cursor: { x: number; y: number } | null;
  hint: string | null;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  typed: TypedInput | null;
  /** Ölçü aracında seçilenler */
  pending: string[];
  /** Görünüm hedefinde 1 pikselin mm karşılığı (yaklaşık; ok/etiket boyutları için) */
  px: number;
}

export const useDraw = create<DrawState>(() => ({
  preview: null,
  marker: null,
  cursor: null,
  hint: null,
  box: null,
  typed: null,
  pending: [],
  px: 1,
}));

const setDraw = (p: Partial<DrawState>) => useDraw.setState(p);
const ui = () => useSketchUi.getState();
const toast = (t: string, k: 'info' | 'error' = 'info') => useAssembly.getState().showToast(t, k);

// ---------------------------------------------------------------- Yakalama

interface Snap {
  pos: Vec2;
  /** Var olan nokta (paylaşılır) */
  pointId?: string;
  /** Çizgi orta noktası (midpoint kısıtı) */
  midOf?: string;
  /** Eğri üzerinde (pointOnLine / pointOnCircle) */
  onCurve?: string;
  /** Orijin (fix) */
  origin?: boolean;
  hint: string | null;
}

const SNAP_PX = 9;
const CURVE_PX = 6;
const INFER_DEG = 3;

function pointRole(d: SketchFeature, id: string): string {
  for (const e of d.entities) {
    if (e.kind === 'circle' && e.c === id) return 'Merkez';
    if (e.kind === 'arc' && e.c === id) return 'Merkez';
  }
  const p = d.entities.find((e) => e.id === id);
  return p && p.kind === 'point' && p.standalone ? 'Nokta' : 'Uç nokta';
}

function snapAt(raw: Vec2, d: SketchFeature, exclude?: Set<string>): Snap {
  const px = pxSize(raw);
  const pm = pointMap(d.entities);
  // 1) mevcut nokta
  let best: { id: string; d: number } | null = null;
  for (const p of pm.values()) {
    if (exclude?.has(p.id)) continue;
    const dd = dist(raw, v2(p));
    if (dd < SNAP_PX * px && (!best || dd < best.d)) best = { id: p.id, d: dd };
  }
  if (best) {
    const p = pm.get(best.id)!;
    return { pos: v2(p), pointId: p.id, hint: pointRole(d, p.id) };
  }
  // 2) çizgi orta noktası
  for (const e of d.entities) {
    if (e.kind !== 'line' || exclude?.has(e.id)) continue;
    const lp = linePts(e, pm);
    if (!lp) continue;
    const m: Vec2 = [(lp[0][0] + lp[1][0]) / 2, (lp[0][1] + lp[1][1]) / 2];
    if (dist(raw, m) < SNAP_PX * px) return { pos: m, midOf: e.id, hint: 'Orta nokta' };
  }
  // 3) orijin
  if (Math.hypot(raw[0], raw[1]) < SNAP_PX * px) return { pos: [0, 0], origin: true, hint: 'Orijin' };
  // 4) eğri üzerinde
  let bc: { id: string; d: number; foot: Vec2 } | null = null;
  for (const e of d.entities) {
    if (!isCurve(e) || exclude?.has(e.id)) continue;
    const r = distToCurve(raw, e, pm);
    if (r && r.d < CURVE_PX * px && (!bc || r.d < bc.d)) bc = { id: e.id, d: r.d, foot: r.foot };
  }
  if (bc) return { pos: bc.foot, onCurve: bc.id, hint: 'Eğri üzerinde' };
  // 5) eksenler (yalnız konum)
  const st = useAssembly.getState().ui;
  const grid = (v: number) => (st.snap && st.snapMove > 0 ? Math.round(v / st.snapMove) * st.snapMove : v);
  if (Math.abs(raw[1]) < CURVE_PX * px) return { pos: [grid(raw[0]), 0], hint: 'X ekseni' };
  if (Math.abs(raw[0]) < CURVE_PX * px) return { pos: [0, grid(raw[1])], hint: 'Y ekseni' };
  // 6) ızgara
  return { pos: [grid(raw[0]), grid(raw[1])], hint: null };
}

/** Başlangıca göre yatay/dikey çıkarımı (yalnız serbest konumlarda) */
function infer(start: Vec2, s: Snap): { snap: Snap; infer: 'h' | 'v' | null } {
  if (s.pointId || s.midOf || s.origin || s.onCurve) {
    return { snap: s, infer: null };
  }
  const d = sub(s.pos, start);
  if (Math.hypot(d[0], d[1]) < 1e-9) return { snap: s, infer: null };
  const ang = (Math.abs(Math.atan2(d[1], d[0])) * 180) / Math.PI;
  if (ang < INFER_DEG || ang > 180 - INFER_DEG) return { snap: { pos: [s.pos[0], start[1]], hint: 'Yatay' }, infer: 'h' };
  if (Math.abs(ang - 90) < INFER_DEG) return { snap: { pos: [start[0], s.pos[1]], hint: 'Dikey' }, infer: 'v' };
  return { snap: s, infer: null };
}

/** Yakalamaya göre nokta id'si: var olanı paylaşır ya da yeni nokta + ilgili kısıtı ekler */
function resolvePoint(s: Snap, d: SketchFeature, ents: SkEntity[], cons: SkConstraint[], standalone = false): string {
  if (s.pointId && d.entities.some((e) => e.id === s.pointId)) return s.pointId;
  const id = newId('p', d);
  ents.push({ id, kind: 'point', x: s.pos[0], y: s.pos[1], ...(standalone ? { standalone: true } : {}) });
  if (s.midOf) cons.push({ id: newId('k', d), type: 'midpoint', refs: [id, s.midOf] });
  else if (s.origin) cons.push({ id: newId('k', d), type: 'fix', refs: [id] });
  else if (s.onCurve) {
    const c = d.entities.find((e) => e.id === s.onCurve);
    if (c?.kind === 'line') cons.push({ id: newId('k', d), type: 'pointOnLine', refs: [id, c.id] });
    else if (c) cons.push({ id: newId('k', d), type: 'pointOnCircle', refs: [id, c.id] });
  }
  return id;
}

// ---------------------------------------------------------------- Denetleyici durumu

interface DragState {
  kind: 'point' | 'radius' | 'move' | 'label';
  id: string;
  startRaw: Vec2;
  startClient: { x: number; y: number };
  started: boolean;
  /** Başlangıç nokta konumları */
  orig: Map<string, Vec2>;
}

const ctl: {
  /** Tıklanan yakalamalar (araç adımları) */
  pts: Snap[];
  /** Zincirin ilk noktası (kapanınca biter) */
  chainFirst: string | null;
  /** Yay süpürmesi */
  sweep: number;
  lastAng: number;
  /** Son hesaplanan hedef */
  last: { snap: Snap; infer: 'h' | 'v' | null; typed: number[] } | null;
  lastRaw: Vec2 | null;
  lastClient: { x: number; y: number } | null;
  drag: DragState | null;
  boxStart: { x: number; y: number; additive: boolean } | null;
  rightDown: { x: number; y: number } | null;
} = {
  pts: [],
  chainFirst: null,
  sweep: 0,
  lastAng: 0,
  last: null,
  lastRaw: null,
  lastClient: null,
  drag: null,
  boxStart: null,
  rightDown: null,
};

/** Aktif bir çizim adımı var mı */
export function isDrawing(): boolean {
  return ctl.pts.length > 0 || useDraw.getState().pending.length > 0;
}

/** Yarım kalan çizimi iptal eder */
export function resetDraw() {
  ctl.pts = [];
  ctl.chainFirst = null;
  ctl.sweep = 0;
  ctl.last = null;
  setDraw({ preview: null, typed: null, pending: [], marker: null, hint: null, box: null });
}

export function chooseTool(t: SketchTool) {
  resetDraw();
  ctl.drag = null;
  useSketchUi.setState({ tool: t, hover: null });
  if (ctl.lastRaw) refreshPreview();
}

/** Oturum değişiminde tam sıfırlama */
export function resetController() {
  resetDraw();
  ctl.drag = null;
  ctl.boxStart = null;
  ctl.lastRaw = null;
  ctl.lastClient = null;
  setDraw({ cursor: null });
}

// ---------------------------------------------------------------- İsabet testi

interface Hit {
  id: string;
  kind: SkEntity['kind'];
}

function hitTest(raw: Vec2, d: SketchFeature): Hit | null {
  const px = pxSize(raw);
  const pm = pointMap(d.entities);
  let bp: { id: string; d: number } | null = null;
  for (const p of pm.values()) {
    const dd = dist(raw, v2(p));
    if (dd < SNAP_PX * px && (!bp || dd < bp.d)) bp = { id: p.id, d: dd };
  }
  if (bp) return { id: bp.id, kind: 'point' };
  let bc: { e: SkEntity; d: number } | null = null;
  for (const e of d.entities) {
    if (!isCurve(e)) continue;
    const r = distToCurve(raw, e, pm);
    if (r && r.d < CURVE_PX * px && (!bc || r.d < bc.d)) bc = { e, d: r.d };
  }
  return bc ? { id: bc.e.id, kind: bc.e.kind } : null;
}

// ---------------------------------------------------------------- Önizleme

function typedNumbers(): number[] {
  const t = useDraw.getState().typed;
  if (!t) return [];
  return t.values.map((v) => parseNum(v) ?? NaN);
}

const fmtLen = (v: number) => `${fmt(v)} mm`;

/** İmleç konumundan araç hedefini ve önizlemeyi hesaplar */
function computeTarget(raw: Vec2, d: SketchFeature) {
  const tool = ui().tool;
  const exclude = new Set<string>();
  let s = snapAt(raw, d, exclude);
  let inf: 'h' | 'v' | null = null;
  const typed = typedNumbers();
  const start = ctl.pts[0]?.pos;
  let hint = s.hint;
  const preview: Preview = { polys: [], guides: [], points: [] };
  const live: string[] = [];

  if (tool === 'line' && start) {
    const r = infer(start, s);
    s = r.snap;
    inf = r.infer;
    hint = s.hint;
    const L = typed[0];
    if (L > 0) {
      const dir = norm(sub(s.pos, start));
      s = { pos: add(start, mul(dir, L)), hint: inf === 'h' ? 'Yatay' : inf === 'v' ? 'Dikey' : null };
    }
    preview.polys.push([start, s.pos]);
    live.push(fmtLen(dist(start, s.pos)));
    if (inf) preview.guides.push([start, s.pos]);
  } else if ((tool === 'rect' || tool === 'rectCenter') && start) {
    let W = typed[0];
    let H = typed[1];
    const dx = s.pos[0] - start[0];
    const dy = s.pos[1] - start[1];
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;
    const half = tool === 'rectCenter' ? 0.5 : 1;
    if (W > 0 || H > 0) {
      if (!(W > 0)) W = Math.abs(dx) / half;
      if (!(H > 0)) H = Math.abs(dy) / half;
      s = { pos: [start[0] + sx * W * half, start[1] + sy * H * half], hint: null };
    }
    const c = s.pos;
    const a: Vec2 = tool === 'rectCenter' ? [2 * start[0] - c[0], 2 * start[1] - c[1]] : start;
    preview.polys.push([a, [c[0], a[1]], c, [a[0], c[1]], a]);
    if (tool === 'rectCenter') preview.guides.push([a, c]);
    live.push(`${fmt(Math.abs(c[0] - a[0]))} × ${fmt(Math.abs(c[1] - a[1]))} mm`);
  } else if (tool === 'circle' && start) {
    const R = typed[0];
    if (R > 0) s = { pos: add(start, mul(norm(sub(s.pos, start)), R)), hint: null };
    const r = dist(start, s.pos);
    preview.polys.push(curvePolylineCircle(start, r));
    preview.guides.push([start, s.pos]);
    live.push(`R ${fmtLen(r)}`);
  } else if (tool === 'arc' && start) {
    if (ctl.pts.length === 1) {
      const r = dist(start, s.pos);
      preview.guides.push([start, s.pos]);
      preview.guides.push(curvePolylineCircle(start, r));
      live.push(`R ${fmtLen(r)}`);
    } else {
      const sp = ctl.pts[1].pos;
      const r = dist(start, sp);
      const a0 = Math.atan2(sp[1] - start[1], sp[0] - start[0]);
      const ang = Math.atan2(s.pos[1] - start[1], s.pos[0] - start[0]);
      let delta = ang - ctl.lastAng;
      while (delta > Math.PI) delta -= TAU;
      while (delta < -Math.PI) delta += TAU;
      ctl.sweep = Math.max(-TAU + 1e-3, Math.min(TAU - 1e-3, ctl.sweep + delta));
      ctl.lastAng = ang;
      if (!s.pointId) s = { pos: polar(start, r, a0 + ctl.sweep), hint: s.hint === 'Eğri üzerinde' ? null : s.hint };
      const sw = ctl.sweep;
      const pts: Vec2[] = [];
      const n = Math.max(2, Math.ceil((Math.abs(sw) / TAU) * 96));
      for (let i = 0; i <= n; i++) pts.push(polar(start, r, a0 + (sw * i) / n));
      preview.polys.push(pts);
      preview.guides.push([start, sp], [start, s.pos]);
      live.push(`${fmt((Math.abs(sw) * 180) / Math.PI, 1)}°`);
    }
  }
  if (ctl.pts.length) preview.points.push(...ctl.pts.map((p) => p.pos));
  preview.points.push(s.pos);
  ctl.last = { snap: s, infer: inf, typed };
  const hintText = [hint, ...live].filter(Boolean).join(' · ') || null;
  return { snap: s, preview, hint: hintText };
}

function curvePolylineCircle(c: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= 96; i++) out.push(polar(c, r, (TAU * i) / 96));
  return out;
}

function refreshPreview() {
  const d = currentSketch();
  const raw = ctl.lastRaw;
  if (!d || !raw) return;
  const tool = ui().tool;
  if (tool === 'select' || tool === 'project') return;
  if (tool === 'dimension') {
    const hit = hitTest(raw, d);
    setHover(hit?.id ?? null);
    const pending = useDraw.getState().pending;
    const spec = pending.length ? dimSpec(pending, raw, d) : null;
    let preview: Preview | null = null;
    if (spec) {
      const value = measure(spec.type, spec.refs, d.entities) ?? 0;
      preview = { polys: [], guides: [], points: [], dim: { id: '__preview', type: spec.type, refs: spec.refs, value, label: raw } };
    }
    setDraw({
      preview,
      marker: null,
      hint: pending.length ? (spec ? 'Etiketi yerleştirmek için tıklayın' : 'İkinci öğeyi seçin') : 'Ölçülecek öğeyi seçin',
    });
    return;
  }
  const r = computeTarget(raw, d);
  setDraw({ preview: r.preview, marker: r.snap.hint ? r.snap.pos : null, hint: r.hint });
}

// ---------------------------------------------------------------- Çizim adımları

function commitStep() {
  const d = currentSketch();
  const last = ctl.last;
  if (!d || !last) return;
  const tool = ui().tool;
  const s = last.snap;
  const cons0 = ui().construction;

  if (tool === 'point') {
    if (s.pointId) {
      toast('Bu konumda zaten bir nokta var.');
      return;
    }
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    resolvePoint(s, d, ents, cons, true);
    applySketch((x) => addItems(x, ents, cons));
    return;
  }

  if (!ctl.pts.length) {
    ctl.pts = [s];
    if (tool === 'line') ctl.chainFirst = s.pointId ?? null;
    afterStep();
    return;
  }
  const s0 = ctl.pts[0];
  const typed = last.typed;

  if (tool === 'line') {
    if (dist(s0.pos, s.pos) < 1e-9 || (s0.pointId && s0.pointId === s.pointId)) {
      // aynı yere ikinci tık (çift tık) zinciri bitirir
      resetDraw();
      refreshPreview();
      return;
    }
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    const a = resolvePoint(s0, d, ents, cons);
    // Yeni noktalar için id çakışmasını önlemek amacıyla geçici taslak
    const d1 = addItems(d, ents);
    const b = resolvePoint(s, d1, ents, cons);
    const lid = newId('l', addItems(d, ents));
    ents.push({ id: lid, kind: 'line', p1: a, p2: b, ...(cons0 ? { construction: true } : {}) });
    if (last.infer === 'h') cons.push({ id: newId('k', d1), type: 'horizontal', refs: [lid] });
    if (last.infer === 'v') cons.push({ id: newId('k', d1), type: 'vertical', refs: [lid] });
    if (typed[0] > 0) cons.push({ id: newId('k', d1), type: 'distance', refs: [lid], value: typed[0] });
    if (!applySketch((x) => addItems(x, ents, cons))) return;
    const closed = !!ctl.chainFirst && b === ctl.chainFirst;
    if (!ctl.chainFirst) ctl.chainFirst = a;
    if (closed) {
      // zincirin ilk noktasına dönüldü: döngü kapandı
      resetDraw();
      refreshPreview();
      return;
    }
    const endPt = currentSketch()?.entities.find((e) => e.id === b);
    ctl.pts = [{ pos: endPt && endPt.kind === 'point' ? v2(endPt) : s.pos, pointId: b, hint: null }];
    afterStep();
    return;
  }

  if (tool === 'rect' || tool === 'rectCenter') {
    const c = s.pos;
    const center = tool === 'rectCenter';
    const aPos: Vec2 = center ? [2 * s0.pos[0] - c[0], 2 * s0.pos[1] - c[1]] : s0.pos;
    if (Math.abs(c[0] - aPos[0]) < 1e-6 || Math.abs(c[1] - aPos[1]) < 1e-6) return;
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    let tmp = d;
    const pid = (snap: Snap, standalone = false) => {
      const id = resolvePoint(snap, tmp, ents, cons, standalone);
      tmp = addItems(d, ents, cons);
      return id;
    };
    const A = center ? pid({ pos: aPos, hint: null }) : pid(s0);
    const B = pid({ pos: [c[0], aPos[1]], hint: null });
    const C = pid(center ? { pos: c, hint: null } : s);
    const D = pid({ pos: [aPos[0], c[1]], hint: null });
    const mk = (p1: string, p2: string) => {
      const id = newId('l', tmp);
      ents.push({ id, kind: 'line', p1, p2, ...(cons0 ? { construction: true } : {}) });
      tmp = addItems(d, ents, cons);
      return id;
    };
    const ab = mk(A, B);
    const bc = mk(B, C);
    const cd = mk(C, D);
    const da = mk(D, A);
    const k = (type: SkConstraintType, refs: string[], value?: number) => {
      cons.push({ id: newId('k', tmp), type, refs, ...(value !== undefined ? { value } : {}) });
      tmp = addItems(d, ents, cons);
    };
    k('horizontal', [ab]);
    k('horizontal', [cd]);
    k('vertical', [bc]);
    k('vertical', [da]);
    if (center) {
      const M = pid(s0, true);
      const diag = newId('l', tmp);
      ents.push({ id: diag, kind: 'line', p1: A, p2: C, construction: true });
      tmp = addItems(d, ents, cons);
      k('midpoint', [M, diag]);
    }
    if (typed[0] > 0) k('distance', [ab], typed[0]);
    if (typed[1] > 0) k('distance', [bc], typed[1]);
    if (applySketch((x) => addItems(x, ents, cons))) resetDraw();
    refreshPreview();
    return;
  }

  if (tool === 'circle') {
    const r = dist(s0.pos, s.pos);
    if (r < 1e-6) return;
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    const c = resolvePoint(s0, d, ents, cons);
    const tmp = addItems(d, ents, cons);
    const cid = newId('c', tmp);
    ents.push({ id: cid, kind: 'circle', c, r, ...(cons0 ? { construction: true } : {}) });
    if (s.pointId) cons.push({ id: newId('k', tmp), type: 'pointOnCircle', refs: [s.pointId, cid] });
    if (typed[0] > 0) cons.push({ id: newId('k', tmp), type: 'radius', refs: [cid], value: typed[0] });
    if (applySketch((x) => addItems(x, ents, cons))) resetDraw();
    refreshPreview();
    return;
  }

  if (tool === 'arc') {
    if (ctl.pts.length === 1) {
      if (dist(s0.pos, s.pos) < 1e-6) return;
      ctl.pts.push(s);
      ctl.sweep = 0;
      ctl.lastAng = Math.atan2(s.pos[1] - s0.pos[1], s.pos[0] - s0.pos[0]);
      afterStep();
      return;
    }
    const s1 = ctl.pts[1];
    const r = dist(s0.pos, s1.pos);
    if (Math.abs(ctl.sweep) < 1e-3) return;
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    let tmp = d;
    const pid = (snap: Snap) => {
      const id = resolvePoint(snap, tmp, ents, cons);
      tmp = addItems(d, ents, cons);
      return id;
    };
    const c = pid(s0);
    const st = pid(s1);
    const en = pid(s);
    if (st === en || c === st || c === en) return;
    const aid = newId('a', tmp);
    const ccw = ctl.sweep > 0;
    ents.push({ id: aid, kind: 'arc', c, start: ccw ? st : en, end: ccw ? en : st, r, ...(cons0 ? { construction: true } : {}) });
    if (applySketch((x) => addItems(x, ents, cons))) resetDraw();
    refreshPreview();
  }
}

function afterStep() {
  setDraw({ typed: null });
  refreshPreview();
}

/** Klavyeden girilen değeri onaylar (Enter) */
export function commitTyped() {
  if (!ctl.lastRaw) return;
  refreshPreview();
  commitStep();
  setDraw({ typed: null });
  refreshPreview();
}

export function setTyped(t: TypedInput | null) {
  setDraw({ typed: t });
  refreshPreview();
}

function typedKindFor(tool: SketchTool): TypedKind | null {
  if (tool === 'line') return 'line';
  if (tool === 'circle') return 'circle';
  if (tool === 'rect' || tool === 'rectCenter') return 'rect';
  return null;
}

// ---------------------------------------------------------------- Ölçü aracı

function dimSpec(refs: string[], label: Vec2, d: SketchFeature): { type: SkConstraintType; refs: string[] } | null {
  const ents = refs.map((id) => d.entities.find((e) => e.id === id)).filter((e): e is SkEntity => !!e);
  if (ents.length !== refs.length) return null;
  const pm = pointMap(d.entities);
  if (ents.length === 1) {
    const e = ents[0];
    if (e.kind === 'line') return { type: 'distance', refs: [e.id] };
    if (e.kind === 'circle') return { type: 'diameter', refs: [e.id] };
    if (e.kind === 'arc') return { type: 'radius', refs: [e.id] };
    // Tek nokta: orijine yatay/dikey mesafe
    return Math.abs(label[1] - e.y) > Math.abs(label[0] - e.x)
      ? { type: 'distanceX', refs: [e.id] }
      : { type: 'distanceY', refs: [e.id] };
  }
  if (ents.length !== 2) return null;
  const [a, b] = ents;
  if (a.kind === 'point' && b.kind === 'point') {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const inX = label[0] >= minX && label[0] <= maxX;
    const inY = label[1] >= minY && label[1] <= maxY;
    if (inX && !inY && maxX - minX > 1e-9) return { type: 'distanceX', refs: [a.id, b.id] };
    if (inY && !inX && maxY - minY > 1e-9) return { type: 'distanceY', refs: [a.id, b.id] };
    return { type: 'distance', refs: [a.id, b.id] };
  }
  if (a.kind === 'point' && b.kind === 'line') return { type: 'distance', refs: [a.id, b.id] };
  if (a.kind === 'line' && b.kind === 'point') return { type: 'distance', refs: [b.id, a.id] };
  if (a.kind === 'line' && b.kind === 'line') {
    const la = linePts(a, pm);
    const lb = linePts(b, pm);
    if (!la || !lb) return null;
    if (!intersectLines(la[0], la[1], lb[0], lb[1])) return { type: 'distance', refs: [b.p1, a.id] };
    return { type: 'angle', refs: [a.id, b.id] };
  }
  return null;
}

function dimClick(raw: Vec2) {
  const d = currentSketch();
  if (!d) return;
  const hit = hitTest(raw, d);
  const pending = useDraw.getState().pending;
  if (hit) {
    if (pending.includes(hit.id)) return;
    const next = pending.length === 1 ? [...pending, hit.id] : [hit.id];
    const ok = dimSpec(next, raw, d);
    setDraw({ pending: ok ? next : [hit.id] });
    refreshPreview();
    return;
  }
  if (!pending.length) return;
  const spec = dimSpec(pending, raw, d);
  if (!spec) return;
  const id = addConstraint(spec.type, spec.refs, undefined, raw);
  setDraw({ pending: [], preview: null });
  if (id) useSketchUi.setState({ editing: id, sel: [id] });
  refreshPreview();
}

// ---------------------------------------------------------------- Seçim aracı

function selectDown(e: PointerEvent, raw: Vec2) {
  const d = currentSketch();
  if (!d) return;
  const hit = hitTest(raw, d);
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  const client = { x: e.clientX, y: e.clientY };
  if (!hit) {
    ctl.boxStart = { ...clientToOverlay(e.clientX, e.clientY), additive };
    return;
  }
  const sel = ui().sel;
  if (additive) {
    toggleSelected(hit.id);
    return;
  }
  let selNow = sel;
  if (!sel.includes(hit.id)) {
    selNow = [hit.id];
    setSelection(selNow);
  }
  // Projeksiyon geometrisi kaynağa bağlıdır: sürüklenmez
  if (d.entities.find((x) => x.id === hit.id)?.ext) return;
  // Sürükleme adayı
  const pm = pointMap(d.entities);
  const orig = new Map<string, Vec2>();
  let kind: DragState['kind'] = 'move';
  if (hit.kind === 'point') {
    kind = 'point';
    const p = pm.get(hit.id)!;
    orig.set(p.id, v2(p));
  } else {
    const ent = d.entities.find((x) => x.id === hit.id)!;
    const onlyThis = selNow.length === 1 && selNow[0] === hit.id;
    if (onlyThis && (ent.kind === 'circle' || ent.kind === 'arc')) kind = 'radius';
    for (const id of selNow) {
      const x = d.entities.find((y) => y.id === id);
      if (!x) continue;
      const ids = x.kind === 'point' ? [x.id] : curvePointIds(x);
      for (const pid of ids) {
        const p = pm.get(pid);
        if (p) orig.set(pid, v2(p));
      }
    }
  }
  ctl.drag = { kind, id: hit.id, startRaw: raw, startClient: client, started: false, orig };
}

function setPoints(d: SketchFeature, pos: Map<string, Vec2>): SketchFeature {
  return {
    ...d,
    entities: d.entities.map((e) => {
      if (e.kind !== 'point') return e;
      const p = pos.get(e.id);
      return p ? { ...e, x: p[0], y: p[1] } : e;
    }),
  };
}

function dragMove(e: PointerEvent, raw: Vec2) {
  const g = ctl.drag;
  if (!g) return;
  if (!g.started) {
    if (Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) < 3) return;
    g.started = true;
    beginGesture();
  }
  const delta = sub(raw, g.startRaw);
  if (g.kind === 'point') {
    applySketch((d) => setPoints(d, new Map([[g.id, raw]])), {
      history: false,
      silent: true,
      drag: { pointId: g.id, x: raw[0], y: raw[1] },
    });
    return;
  }
  if (g.kind === 'radius') {
    applySketch(
      (d) => {
        const ent = d.entities.find((x) => x.id === g.id);
        if (!ent || (ent.kind !== 'circle' && ent.kind !== 'arc')) return d;
        const pm = pointMap(d.entities);
        const c = pm.get(ent.c);
        if (!c) return d;
        const r = Math.max(dist(v2(c), raw), 1e-6);
        let out: SketchFeature = { ...d, entities: d.entities.map((x) => (x.id === ent.id ? { ...ent, r } : x)) };
        if (ent.kind === 'arc') {
          const a = arcAngles(ent, pm);
          if (a) {
            out = setPoints(
              out,
              new Map([
                [ent.start, polar(a.c, r, a.a0)],
                [ent.end, polar(a.c, r, a.a0 + a.sweep)],
              ]),
            );
          }
        }
        return out;
      },
      { history: false, silent: true },
    );
    return;
  }
  // Seçimi taşı
  const pos = new Map<string, Vec2>();
  for (const [id, p] of g.orig) pos.set(id, add(p, delta));
  const first = [...pos.entries()][0];
  applySketch((d) => setPoints(d, pos), {
    history: false,
    silent: true,
    drag: first ? { pointId: first[0], x: first[1][0], y: first[1][1] } : undefined,
  });
}

function boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
  const d = currentSketch();
  if (!d) return;
  const window = x1 >= x0;
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const inside = (p: Vec2) => {
    const s = sketchToOverlay(p);
    return !!s && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
  };
  const pm = pointMap(d.entities);
  const out: string[] = [];
  for (const e of d.entities) {
    if (e.kind === 'point') {
      if (e.standalone && inside(v2(e))) out.push(e.id);
      continue;
    }
    let pts = curvePolyline(e, pm);
    if (e.kind === 'line' && pts.length === 2) {
      const [a, b] = pts;
      pts = Array.from({ length: 9 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8] as Vec2);
    }
    const hit = window ? pts.length > 0 && pts.every(inside) : pts.some(inside);
    if (hit) out.push(e.id);
  }
  const prev = additive ? ui().sel : [];
  setSelection([...new Set([...prev, ...out])]);
}

// ---------------------------------------------------------------- DOM olayları (SketchLayer bağlar)

export function onPointerDown(e: PointerEvent) {
  if (e.button === 2) {
    ctl.rightDown = { x: e.clientX, y: e.clientY };
    return;
  }
  if (e.button !== 0) return;
  // Açık giriş alanı varsa değerini işlesin (blur); varsayılan odak değişimi engellenir ki
  // bu tıkla açılan ölçü kutusu hemen kapanmasın
  const ae = document.activeElement;
  if (ae instanceof HTMLElement && ae !== document.body && !ae.closest('.sk-typed')) ae.blur();
  e.preventDefault();
  const raw = clientToSketch(e.clientX, e.clientY);
  if (!raw) return;
  ctl.lastRaw = raw;
  const tool = ui().tool;
  if (tool === 'select') {
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    selectDown(e, raw);
    return;
  }
  if (tool === 'dimension') {
    dimClick(raw);
    return;
  }
  if (tool === 'project') {
    const src = pickProjectionSource(e.clientX, e.clientY);
    if (src) addProjection(src);
    else toast('Burada bir parça yüzü ya da kenarı yok.');
    return;
  }
  refreshPreview();
  commitStep();
}

export function onPointerMove(e: PointerEvent) {
  const raw = clientToSketch(e.clientX, e.clientY);
  ctl.lastClient = { x: e.clientX, y: e.clientY };
  const cursor = clientToOverlay(e.clientX, e.clientY);
  if (!raw) return;
  ctl.lastRaw = raw;
  const tool = ui().tool;
  if (tool === 'select') {
    if (ctl.drag) {
      dragMove(e, raw);
      setDraw({ cursor });
      return;
    }
    if (ctl.boxStart) {
      const b = ctl.boxStart;
      if (Math.hypot(cursor.x - b.x, cursor.y - b.y) > 3) setDraw({ box: { x0: b.x, y0: b.y, x1: cursor.x, y1: cursor.y } });
      return;
    }
    if (e.buttons) return;
    const d = currentSketch();
    if (d) setHover(hitTest(raw, d)?.id ?? null);
    if (useDraw.getState().cursor) setDraw({ cursor: null, hint: null });
    return;
  }
  if (tool === 'project') {
    setDraw({ cursor, hint: 'Aktarmak için bir yüze ya da kenara tıklayın', preview: null, marker: null });
    return;
  }
  setDraw({ cursor });
  refreshPreview();
}

export function onPointerUp(e: PointerEvent) {
  if (e.button === 2) {
    const r = ctl.rightDown;
    ctl.rightDown = null;
    if (r && Math.hypot(e.clientX - r.x, e.clientY - r.y) < 4 && isDrawing()) {
      resetDraw();
      refreshPreview();
    }
    return;
  }
  if (e.button !== 0) return;
  (e.target as Element | null)?.releasePointerCapture?.(e.pointerId);
  const g = ctl.drag;
  if (g) {
    ctl.drag = null;
    if (g.started) endGesture();
    return;
  }
  const b = ctl.boxStart;
  if (b) {
    ctl.boxStart = null;
    const box = useDraw.getState().box;
    setDraw({ box: null });
    if (box) boxSelect(box.x0, box.y0, box.x1, box.y1, b.additive);
    else if (!b.additive) setSelection([]);
  }
}

export function onPointerLeave() {
  if (!ctl.drag && !ctl.boxStart) {
    setDraw({ cursor: null, marker: null, hint: null, preview: ctl.pts.length ? useDraw.getState().preview : null });
    setHover(null);
  }
}

// ---------------------------------------------------------------- Klavye

const NON_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'range', 'file']);
function editable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && !NON_TEXT.has(t.type);
}

const TOOL_KEYS: Record<string, SketchTool> = {
  s: 'select',
  l: 'line',
  r: 'rect',
  c: 'circle',
  a: 'arc',
  p: 'point',
  d: 'dimension',
  j: 'project',
};

/** Esc davranışı: çizim → araç → seçim */
export function escape() {
  if (useDraw.getState().typed) {
    setDraw({ typed: null });
    refreshPreview();
    return;
  }
  if (useSketchUi.getState().editing) {
    useSketchUi.setState({ editing: null });
    return;
  }
  if (isDrawing()) {
    resetDraw();
    refreshPreview();
    return;
  }
  if (ui().tool !== 'select') {
    chooseTool('select');
    return;
  }
  if (ui().sel.length) setSelection([]);
}

/** X: seçili eğrileri yardımcı yap; seçim yoksa yeni geometri için yardımcı kipini aç/kapa */
export function constructionKey() {
  if (toggleConstruction(ui().sel)) return;
  const on = !ui().construction;
  useSketchUi.setState({ construction: on });
  toast(on ? 'Yardımcı çizim kipi açık' : 'Yardımcı çizim kipi kapalı');
}

export function onKeyDown(e: KeyboardEvent) {
  if (!useAssembly.getState().modeling.sketch) return;
  if (e.defaultPrevented || e.isComposing) return;
  if (editable(e.target) || editable(document.activeElement)) return;
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.altKey) return;
    const is = (l: string) => key === l || e.code === `Key${l.toUpperCase()}`;
    if (is('z')) {
      e.preventDefault();
      resetDraw();
      if (e.shiftKey) redoSketch();
      else undoSketch();
    } else if (is('y')) {
      e.preventDefault();
      resetDraw();
      redoSketch();
    } else if (is('a')) {
      e.preventDefault();
      const d = currentSketch();
      if (d) setSelection(d.entities.filter((x) => x.kind !== 'point' || x.standalone).map((x) => x.id));
    }
    return;
  }
  if (e.altKey) return;

  // Çizerken sayı yazmak ölçü giriş kutusunu açar
  const tool = ui().tool;
  const tk = typedKindFor(tool);
  if (tk && ctl.pts.length && /^[0-9.,]$/.test(e.key)) {
    e.preventDefault();
    const values = tk === 'rect' ? [e.key, ''] : [e.key];
    setTyped({ kind: tk, values, active: 0 });
    return;
  }

  switch (key) {
    case 'escape':
      e.preventDefault();
      escape();
      return;
    case 'enter':
      e.preventDefault();
      if (isDrawing()) {
        resetDraw();
        refreshPreview();
      } else finishSketch();
      return;
    case 'delete':
    case 'backspace':
      e.preventDefault();
      deleteSelection();
      return;
    case 'x':
      e.preventDefault();
      constructionKey();
      return;
    default:
      break;
  }
  if (key === 'r' && e.shiftKey) {
    e.preventDefault();
    chooseTool('rectCenter');
    return;
  }
  const t = TOOL_KEYS[key];
  if (t && !e.shiftKey) {
    e.preventDefault();
    chooseTool(t);
  }
}

/** Sketch'i iptal eder */
export function cancelAll() {
  resetController();
  cancelSketch();
}
