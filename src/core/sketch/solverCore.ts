// Sketch kısıt çözücü çekirdeği (planegcs / FreeCAD GCS).
// Bu dosya yalnız `import type` ile proje tiplerini kullanır; böylece Node'da
// (`node --experimental-strip-types`) doğrudan test edilebilir. Vite'a özel wasm `?url`
// importu ../solver.ts içindedir; o, bu dosyadaki initWithPath'i çağırır.
import { init_planegcs_module } from '@salusoft89/planegcs';
import type { GcsSystem } from '@salusoft89/planegcs';
import type { SkArc, SkCircle, SkConstraint, SkConstraintType, SkEntity, SkLine, SkPoint } from '@/core/types';

export interface SketchSolveResult {
  /** Çözülmüş varlıklar (nokta konumları, yarıçaplar güncel). Çözülemezse giriş aynen döner. */
  entities: SkEntity[];
  /** ok: çözüldü · failed: çözülemedi */
  status: 'ok' | 'failed';
  /** Kalan serbestlik derecesi (0 = tam tanımlı) */
  dof: number;
  /** Çelişen kısıt id'leri */
  conflicting: string[];
  /** Gereksiz (fazla) kısıt id'leri */
  redundant: string[];
}

export interface SolveOptions {
  drag?: { pointId: string; x: number; y: number };
}

// ---------------------------------------------------------------- wasm yükleme

/** embind nesnelerinin ortak yüzü (wasm belleği elle serbest bırakılır) */
interface Deletable {
  delete(): void;
}

let gcs: GcsSystem | null = null;
let initPromise: Promise<void> | null = null;

/**
 * planegcs wasm'ını verilen yoldan/URL'den yükler. Bir kez yükler (promise önbelleği);
 * başarısız olursa önbellek temizlenir, tekrar denenebilir.
 */
export function initWithPath(wasmPath: string): Promise<void> {
  if (gcs) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init = init_planegcs_module as unknown as (cfg: { locateFile: () => string }) => Promise<any>;
      const mod = await init({ locateFile: () => wasmPath });
      const sys = new mod.GcsSystem() as GcsSystem;
      sys.set_debug_mode(0); // konsola "RedundantSolving" vb. yazmasın
      gcs = sys;
    })().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

export function isReady(): boolean {
  return gcs !== null;
}

// ---------------------------------------------------------------- yardımcılar

const SolveStatus = { Success: 0, Converged: 1, Failed: 2, SuccessfulSolutionInvalid: 3 } as const;
const Algorithm = { BFGS: 0, LevenbergMarquardt: 1, DogLeg: 2 } as const;
const DEG = Math.PI / 180;
const TEMP_TAG = -1; // planegcs: negatif etiket = geçici (zayıf) kısıt, DOF'u azaltmaz
const INTERNAL_TAG = 0; // iç kısıtlar (arc_rules): raporlanmaz

type Curve = SkLine | SkCircle | SkArc;
const isCircular = (e: SkEntity | undefined): e is SkCircle | SkArc => !!e && (e.kind === 'circle' || e.kind === 'arc');

/** a'dan b'ye yönlü açı (−π, π] */
function dirAngle(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}
/** a'yı b'ye en yakın 2π eşdeğerine taşır */
function wrapNear(a: number, b: number): number {
  return a + 2 * Math.PI * Math.round((b - a) / (2 * Math.PI));
}
/** Ölçü değerini mevcut yönün işaretiyle uygular (negatif değer açıkça işaretli kabul edilir) */
function signedLike(value: number, current: number): number {
  if (value < 0) return value;
  return current < -1e-12 ? -value : value;
}

class EntityIndex {
  readonly byId = new Map<string, SkEntity>();
  constructor(entities: SkEntity[]) {
    for (const e of entities) this.byId.set(e.id, e);
  }
  point(id: string | undefined): SkPoint | undefined {
    const e = id === undefined ? undefined : this.byId.get(id);
    return e && e.kind === 'point' ? e : undefined;
  }
  get(id: string | undefined): SkEntity | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }
  /** Bir eğrinin tanımlayıcı noktaları geçerli mi */
  curveOk(e: SkEntity): boolean {
    if (e.kind === 'line') return !!this.point(e.p1) && !!this.point(e.p2) && e.p1 !== e.p2;
    if (e.kind === 'circle') return !!this.point(e.c);
    if (e.kind === 'arc') return !!this.point(e.c) && !!this.point(e.start) && !!this.point(e.end);
    return true;
  }
}

