// Güvenli ifade değerlendirici (eval yok): parametre tablosu ve ifadeli alanlar için.
// Sözdizimi: sayılar, + - * / ^, parantez, birimler (mm cm m in deg rad), fonksiyonlar
// (min max abs sqrt round floor ceil sin cos tan asin acos atan — açılar derece), sabitler (pi),
// parametre adları (harf/_ ile başlar; Türkçe harfler serbest; büyük/küçük harf duyarlı).
// Uzunluklar mm'ye, açılar dereceye çevrilir: "1 m" = 1000, "1 rad" = 57.29…

export interface ParamLike {
  name: string;
  expr: string;
}

export class ExprError extends Error {}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

const ID_START = /[A-Za-z_À-ɏ]/;
const ID_PART = /[A-Za-z0-9_À-ɏ.]/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      // (Ondalık virgül normalizeDecimal ile önceden noktaya çevrilir)
      if (/[eE]/.test(src[j] ?? '') && /[-+0-9]/.test(src[j + 1] ?? '')) {
        j++;
        if (src[j] === '-' || src[j] === '+') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const s = src.slice(i, j);
      const v = Number(s);
      if (!Number.isFinite(v)) throw new ExprError(`Geçersiz sayı: ${s}`);
      out.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '×') {
      out.push({ t: 'op', v: '*' });
      i++;
      continue;
    }
    throw new ExprError(`Beklenmeyen karakter: "${c}"`);
  }
  return out;
}

const UNITS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, deg: 1, rad: 180 / Math.PI };
const D2R = Math.PI / 180;
const FUNCS: Record<string, (...a: number[]) => number> = {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  abs: (x) => Math.abs(x),
  sqrt: (x) => Math.sqrt(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  sin: (x) => Math.sin(x * D2R),
  cos: (x) => Math.cos(x * D2R),
  tan: (x) => Math.tan(x * D2R),
  asin: (x) => Math.asin(x) / D2R,
  acos: (x) => Math.acos(x) / D2R,
  atan: (x) => Math.atan(x) / D2R,
};
const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI };

export const RESERVED = new Set([...Object.keys(UNITS), ...Object.keys(FUNCS), ...Object.keys(CONSTS)]);

// ---------------------------------------------------------------- AST

type Node =
  | { k: 'num'; v: number }
  | { k: 'ref'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

function parse(src: string): Node {
  const toks = tokenize(src);
  if (!toks.length) throw new ExprError('Boş ifade');
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`"${v}" bekleniyordu`);
    p++;
  };

  function expr(): Node {
    let a = term();
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: term() };
    }
    return a;
  }
  function term(): Node {
    let a = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = (toks[p++] as { v: string }).v;
        a = { k: 'bin', op, a, b: unary() };
      } else if (peek() && (peek()!.t === 'num' || peek()!.t === 'id' || isOp('('))) {
        // Örtük çarpma yalnız birim için ("10 mm"): sayıdan/ifadeden sonra birim adı
        const t = peek()!;
        if (t.t === 'id' && t.v in UNITS) {
          p++;
          a = { k: 'bin', op: '*', a, b: { k: 'num', v: UNITS[t.v] } };
        } else break;
      } else break;
    }
    return a;
  }
  function unary(): Node {
    if (isOp('-')) {
      p++;
      return { k: 'neg', a: unary() };
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return power();
  }
  function power(): Node {
    const a = atom();
    if (isOp('^')) {
      p++;
      return { k: 'bin', op: '^', a, b: unary() };
    }
    return a;
  }
  function atom(): Node {
    const t = peek();
    if (!t) throw new ExprError('İfade eksik');
    if (t.t === 'num') {
      p++;
      return { k: 'num', v: t.v };
    }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        if (!(t.v in FUNCS)) throw new ExprError(`Bilinmeyen fonksiyon: ${t.v}`);
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) {
            p++;
            args.push(expr());
          }
        }
        expect(')');
        return { k: 'call', fn: t.v, args };
      }
      if (t.v in CONSTS) return { k: 'num', v: CONSTS[t.v] };
      if (t.v in UNITS) return { k: 'num', v: UNITS[t.v] };
      return { k: 'ref', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      p++;
      const e = expr();
      expect(')');
      return e;
    }
    throw new ExprError(`Beklenmeyen "${t.v}"`);
  }

  const n = expr();
  if (p < toks.length) throw new ExprError(`Fazladan "${(toks[p] as { v: unknown }).v}"`);
  return n;
}

function evalNode(n: Node, lookup: (name: string) => number): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'ref':
      return lookup(n.name);
    case 'neg':
      return -evalNode(n.a, lookup);
    case 'call': {
      const f = FUNCS[n.fn];
      return f(...n.args.map((a) => evalNode(a, lookup)));
    }
    case 'bin': {
      const a = evalNode(n.a, lookup);
      const b = evalNode(n.b, lookup);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b === 0) throw new ExprError('Sıfıra bölme');
          return a / b;
        case '^':
          return a ** b;
      }
    }
  }
  throw new ExprError('Geçersiz ifade');
}

