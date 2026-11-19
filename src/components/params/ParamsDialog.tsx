// Parametreler penceresi: kullanıcı parametreleri tablosu (Ad, Birim, İfade, Değer, Yorum).
// Sketch ölçüleri, özellik alanları ve mate ofset/açıları bu adlara bağlanabilir; değer değişince bağlı her şey
// (sketch → katı → mate'ler → montaj) güncellenir. "Alandan çıkınca uygula" açıkken her değişiklik hemen işlenir;
// kapalıyken Tamam'da tek seferde. İptal, pencere açıldığından beri yapılanları geri alır.
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { downloadBlob } from '../../lib/download';
import { evalParams, exprRefs, fmtValue, renameInExpr, validParamName } from '../../lib/expr';
import { uid } from '../../lib/math';
import { paramUsage, renameParamEverywhere } from '../../modeling/params';
import { useAssembly } from '../../store/useAssembly';
import type { Doc, Param, ParamUnit } from '../../types';
import './params.css';

// ---------------------------------------------------------------- Açma / kapama

export const useParamsDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openParamsDialog = () => useParamsDialog.setState({ open: true });
const closeDialog = () => useParamsDialog.setState({ open: false });

const UNITS: { v: ParamUnit; label: string }[] = [
  { v: 'mm', label: 'mm' },
  { v: 'deg', label: '°' },
  { v: 'adet', label: 'adet' },
  { v: '', label: '—' },
];
const unitLabel = (u: ParamUnit) => UNITS.find((x) => x.v === u)?.label ?? '';

// ---------------------------------------------------------------- İçe / dışa aktarma

const CSV_HEAD = ['Ad', 'Birim', 'İfade', 'Yorum'];

function csvCell(s: string): string {
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function paramsToCsv(params: readonly Param[]): string {
  const lines = [CSV_HEAD.join(';'), ...params.map((p) => [p.name, p.unit, p.expr, p.comment ?? ''].map(csvCell).join(';'))];
  return '﻿' + lines.join('\r\n');
}

function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  // Ayırıcı: ; (Türkçe Excel) ya da , (ilk satıra göre)
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = first.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const toUnit = (s: string): ParamUnit => {
  const t = s.trim().toLowerCase();
  if (t === 'mm') return 'mm';
  if (t === 'deg' || t === '°' || t === 'derece') return 'deg';
  if (t === 'adet') return 'adet';
  return '';
};

/** CSV ya da JSON metninden parametre satırları */
export function parseParamsFile(text: string, isJson: boolean): Omit<Param, 'id'>[] {
  if (isJson) {
    const data: unknown = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data as { parameters?: unknown }).parameters;
    if (!Array.isArray(list)) throw new Error('JSON bir parametre listesi değil');
    return list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        name: String(x.name ?? x.Ad ?? '').trim(),
        unit: toUnit(String(x.unit ?? x.Birim ?? 'mm')),
        expr: String(x.expr ?? x.İfade ?? x.value ?? '0').trim(),
        comment: x.comment != null ? String(x.comment) : undefined,
      }))
      .filter((p) => p.name);
  }
  const rows = parseCsv(text);
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const hasHead = head.includes('ad') || head.includes('name');
  const idx = (names: string[], d: number) => {
    const i = head.findIndex((h) => names.includes(h));
    return hasHead && i >= 0 ? i : d;
  };
  const iName = idx(['ad', 'name'], 0);
  const iUnit = idx(['birim', 'unit'], 1);
  const iExpr = idx(['ifade', 'i̇fade', 'expr', 'expression', 'değer', 'value'], 2);
  const iCom = idx(['yorum', 'comment'], 3);
  return (hasHead ? rows.slice(1) : rows)
    .map((r) => ({
      name: (r[iName] ?? '').trim(),
      unit: toUnit(r[iUnit] ?? 'mm'),
      expr: (r[iExpr] ?? '0').trim() || '0',
      comment: r[iCom]?.trim() || undefined,
    }))
    .filter((p) => p.name);
}

// ---------------------------------------------------------------- Pencere

interface Row extends Param {
  /** Pencere açıldığındaki ad (yeniden adlandırma için) */
  orig?: string;
}

function nextName(rows: readonly Row[]): string {
  let n = rows.length + 1;
  while (rows.some((r) => r.name === `P${n}`)) n++;
  return `P${n}`;
}

export function ParamsDialog() {
  const open = useParamsDialog((s) => s.open);
  if (!open) return null;
  return <Dialog />;
}