// ---------------------------------------------------------------- çözüm sonucu önbelleği

let lastCall: {
  entities: SkEntity[];
  constraints: SkConstraint[];
  result: SketchSolveResult;
} | null = null;

// ---------------------------------------------------------------- solveSketch

export function solve(entities: SkEntity[], constraints: SkConstraint[], opts?: SolveOptions): SketchSolveResult {
  if (!gcs) return { entities, status: 'failed', dof: -1, conflicting: [], redundant: [] };
  const drag = opts?.drag;
  if (!drag && lastCall && lastCall.entities === entities && lastCall.constraints === constraints) {
    return lastCall.result;
  }
  let result = solveOnce(entities, constraints, drag);
  if (result.status === 'failed' && !drag && result.conflicting.length === 0 && constraints.length > 0) {
    // planegcs çelişkiyi yalnız başlangıç geometrisindeki Jacobian rankından bulur; geometri
    // çözüme uzaksa (ör. hafif eğik çizgiye yatay + dikey + 30° açı) rapor boş kalabilir.
    // Bu durumda tek tek kısıt çıkarıp çözülebilirliği deneriz: çıkarılınca çözülen kısıtlar çelişiktir.
    const conflicting: string[] = [];
    const t0 = now();
    for (let i = constraints.length - 1; i >= 0; i--) {
      if (now() - t0 > CONFLICT_SEARCH_BUDGET_MS) break;
      const rest = constraints.slice(0, i).concat(constraints.slice(i + 1));
      if (solveOnce(entities, rest, undefined).status === 'ok') conflicting.push(constraints[i].id);
    }
    conflicting.reverse();
    result = { ...result, conflicting };
  }
  if (!drag) lastCall = { entities, constraints, result };
  return result;
}

