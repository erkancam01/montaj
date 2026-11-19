// Kullanıcı parametrelerini belgeye uygular: ifadeli sketch ölçüleri, özellik alanları ve mate ofset/açıları
// hesaplanan değerlerle güncellenir; ölçüsü değişen sketch'ler başsız çözülür. Store commit'i her değişiklikte
// çağırır (tek geri al adımı); sonrasında bodyManager gövdeleri yeniden üretir, mate'ler yeni yüzlere oturur.
import { featureFields } from '@/core/features/registry';
import { evalParams, tryEvalExpr, type ParamEval, type ParamLike } from '@/core/math/expr';
import { initSketchSolver, isSketchSolverReady, solveSketch } from '@/core/sketch/solver';
import type { Body, Doc, Feature, Mate, ParamUnit, SkConstraint, SketchFeature } from '@/core/types';

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

// ---------------------------------------------------------------- Model parametreleri

/** Sketch ölçüleri ve özellik değerleri: Parametreler tablosunda "Model parametreleri" olarak listelenir */
export interface ModelParam {
  /** featureExprKey / constraintExprKey (hata anahtarı da budur) */
  key: string;
  name: string;
  bodyId: string;
  bodyName: string;
  ownerId: string;
  ownerName: string;
  kind: 'dim' | 'field';
  constraintId?: string;
  field?: string;
  label: string;
  unit: ParamUnit;
  value: number;
  expr?: string;
}

const DIM_LABELS: Partial<Record<SkConstraint['type'], string>> = {
  distance: 'Mesafe',
  distanceX: 'Yatay mesafe',
  distanceY: 'Dikey mesafe',
  radius: 'Yarıçap',
  diameter: 'Çap',
  angle: 'Açı',
};
const isDim = (c: SkConstraint) => c.type in DIM_LABELS && typeof c.value === 'number';

/**
 * Adı olmayan ölçü ve özellik alanlarına otomatik model parametresi adı verir (d1, d2…). Kopyalanmış
 * gövdelerde aynı adı taşıyan ikinci öğe yeni ad alır. Değişiklik yoksa aynı belge döner.
 */
export function assignModelNames(doc: Doc): Doc {
  const used = new Set<string>((doc.parameters ?? []).map((p) => p.name));
  const seen = new Set<string>();
  // Önce mevcut adları topla (sırayla; tekrar edenler yeniden adlandırılacak)
  for (const b of doc.bodies)
    for (const f of b.features) {
      if (f.type === 'sketch') for (const c of f.constraints) if (c.name) used.add(c.name);
      if (f.pnames) Object.values(f.pnames).forEach((n) => used.add(n));
    }
  let n = 0;
  const fresh = () => {
    let name: string;
    do name = `d${++n}`;
    while (used.has(name));
    used.add(name);
    return name;
  };
  const claim = (name: string | undefined): string | null => {
    if (!name || seen.has(name)) return null;
    seen.add(name);
    return name;
  };
  let bodiesChanged = false;
  const bodies = doc.bodies.map((b) => {
    let changed = false;
    const features = b.features.map((f) => {
      let nf: Feature = f;
      if (f.type === 'sketch') {
        let cc = false;
        const constraints = f.constraints.map((c) => {
          if (!isDim(c)) return c;
          if (claim(c.name)) return c;
          cc = true;
          const name = fresh();
          seen.add(name);
          return { ...c, name };
        });
        if (cc) nf = { ...f, constraints };
      }
      const defs = featureFields(nf);
      if (defs.length) {
        let pnames: Record<string, string> | null = null;
        for (const d of defs) {
          const cur = nf.pnames?.[d.field];
          if (claim(cur)) continue;
          pnames ??= { ...(nf.pnames ?? {}) };
          const name = fresh();
          seen.add(name);
          pnames[d.field] = name;
        }
        if (pnames) nf = { ...nf, pnames };
      }
      if (nf !== f) changed = true;
      return nf;
    });
    if (!changed) return b;
    bodiesChanged = true;
    return { ...b, features };
  });
  return bodiesChanged ? { ...doc, bodies } : doc;
}