function Dialog() {
  const doc = useAssembly((s) => s.doc);
  const startPast = useRef(useAssembly.getState().past.length);
  const [rows, setRows] = useState<Row[]>(() => (doc.parameters ?? []).map((p) => ({ ...p, orig: p.name })));
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState('');
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const ev = useMemo(() => evalParams(rows), [rows]);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.id, paramUsage(doc, r.orig ?? r.name, exprRefs));
    return m;
  }, [rows, doc]);

  /** Satırları belgeye işler (yeniden adlandırmalar tüm ifadelere yayılır) */
  const applyRows = (next: Row[]) => {
    const st = useAssembly.getState();
    const renames = next.filter((r) => r.orig && r.orig !== r.name).map((r) => [r.orig!, r.name] as const);
    // Tablodaki ifadeler (kullanıcının bu turdaki düzenlemeleri dahil) de yeni adlarla
    const renamedRows = next.map((r) => ({ ...r, expr: renames.reduce((e, [from, to]) => renameInExpr(e, from, to), r.expr) }));
    st.commit((d: Doc) => {
      let nd = d;
      for (const [from, to] of renames) nd = renameParamEverywhere(nd, from, to, renameInExpr);
      const parameters: Param[] = renamedRows.map(({ orig: _o, ...p }) => p);
      return { ...nd, parameters };
    });
    const synced = renamedRows.map((r) => ({ ...r, orig: r.name }));
    setRows(synced);
    setDirty(false);
    return synced;
  };

  const change = (id: string, patch: Partial<Row>, commitNow: boolean) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRows(next);
    setDirty(true);
    if (commitNow && live) applyRows(next);
  };

  const commitField = () => {
    if (live && dirty) applyRows(rows);
  };

  const add = () => {
    const r: Row = { id: uid(), name: nextName(rows), unit: 'mm', expr: '0' };
    const next = [...rows, r];
    setRows(next);
    setDirty(true);
    if (live) applyRows(next);
  };

  const remove = (r: Row) => {
    const n = usage.get(r.id) ?? 0;
    if (n > 0 && !window.confirm(`"${r.name}" ${n} yerde kullanılıyor. Silinirse bu alanlar son değerlerinde kalır ve hatalı görünür. Silinsin mi?`)) return;
    const next = rows.filter((x) => x.id !== r.id);
    setRows(next);
    setDirty(true);
    if (live) applyRows(next);
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
    setDirty(true);
    if (live) applyRows(next);
  };

  const onOk = () => {
    const bad = rows.find((r) => validParamName(r.name));
    if (bad) {
      useAssembly.getState().showToast(`"${bad.name}": ${validParamName(bad.name)}`, 'error');
      return;
    }
    if (dirty) applyRows(rows);
    closeDialog();
  };

  const onCancel = () => {
    const st = useAssembly.getState();
    // Pencere açıkken işlenen değişiklikleri geri al
    let n = st.past.length - startPast.current;
    while (n-- > 0) useAssembly.getState().undo();
    closeDialog();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const onImport = async (f: File) => {
    try {
      const text = await f.text();
      const list = parseParamsFile(text, /\.json$/i.test(f.name) || text.trim().startsWith('[') || text.trim().startsWith('{'));
      if (!list.length) {
        useAssembly.getState().showToast('Dosyada parametre bulunamadı.', 'error');
        return;
      }
      let next = [...rows];
      let added = 0;
      let updated = 0;
      for (const p of list) {
        const i = next.findIndex((r) => r.name === p.name);
        if (i >= 0) {
          next[i] = { ...next[i], unit: p.unit, expr: p.expr, comment: p.comment ?? next[i].comment };
          updated++;
        } else {
          next = [...next, { id: uid(), ...p }];
          added++;
        }
      }
      setRows(next);
      setDirty(true);
      if (live) applyRows(next);
      useAssembly.getState().showToast(`İçe aktarıldı: ${added} yeni, ${updated} güncellendi.`);
    } catch (e) {
      useAssembly.getState().showToast(`İçe aktarılamadı: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const plain = rows.map(({ orig: _o, ...p }) => p);
  const q = filter.trim().toLocaleLowerCase('tr');
  const shown = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !q || `${r.name} ${r.expr} ${r.comment ?? ''}`.toLocaleLowerCase('tr').includes(q));

  return (
    <div className="pd-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onOk()}>
      <div className="pd" role="dialog" aria-modal="true" aria-label="Parametreler">
        <div className="pd-head">
          <span className="pd-fx">ƒx</span>
          <span className="pd-title">Parametreler</span>
          <button type="button" className="pd-x" aria-label="Kapat" title="Kapat (değişiklikler korunur)" onClick={onOk}>
            ✕
          </button>
        </div>
        <div className="pd-body">
          <p className="pd-help">
            İfadeleri ve birimleri düzenleyin. Sketch ölçüsüne, özellik değerine ya da mate mesafesine parametre adı ya da ifade
            yazarak bağlayın (ör. <code>FFH</code>, <code>FFH - 2*KA</code>; yeni parametre için <code>=AD</code>).
          </p>
          <label className="pd-check">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Her değişikliği alandan çıkarken uygula
          </label>
          <div className="pd-tools">
            <input className="pd-filter" placeholder="Filtre" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              İçe aktar…
            </button>
            <button type="button" className="btn" disabled={!rows.length} onClick={() => downloadBlob(new Blob([paramsToCsv(plain)], { type: 'text/csv;charset=utf-8' }), 'parametreler.csv')}>
              CSV dışa aktar
            </button>
            <button
              type="button"
              className="btn"
              disabled={!rows.length}
              onClick={() =>
                downloadBlob(
                  new Blob([JSON.stringify(plain.map(({ id: _i, ...p }) => p), null, 2)], { type: 'application/json' }),
                  'parametreler.json',
                )
              }
            >
              JSON dışa aktar
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void onImport(f);
              }}
            />
          </div>

          <div className="pd-section">
            Kullanıcı parametreleri <span className="pd-count">{rows.length}</span>
          </div>
          <div className="pd-table-wrap">
            <table className="pd-table">
              <thead>
                <tr>
                  <th className="pd-c-icons" />
                  <th>Ad</th>
                  <th>Birim</th>
                  <th>İfade</th>
                  <th>Değer</th>
                  <th>Yorum</th>
                  <th className="pd-c-use" title="Kullanıldığı yer sayısı">Kullanım</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map(({ r, i }) => {
                  const nameErr = validParamName(r.name) ?? (rows.some((x) => x !== r && x.name === r.name) ? 'Bu ad zaten var' : null);
                  const err = ev.errors.get(r.name);
                  const val = ev.values.get(r.name);
                  return (
                    <tr key={r.id} className={err || nameErr ? 'pd-row-err' : ''}>
                      <td className="pd-c-icons">
                        <button
                          type="button"
                          className={`pd-ic ${r.fav ? 'on' : ''}`}
                          title={r.fav ? 'Favoriden çıkar' : 'Favori'}
                          onClick={() => change(r.id, { fav: !r.fav }, true)}
                        >
                          {r.fav ? '★' : '☆'}
                        </button>
                        <button type="button" className="pd-ic" title="Yukarı" disabled={i === 0} onClick={() => move(i, -1)}>
                          ▲
                        </button>
                        <button type="button" className="pd-ic" title="Aşağı" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                          ▼
                        </button>
                      </td>
                      <td>
                        <input
                          className={`pd-in pd-name ${nameErr ? 'err' : ''}`}
                          value={r.name}
                          title={nameErr ?? 'Parametre adı'}
                          spellCheck={false}
                          onChange={(e) => change(r.id, { name: e.target.value.trim() }, false)}
                          onBlur={() => !nameErr && commitField()}
                          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        />
                      </td>
                      <td>
                        <select className="pd-in pd-unit" value={r.unit} onChange={(e) => change(r.id, { unit: e.target.value as ParamUnit }, true)}>
                          {UNITS.map((u) => (
                            <option key={u.v} value={u.v}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className={`pd-in pd-expr ${err ? 'err' : ''}`}
                          value={r.expr}
                          title={err ?? 'Sayı ya da ifade (ör. 1200, FFH - 2*KA, 1.2 m)'}
                          spellCheck={false}
                          onChange={(e) => change(r.id, { expr: e.target.value }, false)}
                          onBlur={commitField}
                          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        />
                      </td>
                      <td className="pd-val" title={err}>
                        {err ? <span className="pd-err-text">{err}</span> : `${fmtValue(val ?? NaN)} ${unitLabel(r.unit)}`}
                      </td>
                      <td>
                        <input
                          className="pd-in pd-comment"
                          value={r.comment ?? ''}
                          placeholder="Yorum"
                          onChange={(e) => change(r.id, { comment: e.target.value || undefined }, false)}
                          onBlur={commitField}
                          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        />
                      </td>
                      <td className="pd-c-use">{usage.get(r.id) || ''}</td>
                      <td>
                        <button type="button" className="pd-ic pd-del" title="Sil" onClick={() => remove(r)}>
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={8} className="pd-empty">
                      Henüz parametre yok. "+ Parametre ekle" ile başlayın ya da CSV/JSON içe aktarın.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn pd-add" onClick={add}>
            + Parametre ekle
          </button>
        </div>
        <div className="pd-foot">
          <button type="button" className="btn" onClick={onCancel} title="Pencere açıldığından beri yapılan değişiklikleri geri al">
            İptal
          </button>
          <button type="button" className="btn btn-primary" onClick={onOk}>
            Tamam
          </button>
        </div>
      </div>
    </div>
  );
}