const CONFLICT_SEARCH_BUDGET_MS = 120;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function solveOnce(entities: SkEntity[], constraints: SkConstraint[], drag: SolveOptions['drag']): SketchSolveResult {
  const fail = (conflicting: string[] = [], redundant: string[] = [], dof = -1): SketchSolveResult => ({
    entities,
    status: 'failed',
    dof,
    conflicting,
    redundant,
  });
  const g = gcs;
  if (!g) return fail();

  const idx = new EntityIndex(entities);
  const owned: Deletable[] = [];
  try {
    g.clear_data();

    // --- parametreler: noktalar (x,y), daire (r), yay (başlangıç açısı, bitiş açısı, r)
    const pointParam = new Map<string, number>(); // nokta id → x parametre indeksi
    const pointObj = new Map<string, Deletable>();
    const curveParam = new Map<string, number>(); // daire: r · yay: sa, ea, r
    const curveObj = new Map<string, Deletable>();

    const pushParam = (v: number, fixed: boolean): number => {
      const i = g.params_size();
      g.push_p_param(v, fixed);
      return i;
    };
    /** Sabit değer parametresi (ölçü değeri) */
    const constParam = (v: number) => pushParam(v, true);

    for (const e of entities) {
      if (e.kind !== 'point') continue;
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) return fail();
      // Projeksiyonla gelen (dış referans) noktalar sabittir
      const fx = !!e.ext;
      const i = pushParam(e.x, fx);
      pushParam(e.y, fx);
      pointParam.set(e.id, i);
    }
    const P = (id: string): Deletable => {
      let o = pointObj.get(id);
      if (!o) {
        const i = pointParam.get(id)!;
        o = g.make_point(i, i + 1) as Deletable;
        owned.push(o);
        pointObj.set(id, o);
      }
      return o;
    };
    const px = (id: string) => g.get_p_param(pointParam.get(id)!);
    const py = (id: string) => g.get_p_param(pointParam.get(id)! + 1);

    for (const e of entities) {
      if (e.kind === 'point' || !idx.curveOk(e)) continue;
      if (e.kind === 'circle') {
        curveParam.set(e.id, pushParam(Math.abs(e.r) || 1e-6, !!e.ext));
      } else if (e.kind === 'arc') {
        const c = idx.point(e.c)!, s = idx.point(e.start)!, en = idx.point(e.end)!;
        const sa = Math.atan2(s.y - c.y, s.x - c.x);
        let ea = Math.atan2(en.y - c.y, en.x - c.x);
        while (ea <= sa) ea += 2 * Math.PI; // ccw start→end
        const r = Math.abs(e.r) || Math.hypot(s.x - c.x, s.y - c.y) || 1e-6;
        const fx = !!e.ext;
        const i = pushParam(sa, fx);
        pushParam(ea, fx);
        pushParam(r, fx);
        curveParam.set(e.id, i);
      }
    }
    /** planegcs eğri nesnesi (Line/Circle/Arc) */
    const C = (e: Curve): Deletable => {
      let o = curveObj.get(e.id);
      if (o) return o;
      if (e.kind === 'line') {
        const a = pointParam.get(e.p1)!, b = pointParam.get(e.p2)!;
        o = g.make_line(a, a + 1, b, b + 1) as Deletable;
      } else if (e.kind === 'circle') {
        const c = pointParam.get(e.c)!;
        o = g.make_circle(c, c + 1, curveParam.get(e.id)!) as Deletable;
      } else {
        const c = pointParam.get(e.c)!, s = pointParam.get(e.start)!, en = pointParam.get(e.end)!;
        const a = curveParam.get(e.id)!;
        o = g.make_arc(c, c + 1, s, s + 1, en, en + 1, a, a + 1, a + 2) as Deletable;
      }
      owned.push(o);
      curveObj.set(e.id, o);
      return o;
    };

    // Yay iç kuralları: uç noktaları merkez + r·(cos, sin)(açı) üzerinde tutar
    for (const e of entities) {
      if (e.kind === 'arc' && !e.ext && curveParam.has(e.id)) g.add_constraint_arc_rules(C(e) as never, INTERNAL_TAG, true, 1);
    }

    // --- çakışıklık birleşimi (uç noktası paylaşan teğetlik tespiti için)
    const parent = new Map<string, string>();
    const find = (a: string): string => {
      let r = a;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    for (const k of constraints) {
      if (k.type === 'coincident' && k.refs.length === 2 && idx.point(k.refs[0]) && idx.point(k.refs[1])) {
        const a = find(k.refs[0]), b = find(k.refs[1]);
        if (a !== b) parent.set(a, b);
      }
    }
    const endpoints = (e: Curve): string[] =>
      e.kind === 'line' ? [e.p1, e.p2] : e.kind === 'arc' ? [e.start, e.end] : [];

    // --- kısıtlar: etiket = dizideki sıra + 1 → id'ye geri eşlenir
    const tagToId = new Map<number, string>();
    // planegcs bağlamaları geometri tiplerini ayırt etmez (embind); `never` ile tip denetimini geçiyoruz
    const N = (o: Deletable) => o as never;

    constraints.forEach((k, ci) => {
      const tag = ci + 1;
      tagToId.set(tag, k.id);
      const ents = k.refs.map((r) => idx.get(r));
      if (ents.some((e) => !e || (e.kind !== 'point' && !curveParam.has(e.id) && e.kind !== 'line'))) return;
      if (ents.some((e) => e && e.kind === 'line' && !idx.curveOk(e))) return;
      const v = k.value;
      const hasV = typeof v === 'number' && Number.isFinite(v);
      const kinds = ents.map((e) => e!.kind).join(',');
      const add = (fn: keyof GcsSystem, ...args: unknown[]) => {
        (g[fn] as unknown as (...a: unknown[]) => void)(...args, tag, true, 1);
      };

      switch (k.type) {
        case 'coincident': {
          if (kinds !== 'point,point' || k.refs[0] === k.refs[1]) return;
          add('add_constraint_p2p_coincident', P(k.refs[0]), P(k.refs[1]));
          return;
        }
        case 'horizontal':
        case 'vertical': {
          const h = k.type === 'horizontal';
          if (kinds === 'line') add(h ? 'add_constraint_horizontal_l' : 'add_constraint_vertical_l', C(ents[0] as SkLine));
          else if (kinds === 'point,point' && k.refs[0] !== k.refs[1])
            add(h ? 'add_constraint_horizontal_pp' : 'add_constraint_vertical_pp', P(k.refs[0]), P(k.refs[1]));
          return;
        }
        case 'parallel':
        case 'perpendicular': {
          if (kinds !== 'line,line' || k.refs[0] === k.refs[1]) return;
          add(k.type === 'parallel' ? 'add_constraint_parallel' : 'add_constraint_perpendicular_ll', C(ents[0] as SkLine), C(ents[1] as SkLine));
          return;
        }
        case 'equal': {
          const [a, b] = ents;
          if (k.refs[0] === k.refs[1]) return;
          if (kinds === 'line,line') add('add_constraint_equal_length', C(a as SkLine), C(b as SkLine));
          else if (kinds === 'circle,circle') add('add_constraint_equal_radius_cc', C(a as SkCircle), C(b as SkCircle));
          else if (kinds === 'arc,arc') add('add_constraint_equal_radius_aa', C(a as SkArc), C(b as SkArc));
          else if (kinds === 'circle,arc') add('add_constraint_equal_radius_ca', C(a as SkCircle), C(b as SkArc));
          else if (kinds === 'arc,circle') add('add_constraint_equal_radius_ca', C(b as SkCircle), C(a as SkArc));
          return;
        }
        case 'tangent': {
          if (ents.length !== 2 || k.refs[0] === k.refs[1]) return;
          if (ents.some((e) => e!.kind === 'point') || kinds === 'line,line') return;
          let [a, b] = ents as Curve[];
          if (b.kind === 'line') [a, b] = [b, a]; // çizgi her zaman önde
          // Uç noktası paylaşan (aynı id ya da çakışık) çizgi/yay–yay: uç noktada yön sürekliliği
          let shared: string | null = null;
          for (const pa of endpoints(a)) for (const pb of endpoints(b)) if (!shared && (pa === pb || find(pa) === find(pb))) shared = pa;
          if (shared && b.kind === 'arc') {
            // planegcs angle_via_point: iki eğrinin p'deki normalleri arası açı. Teğetlik = 0 ya da π;
            // mevcut geometriye en yakın olanı seçilir (normal yön kuralından bağımsız).
            const n1 = curveNormalAt(a, shared, idx);
            const n2 = curveNormalAt(b, shared, idx);
            const cur = n1 && n2 ? dirAngle(n1[0], n1[1], n2[0], n2[1]) : 0;
            const target = Math.abs(cur) <= Math.PI / 2 ? 0 : wrapNear(Math.PI, cur);
            add('add_constraint_angle_via_point', C(a), C(b), P(shared), constParam(target));
            return;
          }
          if (a.kind === 'line') {
            add(b.kind === 'circle' ? 'add_constraint_tangent_lc' : 'add_constraint_tangent_la', C(a), C(b));
          } else if (a.kind === 'circle' && b.kind === 'circle') add('add_constraint_tangent_cc', C(a), C(b));
          else if (a.kind === 'arc' && b.kind === 'arc') add('add_constraint_tangent_aa', C(a), C(b));
          else if (a.kind === 'circle' && b.kind === 'arc') add('add_constraint_tangent_ca', C(a), C(b));
          else if (a.kind === 'arc' && b.kind === 'circle') add('add_constraint_tangent_ca', C(b), C(a));
          return;
        }
        case 'fix': {
          if (kinds !== 'point') return;
          const id = k.refs[0];
          const p = idx.point(id)!;
          add('add_constraint_coordinate_x', P(id), constParam(p.x));
          add('add_constraint_coordinate_y', P(id), constParam(p.y));
          return;
        }
        case 'pointOnLine': {
          const [pId, lId] = kinds === 'point,line' ? k.refs : kinds === 'line,point' ? [k.refs[1], k.refs[0]] : [];
          if (!pId) return;
          const l = idx.get(lId) as SkLine;
          if (l.p1 === pId || l.p2 === pId) return;
          add('add_constraint_point_on_line_pl', P(pId), C(l));
          return;
        }
        case 'pointOnCircle': {
          let pId: string | undefined, cId: string | undefined;
          if (ents[0]?.kind === 'point' && isCircular(ents[1])) [pId, cId] = k.refs;
          else if (ents[1]?.kind === 'point' && isCircular(ents[0])) [cId, pId] = k.refs;
          if (!pId || !cId) return;
          const c = idx.get(cId) as SkCircle | SkArc;
          if (c.kind === 'arc' && (c.start === pId || c.end === pId)) return; // zaten üzerinde
          if (c.c === pId) return;
          add(c.kind === 'circle' ? 'add_constraint_point_on_circle' : 'add_constraint_point_on_arc', P(pId), C(c));
          return;
        }
        case 'midpoint': {
          const [pId, lId] = kinds === 'point,line' ? k.refs : kinds === 'line,point' ? [k.refs[1], k.refs[0]] : [];
          if (!pId) return;
          const l = idx.get(lId) as SkLine;
          if (l.p1 === pId || l.p2 === pId) return;
          // p, p1–p2'nin orta noktası (planegcs simetri: doğru üzerinde + dik açıortay üzerinde)
          add('add_constraint_p2p_symmetric_ppp', P(l.p1), P(l.p2), P(pId));
          return;
        }
        case 'concentric': {
          if (!isCircular(ents[0]) || !isCircular(ents[1]) || k.refs[0] === k.refs[1]) return;
          const a = ents[0].c, b = ents[1].c;
          if (a === b) return;
          add('add_constraint_p2p_coincident', P(a), P(b));
          return;
        }
        case 'distance': {
          if (!hasV) return;
          const d = Math.abs(v!);
          if (kinds === 'point,point') {
            if (k.refs[0] === k.refs[1]) return;
            add('add_constraint_p2p_distance', P(k.refs[0]), P(k.refs[1]), constParam(d));
          } else if (kinds === 'line') {
            const l = ents[0] as SkLine;
            add('add_constraint_p2p_distance', P(l.p1), P(l.p2), constParam(d));
          } else if (kinds === 'point,line' || kinds === 'line,point') {
            const [pId, lId] = kinds === 'point,line' ? k.refs : [k.refs[1], k.refs[0]];
            add('add_constraint_p2l_distance', P(pId), C(idx.get(lId) as SkLine), constParam(d));
          } else if (kinds === 'point,circle' || kinds === 'point,arc' || kinds === 'circle,point' || kinds === 'arc,point') {
            // ek: nokta–çember mesafesi (çember çizgisine)
            const [pId, cId] = ents[0]!.kind === 'point' ? k.refs : [k.refs[1], k.refs[0]];
            add('add_constraint_p2cdistance', P(pId), C(idx.get(cId) as SkCircle), constParam(d));
          }
          return;
        }
        case 'distanceX':
        case 'distanceY': {
          if (!hasV) return;
          const isX = k.type === 'distanceX';
          const off = isX ? 0 : 1;
          if (kinds === 'point') {
            const id = k.refs[0];
            const cur = isX ? idx.point(id)!.x : idx.point(id)!.y;
            add(isX ? 'add_constraint_coordinate_x' : 'add_constraint_coordinate_y', P(id), constParam(signedLike(v!, cur)));
          } else if (kinds === 'point,point' && k.refs[0] !== k.refs[1]) {
            const a = idx.point(k.refs[0])!, b = idx.point(k.refs[1])!;
            const cur = isX ? b.x - a.x : b.y - a.y;
            // difference: param2 − param1 = fark
            add(
              'add_constraint_difference',
              pointParam.get(a.id)! + off,
              pointParam.get(b.id)! + off,
              constParam(signedLike(v!, cur)),
            );
          }
          return;
        }
        case 'radius':
        case 'diameter': {
          if (!hasV || !isCircular(ents[0]) || ents.length !== 1) return;
          const c = ents[0];
          const val = constParam(Math.abs(v!));
          const r = k.type === 'radius';
          if (c.kind === 'circle') add(r ? 'add_constraint_circle_radius' : 'add_constraint_circle_diameter', C(c), val);
          else add(r ? 'add_constraint_arc_radius' : 'add_constraint_arc_diameter', C(c), val);
          return;
        }
        case 'angle': {
          if (!hasV || kinds !== 'line,line' || k.refs[0] === k.refs[1]) return;
          const l1 = ents[0] as SkLine, l2 = ents[1] as SkLine;
          const cur = lineDirAngle(l1, l2, idx);
          const t = Math.abs(v!) * DEG;
          // Çizgiler arası açı t: yönlü açı t, −t, π−t ya da t−π olabilir; mevcuda en yakını seçilir
          let best = t, bestD = Infinity;
          for (const c of [t, -t, Math.PI - t, t - Math.PI]) {
            const w = wrapNear(c, cur);
            const dd = Math.abs(w - cur);
            if (dd < bestD - 1e-12) {
              bestD = dd;
              best = w;
            }
          }
          add('add_constraint_l2l_angle_ll', C(l1), C(l2), constParam(best));
          return;
        }
        default:
          return;
      }
    });

    // --- sürükleme: hedefe geçici (zayıf) çakışıklık kısıtı
    if (drag && pointParam.has(drag.pointId) && Number.isFinite(drag.x) && Number.isFinite(drag.y)) {
      const t = constParam(drag.x);
      constParam(drag.y);
      const target = g.make_point(t, t + 1) as Deletable;
      owned.push(target);
      g.add_constraint_p2p_coincident(N(P(drag.pointId)), N(target), TEMP_TAG, true, 1);
    }

    // --- çöz
    let ret: number = g.solve_system(Algorithm.DogLeg);
    const readTags = (vec: { size(): number; get(i: number): number; delete(): void }): string[] => {
      const out: string[] = [];
      for (let i = 0; i < vec.size(); i++) {
        const id = tagToId.get(vec.get(i));
        if (id !== undefined && !out.includes(id)) out.push(id);
      }
      vec.delete();
      return out;
    };
    let conflicting = g.has_conflicting() ? readTags(g.get_conflicting()) : [];
    if (ret === SolveStatus.Failed && conflicting.length === 0 && !drag) {
      // DogLeg takıldıysa Levenberg–Marquardt ile bir kez daha dene
      ret = g.solve_system(Algorithm.LevenbergMarquardt);
      conflicting = g.has_conflicting() ? readTags(g.get_conflicting()) : [];
    }
    const redundant = g.has_redundant() ? readTags(g.get_redundant()) : [];
    const dof = g.dof();

    if ((ret !== SolveStatus.Success && ret !== SolveStatus.Converged) || conflicting.length > 0) {
      return fail(conflicting, redundant, dof);
    }
    g.apply_solution();

    // --- sonucu geri yaz
    const out: SkEntity[] = new Array(entities.length);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (e.kind === 'point') {
        const x = px(e.id), y = py(e.id);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fail([], redundant, dof);
        out[i] = x === e.x && y === e.y ? e : { ...e, x, y };
      } else if ((e.kind === 'circle' || e.kind === 'arc') && curveParam.has(e.id)) {
        const r = Math.abs(g.get_p_param(curveParam.get(e.id)! + (e.kind === 'arc' ? 2 : 0)));
        if (!Number.isFinite(r)) return fail([], redundant, dof);
        out[i] = r === e.r ? e : { ...e, r };
      } else {
        out[i] = e;
      }
    }
    return { entities: out, status: 'ok', dof, conflicting: [], redundant };
  } catch (err) {
    console.warn('[sketch-solver] çözüm hatası', err);
    return fail();
  } finally {
    for (const o of owned) o.delete();
    owned.length = 0;
  }
}