function refsOf(n: Node, out: Set<string> = new Set()): Set<string> {
  if (n.k === 'ref') out.add(n.name);
  else if (n.k === 'neg') refsOf(n.a, out);
  else if (n.k === 'bin') {
    refsOf(n.a, out);
    refsOf(n.b, out);
  } else if (n.k === 'call') n.args.forEach((a) => refsOf(a, out));
  return out;
}

// ---------------------------------------------------------------- Dış API

const cache = new Map<string, Node | ExprError>();
function parsed(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    try {
      n = parse(src);
    } catch (e) {
      n = e instanceof ExprError ? e : new ExprError(String(e));
    }
    if (cache.size > 2000) cache.clear();
    cache.set(src, n);
  }
  if (n instanceof ExprError) throw n;
  return n;
}

/** İfadedeki parametre adları (sözdizimi hatasında boş) */
export function exprRefs(src: string): string[] {
  try {
    return [...refsOf(parsed(src))];
  } catch {
    return [];
  }
}

/** Yalnız sayı mı ("12.5", "-3", "1e3") — ifade olarak saklanmaz */
export function isPlainNumber(src: string): boolean {
  return /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/.test(src.replace(',', '.'));
}

/** Ondalık virgülü noktaya çevirir ("12,5" → "12.5"; fonksiyon ayırıcılarına dokunmaz) */
export function normalizeDecimal(src: string): string {
  // Parantez dışındaki rakam,rakam → rakam.rakam
  let depth = 0;
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0 && /\d/.test(src[i - 1] ?? '') && /\d/.test(src[i + 1] ?? '')) out += '.';
    else out += c;
  }
  return out;
}

export interface ParamEval {
  values: Map<string, number>;
  errors: Map<string, string>;
}

/** Parametre tablosunu bağımlılık sırasıyla hesaplar (döngü ve bilinmeyen adlar hata olur) */
export function evalParams(params: readonly ParamLike[]): ParamEval {
  const byName = new Map(params.map((p) => [p.name, p]));
  const values = new Map<string, number>();
  const errors = new Map<string, string>();
  const state = new Map<string, 'busy' | 'done'>();
  const stack: string[] = [];

  const visit = (name: string): number => {
    if (values.has(name)) return values.get(name)!;
    if (errors.has(name)) throw new ExprError(`${name} hatalı`);
    const p = byName.get(name);
    if (!p) throw new ExprError(`Bilinmeyen ad: ${name}`);
    if (state.get(name) === 'busy') {
      const i = stack.indexOf(name);
      throw new ExprError(`Döngü: ${[...stack.slice(i), name].join(' → ')}`);
    }
    state.set(name, 'busy');
    stack.push(name);
    try {
      const v = evalNode(parsed(normalizeDecimal(p.expr)), visit);
      if (!Number.isFinite(v)) throw new ExprError('Sonuç sayı değil');
      values.set(name, v);
      return v;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.set(name, msg);
      throw new ExprError(msg);
    } finally {
      stack.pop();
      state.set(name, 'done');
    }
  };

  for (const p of params) {
    if (values.has(p.name) || errors.has(p.name)) continue;
    try {
      visit(p.name);
    } catch {
      /* hata errors'a yazıldı */
    }
  }
  // Aynı adı taşıyan ikinci parametre
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p.name)) errors.set(p.name, 'Aynı ad birden fazla kez kullanılmış');
    seen.add(p.name);
  }
  return { values, errors };
}

/** Bir alan ifadesini hesaplanmış parametre değerleriyle değerlendirir */
export function evalExpr(src: string, values: ReadonlyMap<string, number>): number {
  const v = evalNode(parsed(normalizeDecimal(src)), (name) => {
    const x = values.get(name);
    if (x === undefined) throw new ExprError(`Bilinmeyen ad: ${name}`);
    return x;
  });
  if (!Number.isFinite(v)) throw new ExprError('Sonuç sayı değil');
  return v;
}

/** Güvenli değerlendirme: { value } ya da { error } */
export function tryEvalExpr(src: string, values: ReadonlyMap<string, number>): { value: number } | { error: string } {
  try {
    return { value: evalExpr(src, values) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parametre adı geçerli mi */
export function validParamName(name: string): string | null {
  if (!name) return 'Ad boş olamaz';
  if (!ID_START.test(name[0])) return 'Ad harf ya da _ ile başlamalı';
  for (const c of name) if (!ID_PART.test(c) || c === '.') return `Adda "${c}" kullanılamaz`;
  if (RESERVED.has(name)) return `"${name}" ayrılmış bir ad`;
  return null;
}

/** İfadedeki bir parametre adını yenisiyle değiştirir (yalnız tam ad eşleşmeleri) */
export function renameInExpr(src: string, from: string, to: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      const id = src.slice(i, j);
      out += id === from ? to : id;
      i = j;
    } else if (/[0-9]/.test(c)) {
      // Sayı ve hemen ardından gelen üs; harf içeren birimler ayrı token olarak yukarıda işlenir
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out += src.slice(i, j);
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Değeri birimle okunur yazar */
export function fmtValue(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(digits));
  return String(r);
}
