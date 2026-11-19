// Sayı ya da ifade kabul eden alan: "120", "FFH - 2*KA", "=YENI" (yeni parametre oluşturup bağlar).
// İfadeli alanda ƒx işareti görünür; odaklanınca ifade düzenlenir, odak dışında hesaplanan değer gösterilir.
import { useRef, useState, type KeyboardEvent } from 'react';
import { evalParams, isPlainNumber, normalizeDecimal, tryEvalExpr, validParamName } from '../../lib/expr';
import { uid } from '../../lib/math';
import { exprError } from '../../modeling/params';
import { useAssembly } from '../../store/useAssembly';
import type { ParamUnit } from '../../types';

const fmt = (v: number) => String(Number(v.toFixed(4)));

export interface ExprResult {
  value: number;
  /** undefined = düz sayı (ifade kaldırılır) */
  expr: string | undefined;
}

/**
 * Metni yorumlar: düz sayı, ifade ya da "=AD" (yoksa mevcut değerle parametre oluşturur).
 * Hata olursa bildirim gösterip null döner.
 */
export function resolveExprInput(text: string, current: number, unit: ParamUnit = 'mm'): ExprResult | null {
  const st = useAssembly.getState();
  const raw = text.trim();
  if (!raw) return null;
  if (isPlainNumber(raw)) return { value: Number(normalizeDecimal(raw)), expr: undefined };
  let src = raw;
  if (src.startsWith('=')) {
    src = src.slice(1).trim();
    const params = st.doc.parameters ?? [];
    if (!validParamName(src) && !params.some((p) => p.name === src)) {
      // "=YENI": mevcut değerle yeni parametre oluşturup bu alanı ona bağla
      const p = { id: uid(), name: src, unit, expr: fmt(current) };
      st.commit((d) => ({ ...d, parameters: [...(d.parameters ?? []), p] }));
      st.showToast(`"${src}" parametresi ${fmt(current)} değeriyle oluşturuldu.`);
      return { value: current, expr: src };
    }
  }
  const values = evalParams(st.doc.parameters ?? []).values;
  const r = tryEvalExpr(src, values);
  if ('error' in r) {
    const hint = /Bilinmeyen ad/.test(r.error) ? ' (Yeni parametre için "=AD" yazın ya da Parametreler tablosundan ekleyin.)' : '';
    st.showToast(`İfade hatalı: ${r.error}${hint}`, 'error');
    return null;
  }
  return { value: r.value, expr: src };
}

interface ExprFieldProps {
  value: number;
  expr?: string;
  /** Birim etiketi (mm, °, adet) */
  label?: string;
  unit?: ParamUnit;
  step?: number;
  mergeKey?: string;
  /** params.exprError anahtarı (hata kırmızı gösterilir) */
  errorKey?: string;
  onCommit(r: ExprResult, mergeKey?: string): void;
}

export function ExprField({ value, expr, label, unit = 'mm', step = 1, mergeKey, errorKey, onCommit }: ExprFieldProps) {
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const skipBlur = useRef(false);
  // Parametre tablosu değişince hata/ değer yenilensin
  useAssembly((s) => s.doc.parameters);
  const err = errorKey ? exprError(errorKey) : undefined;

  const setDraft = (d: string | null) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const shownEdit = expr ?? fmt(value);

  const commit = () => {
    const d = draftRef.current;
    if (d === null || d.trim() === shownEdit) return;
    const r = resolveExprInput(d, value, unit);
    if (r) onCommit(r);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      skipBlur.current = true;
      e.currentTarget.blur();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !expr) {
      e.preventDefault();
      const base = Number(normalizeDecimal(draftRef.current ?? '')) || value;
      const v = Math.round((base + (e.key === 'ArrowUp' ? step : -step)) * 1e6) / 1e6;
      onCommit({ value: v, expr: undefined }, mergeKey);
      setDraft(fmt(v));
    }
  };

  return (
    <label
      className={`num-field num-single expr-field ${expr ? 'has-expr' : ''} ${err ? 'expr-err' : ''}`}
      title={err ? `Hata: ${err}` : expr ? `${expr} = ${fmt(value)}` : 'Sayı, ifade (ör. FFH - 40) ya da yeni parametre için =AD'}
    >
      {expr && <span className="expr-badge">ƒx</span>}
      {label && <span className="num-unit">{label}</span>}
      <input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={draft ?? (expr ? `${expr} = ${fmt(value)}` : fmt(value))}
        onFocus={(e) => {
          setDraft(shownEdit);
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!skipBlur.current) commit();
          skipBlur.current = false;
          setDraft(null);
        }}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}