/** Eğrinin verilen (uç) noktasındaki normali (yön kuralı önemli değil; yalnız 0/π seçimi için) */
function curveNormalAt(e: Curve, pId: string, idx: EntityIndex): [number, number] | null {
  if (e.kind === 'line') {
    const a = idx.point(e.p1)!, b = idx.point(e.p2)!;
    return [-(b.y - a.y), b.x - a.x];
  }
  const c = idx.point(e.c)!;
  // Paylaşılan nokta bu eğrinin kendi uç noktası olmayabilir (çakışık); eğrinin en yakın ucunu kullan
  let p = idx.point(pId)!;
  if (e.kind === 'arc' && pId !== e.start && pId !== e.end) {
    const s = idx.point(e.start)!, en = idx.point(e.end)!;
    p = Math.hypot(s.x - p.x, s.y - p.y) <= Math.hypot(en.x - p.x, en.y - p.y) ? s : en;
  }
  return [c.x - p.x, c.y - p.y];
}

/** l1 yönünden l2 yönüne yönlü açı (radyan) */
function lineDirAngle(l1: SkLine, l2: SkLine, idx: EntityIndex): number {
  const a1 = idx.point(l1.p1)!, b1 = idx.point(l1.p2)!, a2 = idx.point(l2.p1)!, b2 = idx.point(l2.p2)!;
  return dirAngle(b1.x - a1.x, b1.y - a1.y, b2.x - a2.x, b2.y - a2.y);
}

