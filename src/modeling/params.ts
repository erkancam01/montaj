// Kullanıcı parametrelerini belgeye uygular: ifadeli sketch ölçüleri, özellik alanları ve mate ofset/açıları
// hesaplanan değerlerle güncellenir; ölçüsü değişen sketch'ler başsız çözülür. Store commit'i her değişiklikte
// çağırır (tek geri al adımı); sonrasında bodyManager gövdeleri yeniden üretir, mate'ler yeni yüzlere oturur.
import { evalParams, tryEvalExpr, type ParamEval } from '../lib/expr';
import { initSketchSolver, isSketchSolverReady, solveSketch } from '../sketch/solver';
import type { Body, Doc, Feature, Mate, SketchFeature } from '../types';

/** Tam sayı olması gereken özellik alanları (adet) */
const INT_FIELDS = new Set(['count', 'count1', 'count2']);
/** Pozitif olması gereken ölçü tipleri */
const POSITIVE_DIMS = new Set(['radius', 'diameter', 'distance']);

/** Son uygulamadaki ifade hataları: anahtar → mesaj (arayüz alanları kırmızı gösterir) */
let lastErrors = new Map<string, string>();
let lastEval: ParamEval = { values: new Map(), errors: new Map() };
const listeners = new Set<() => void>();

export const featureExprKey = (featureId: string, field: string) => `f:${featureId}:${field}`;
export const constraintExprKey = (constraintId: string) => `k:${constraintId}`;
export const mateExprKey = (mateId: string, field: 'offset' | 'angle') => `m:${mateId}:${field}`;

export function exprError(key: string): string | undefined {
  return lastErrors.get(key);
}

/** Parametre tablosunun son hesap sonucu (değerler + parametre hataları) */
export function paramEval(): ParamEval {
  return lastEval;
}