/** Belgedeki tüm model parametreleri (gövde → özellik sırasıyla) */
export function modelParams(doc: Doc): ModelParam[] {
  const out: ModelParam[] = [];
  for (const b of doc.bodies)
    for (const f of b.features) {
      if (f.type === 'sketch') {
        for (const c of f.constraints) {
          if (!isDim(c) || !c.name) continue;
          out.push({
            key: constraintExprKey(c.id),
            name: c.name,
            bodyId: b.id,
            bodyName: b.name,
            ownerId: f.id,
            ownerName: f.name,
            kind: 'dim',
            constraintId: c.id,
            label: DIM_LABELS[c.type] ?? c.type,
            unit: c.type === 'angle' ? 'deg' : 'mm',
            value: c.value as number,
            expr: c.expr,
          });
        }
      }
      const rec = f as unknown as Record<string, unknown>;
      for (const d of featureFields(f)) {
        const name = f.pnames?.[d.field];
        const v = rec[d.field];
        if (!name || typeof v !== 'number') continue;
        out.push({
          key: featureExprKey(f.id, d.field),
          name,
          bodyId: b.id,
          bodyName: b.name,
          ownerId: f.id,
          ownerName: f.name,
          kind: 'field',
          field: d.field,
          label: d.label,
          unit: d.unit,
          value: v,
          expr: f.exprs?.[d.field],
        });
      }
    }
  return out;
}

const fmtNum = (v: number) => String(Number(v.toFixed(6)));

/** İfade değerlendirmesine girecek tüm adlar: kullanıcı parametreleri + model parametreleri */
export function allParamLikes(doc: Doc): ParamLike[] {
  return [
    ...(doc.parameters ?? []).map((p) => ({ name: p.name, expr: p.expr })),
    ...modelParams(doc).map((m) => ({ name: m.name, expr: m.expr ?? fmtNum(m.value) })),
  ];
}

/** Bir sketch'i verilen ölçülerle çözer; başarısızsa null */
function solveWith(sk: SketchFeature, constraints: SkConstraint[]): SketchFeature | null {
  if (!isSketchSolverReady()) {
    warmupParamSolver();
    return null;
  }
  try {
    const r = solveSketch(sk.entities, constraints);
    return r.status === 'ok' ? { ...sk, constraints, entities: r.entities } : null;
  } catch (e) {
    console.error('Sketch çözülemedi', e);
    return null;
  }
}

/**
 * Tablodan bir model parametresini değiştirir (ad, ifade ya da düz değer). Ölçülerde sketch hemen yeniden
 * çözülür; çözülemezse null döner (değişiklik uygulanmaz). Ad değişince tüm ifadelerdeki ad da güncellenir.
 */
export function updateModelParam(
  doc: Doc,
  mp: ModelParam,
  patch: { name?: string; expr?: string | null; value?: number },
  rename: (e: string, a: string, b: string) => string,
): Doc | null {
  let d = doc;
  if (patch.name && patch.name !== mp.name) d = renameParamEverywhere(d, mp.name, patch.name, rename);
  const bodies = d.bodies.map((b) => {
    if (b.id !== mp.bodyId) return b;
    return {
      ...b,
      features: b.features.map((f) => {
        if (f.id !== mp.ownerId) return f;
        if (mp.kind === 'dim' && f.type === 'sketch') {
          const constraints = f.constraints.map((c) => {
            if (c.id !== mp.constraintId) return c;
            const nc: SkConstraint = { ...c };
            if (patch.name) nc.name = patch.name;
            if (patch.expr === null) delete nc.expr;
            else if (patch.expr !== undefined) nc.expr = patch.expr;
            if (patch.value !== undefined) nc.value = c.type === 'angle' ? patch.value : Math.abs(patch.value);
            return nc;
          });
          if (patch.value === undefined) return { ...f, constraints };
          return solveWith(f, constraints) ?? f;
        }
        if (mp.kind === 'field' && mp.field) {
          const field = mp.field;
          const nf = { ...f } as Feature & Record<string, unknown>;
          if (patch.name) nf.pnames = { ...(f.pnames ?? {}), [field]: patch.name };
          if (patch.expr === null) {
            const exprs = { ...(f.exprs ?? {}) };
            delete exprs[field];
            nf.exprs = Object.keys(exprs).length ? exprs : undefined;
          } else if (patch.expr !== undefined) nf.exprs = { ...(f.exprs ?? {}), [field]: patch.expr };
          if (patch.value !== undefined) nf[field] = INT_FIELDS.has(field) ? Math.max(1, Math.round(patch.value)) : patch.value;
          return nf as Feature;
        }
        return f;
      }),
    };
  });
  const out = { ...d, bodies };
  // Ölçü değeri istenip sketch çözülemediyse (aynı nesne döndü) başarısız say
  if (mp.kind === 'dim' && patch.value !== undefined) {
    const f = out.bodies.find((b) => b.id === mp.bodyId)?.features.find((x) => x.id === mp.ownerId);
    const c = f?.type === 'sketch' ? f.constraints.find((x) => x.id === mp.constraintId) : undefined;
    if (!c || !sameNum(c.value ?? NaN, mp.kind === 'dim' && c.type === 'angle' ? patch.value : Math.abs(patch.value))) return null;
  }
  return out;
}