// ---------------------------------------------------------------- araç çubuğu yardımcıları

export function applicable(selected: SkEntity[]): SkConstraintType[] {
  const pts = selected.filter((e) => e.kind === 'point');
  const lines = selected.filter((e) => e.kind === 'line');
  const circ = selected.filter((e) => e.kind === 'circle' || e.kind === 'arc');
  const n = selected.length;
  const P = pts.length, L = lines.length, Cn = circ.length;
  if (n === 1) {
    if (P === 1) return ['fix', 'distanceX', 'distanceY'];
    if (L === 1) return ['horizontal', 'vertical', 'distance'];
    if (Cn === 1) return ['radius', 'diameter'];
  }
  if (n === 2) {
    if (P === 2) return ['coincident', 'horizontal', 'vertical', 'distance', 'distanceX', 'distanceY'];
    if (L === 2) return ['parallel', 'perpendicular', 'equal', 'angle'];
    if (P === 1 && L === 1) return ['pointOnLine', 'midpoint', 'distance'];
    if (Cn === 2) return ['equal', 'concentric', 'tangent'];
    if (L === 1 && Cn === 1) return ['tangent'];
    if (P === 1 && Cn === 1) return ['pointOnCircle'];
  }
  return [];
}

export function measure(type: SkConstraintType, refs: string[], entities: SkEntity[]): number | null {
  const idx = new EntityIndex(entities);
  const ents = refs.map((r) => idx.get(r));
  if (ents.some((e) => !e || !idx.curveOk(e))) return null;
  const kinds = ents.map((e) => e!.kind).join(',');
  const pt = (id: string) => idx.point(id)!;
  const fin = (x: number) => (Number.isFinite(x) ? x : null);
  switch (type) {
    case 'distance': {
      if (kinds === 'point,point') {
        const a = pt(refs[0]), b = pt(refs[1]);
        return fin(Math.hypot(b.x - a.x, b.y - a.y));
      }
      if (kinds === 'line') {
        const l = ents[0] as SkLine;
        const a = pt(l.p1), b = pt(l.p2);
        return fin(Math.hypot(b.x - a.x, b.y - a.y));
      }
      if (kinds === 'point,line' || kinds === 'line,point') {
        const [pId, lId] = kinds === 'point,line' ? refs : [refs[1], refs[0]];
        const p = pt(pId), l = idx.get(lId) as SkLine;
        const a = pt(l.p1), b = pt(l.p2);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-12) return fin(Math.hypot(p.x - a.x, p.y - a.y));
        return fin(Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len);
      }
      if (/^(point,(circle|arc)|(circle|arc),point)$/.test(kinds)) {
        const [pId, cId] = ents[0]!.kind === 'point' ? refs : [refs[1], refs[0]];
        const p = pt(pId), c = idx.get(cId) as SkCircle | SkArc, cp = pt(c.c);
        return fin(Math.abs(Math.hypot(p.x - cp.x, p.y - cp.y) - c.r));
      }
      return null;
    }
    case 'distanceX':
    case 'distanceY': {
      const isX = type === 'distanceX';
      if (kinds === 'point') {
        const p = pt(refs[0]);
        return fin(Math.abs(isX ? p.x : p.y));
      }
      if (kinds === 'point,point') {
        const a = pt(refs[0]), b = pt(refs[1]);
        return fin(Math.abs(isX ? b.x - a.x : b.y - a.y));
      }
      return null;
    }
    case 'radius':
    case 'diameter': {
      if (ents.length !== 1 || !isCircular(ents[0])) return null;
      const c = ents[0];
      let r = Math.abs(c.r);
      if (c.kind === 'arc' && !(r > 0)) {
        const cp = pt(c.c), s = pt(c.start);
        r = Math.hypot(s.x - cp.x, s.y - cp.y);
      }
      return fin(type === 'radius' ? r : 2 * r);
    }
    case 'angle': {
      if (kinds !== 'line,line') return null;
      return fin(Math.abs(lineDirAngle(ents[0] as SkLine, ents[1] as SkLine, idx)) / DEG);
    }
    default:
      return null;
  }
}

export const LABELS: Record<SkConstraintType, string> = {
  coincident: 'Çakışık',
  horizontal: 'Yatay',
  vertical: 'Dikey',
  parallel: 'Paralel',
  perpendicular: 'Dik',
  equal: 'Eşit',
  tangent: 'Teğet',
  fix: 'Sabit',
  pointOnLine: 'Çizgi üzerinde',
  pointOnCircle: 'Daire üzerinde',
  midpoint: 'Orta nokta',
  concentric: 'Eşmerkezli',
  distance: 'Mesafe',
  distanceX: 'Yatay mesafe',
  distanceY: 'Dikey mesafe',
  radius: 'Yarıçap',
  diameter: 'Çap',
  angle: 'Açı',
};