export function onParamsApplied(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Sketch çözücüyü erkenden yükle (parametre değişiminde sketch'ler senkron çözülebilsin)
let solverLoading = false;
export function warmupParamSolver() {
  if (solverLoading || isSketchSolverReady()) return;
  solverLoading = true;
  initSketchSolver().catch((e: unknown) => console.error('Sketch çözücü yüklenemedi', e));
}

const sameNum = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Belgede parametreye bağlı bir şey var mı (yoksa hiç iş yapılmaz) */
function hasExprs(doc: Doc): boolean {
  if (doc.parameters?.length) return true;
  for (const b of doc.bodies) {
    for (const f of b.features) {
      if (f.exprs && Object.keys(f.exprs).length) return true;
      if (f.type === 'sketch' && f.constraints.some((c) => c.expr)) return true;
    }
  }
  return doc.mates.some((m) => m.offsetExpr || m.angleExpr);
}

/**
 * Parametreleri belgeye uygular. Değişen bir şey yoksa aynı belge nesnesini döndürür.
 * Hatalı ifadeler alanın son geçerli değerini korur (hata exprError ile okunur).
 */
export function applyParameters(doc: Doc): Doc {
  if (!hasExprs(doc)) {
    if (lastErrors.size || lastEval.values.size || lastEval.errors.size) {
      lastErrors = new Map();
      lastEval = { values: new Map(), errors: new Map() };
      listeners.forEach((l) => l());
    }
    return doc;
  }
  const ev = evalParams(doc.parameters ?? []);
  const values = ev.values;
  const errors = new Map<string, string>();

  const evalField = (key: string, expr: string): number | null => {
    const r = tryEvalExpr(expr, values);
    if ('error' in r) {
      errors.set(key, r.error);
      return null;
    }
    return r.value;
  };

  // ---- Gövdeler
  let bodiesChanged = false;
  const bodies: Body[] = doc.bodies.map((b) => {
    let featsChanged = false;
    const features: Feature[] = b.features.map((f) => {
      let nf: Feature = f;
      // Özellik alanları
      if (f.exprs) {
        const rec = f as unknown as Record<string, unknown>;
        let patch: Record<string, number> | null = null;
        for (const [field, expr] of Object.entries(f.exprs)) {
          const key = featureExprKey(f.id, field);
          let v = evalField(key, expr);
          if (v === null) continue;
          if (INT_FIELDS.has(field)) {
            v = Math.round(v);
            if (v < 1) {
              errors.set(key, 'Adet en az 1 olmalı');
              continue;
            }
          }
          if (typeof rec[field] === 'number' && !sameNum(rec[field] as number, v)) (patch ??= {})[field] = v;
        }
        if (patch) nf = { ...f, ...patch } as Feature;
      }
      // Sketch ölçüleri
      if (nf.type === 'sketch' && nf.constraints.some((c) => c.expr)) {
        const sk = nf as SketchFeature;
        let dimChanged = false;
        const constraints = sk.constraints.map((c) => {
          if (!c.expr) return c;
          const key = constraintExprKey(c.id);
          let v = evalField(key, c.expr);
          if (v === null) return c;
          if (POSITIVE_DIMS.has(c.type)) {
            if (v <= 0) {
              errors.set(key, 'Değer sıfırdan büyük olmalı');
              return c;
            }
          }
          if (c.type !== 'angle' && c.type !== 'distanceX' && c.type !== 'distanceY') v = Math.abs(v);
          if (c.value !== undefined && sameNum(c.value, v)) return c;
          dimChanged = true;
          return { ...c, value: v };
        });
        if (dimChanged) {
          if (!isSketchSolverReady()) {
            warmupParamSolver();
            errors.set(`s:${sk.id}`, 'Sketch çözücü henüz yüklenmedi; birkaç saniye sonra tekrar deneyin.');
          } else {
            let r;
            try {
              r = solveSketch(sk.entities, constraints);
            } catch (e) {
              r = null;
              console.error('Sketch çözülemedi', e);
            }
            if (r && r.status === 'ok') {
              nf = { ...sk, constraints, entities: r.entities };
            } else {
              errors.set(`s:${sk.id}`, `"${sk.name}" bu değerlerle çözülemedi; eski geometride kaldı.`);
              for (const c of constraints) if (c.expr) errors.set(constraintExprKey(c.id), 'Sketch bu değerle çözülemedi');
            }
          }
        }
      }
      if (nf !== f) featsChanged = true;
      return nf;
    });
    if (!featsChanged) return b;
    bodiesChanged = true;
    return { ...b, features };
  });

  // ---- Mate'ler
  let matesChanged = false;
  const mates: Mate[] = doc.mates.map((m) => {
    let nm = m;
    if (m.offsetExpr) {
      const v = evalField(mateExprKey(m.id, 'offset'), m.offsetExpr);
      if (v !== null && !sameNum(v, m.offset)) nm = { ...nm, offset: v };
    }
    if (m.angleExpr) {
      const v = evalField(mateExprKey(m.id, 'angle'), m.angleExpr);
      if (v !== null && !sameNum(v, m.angle)) nm = { ...nm, angle: v };
    }
    if (nm !== m) matesChanged = true;
    return nm;
  });

  lastErrors = errors;
  lastEval = ev;
  listeners.forEach((l) => l());
  if (!bodiesChanged && !matesChanged) return doc;
  return { ...doc, bodies: bodiesChanged ? bodies : doc.bodies, mates: matesChanged ? mates : doc.mates };
}

/** Bir parametre adının kullanıldığı yer sayısı (tablo "N yerde" ve silme uyarısı için) */
export function paramUsage(doc: Doc, name: string, refsOf: (expr: string) => string[]): number {
  let n = 0;
  const count = (e?: string) => {
    if (e && refsOf(e).includes(name)) n++;
  };
  for (const p of doc.parameters ?? []) if (p.name !== name) count(p.expr);
  for (const b of doc.bodies)
    for (const f of b.features) {
      if (f.exprs) Object.values(f.exprs).forEach(count);
      if (f.type === 'sketch') f.constraints.forEach((c) => count(c.expr));
    }
  for (const m of doc.mates) {
    count(m.offsetExpr);
    count(m.angleExpr);
  }
  return n;
}

/** Parametre adı değişince tüm ifadelerdeki adı günceller */
export function renameParamEverywhere(doc: Doc, from: string, to: string, rename: (e: string, a: string, b: string) => string): Doc {
  const r = (e: string | undefined) => (e ? rename(e, from, to) : e);
  return {
    ...doc,
    parameters: doc.parameters?.map((p) => ({ ...p, expr: rename(p.expr, from, to) })),
    bodies: doc.bodies.map((b) => ({
      ...b,
      features: b.features.map((f) => {
        let nf = f;
        if (f.exprs) nf = { ...nf, exprs: Object.fromEntries(Object.entries(f.exprs).map(([k, e]) => [k, rename(e, from, to)])) };
        if (nf.type === 'sketch') nf = { ...nf, constraints: nf.constraints.map((c) => (c.expr ? { ...c, expr: rename(c.expr, from, to) } : c)) };
        return nf;
      }),
    })),
    mates: doc.mates.map((m) => ({ ...m, offsetExpr: r(m.offsetExpr), angleExpr: r(m.angleExpr) })),
  };
}