// ---------------------------------------------------------------- Uygulama

/** Belgede parametreye bağlı bir şey var mı (yoksa ifade hesabı yapılmaz) */
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
 * Parametreleri belgeye uygular: model parametresi adları atanır, ifadeli ölçü/alanlar hesaplanır, ölçüsü
 * değişen sketch'ler çözülür. Değişen bir şey yoksa aynı belge nesnesini döndürür. Hatalı ifadeler alanın son
 * geçerli değerini korur (hata exprError ile okunur).
 */
export function applyParameters(prev: Doc, next: Doc): Doc {
  if (next.bodies === prev.bodies && next.parameters === prev.parameters && next.mates === prev.mates) return next;
  const doc = assignModelNames(next);
  if (!hasExprs(doc)) {
    if (lastErrors.size || lastEval.values.size || lastEval.errors.size) {
      lastErrors = new Map();
      lastEval = { values: new Map(), errors: new Map() };
      listeners.forEach((l) => l());
    }
    return doc;
  }
  const ev = evalParams(allParamLikes(doc));
  const values = ev.values;
  const errors = new Map<string, string>();

  /** Adlı (model) alan: tablo hesabından; adsız: ifadeyi doğrudan değerlendir */
  const evalNamed = (key: string, name: string | undefined, expr: string): number | null => {
    if (name) {
      const err = ev.errors.get(name);
      if (err) {
        errors.set(key, err);
        return null;
      }
      const v = values.get(name);
      if (v !== undefined) return v;
    }
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
          let v = evalNamed(key, f.pnames?.[field], expr);
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
          let v = evalNamed(key, c.name, c.expr);
          if (v === null) return c;
          if (POSITIVE_DIMS.has(c.type) && v <= 0) {
            errors.set(key, 'Değer sıfırdan büyük olmalı');
            return c;
          }
          if (c.type !== 'angle' && c.type !== 'distanceX' && c.type !== 'distanceY') v = Math.abs(v);
          if (c.value !== undefined && sameNum(c.value, v)) return c;
          dimChanged = true;
          return { ...c, value: v };
        });
        if (dimChanged) {
          const solved = solveWith(sk, constraints);
          if (solved) nf = solved;
          else if (!isSketchSolverReady()) errors.set(`s:${sk.id}`, 'Sketch çözücü henüz yüklenmedi; birkaç saniye sonra tekrar deneyin.');
          else {
            errors.set(`s:${sk.id}`, `"${sk.name}" bu değerlerle çözülemedi; eski geometride kaldı.`);
            for (const c of constraints) if (c.expr) errors.set(constraintExprKey(c.id), 'Sketch bu değerle çözülemedi');
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
      const v = evalNamed(mateExprKey(m.id, 'offset'), undefined, m.offsetExpr);
      if (v !== null && !sameNum(v, m.offset)) nm = { ...nm, offset: v };
    }
    if (m.angleExpr) {
      const v = evalNamed(mateExprKey(m.id, 'angle'), undefined, m.angleExpr);
      if (v !== null && !sameNum(v, m.angle)) nm = { ...nm, angle: v };
    }
    if (nm !== m) matesChanged = true;
    return nm;
  });

  // Tablo hataları: model parametresi adına bağlı hatalar da alan anahtarıyla görünür
  for (const mp of modelParams(doc)) {
    const e = ev.errors.get(mp.name);
    if (e && mp.expr && !errors.has(mp.key)) errors.set(mp.key, e);
  }

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
      if (f.exprs) for (const [field, e] of Object.entries(f.exprs)) if (f.pnames?.[field] !== name) count(e);
      if (f.type === 'sketch') f.constraints.forEach((c) => c.name !== name && count(c.expr));
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
