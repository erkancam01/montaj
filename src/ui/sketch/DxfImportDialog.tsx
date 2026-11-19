// DXF içe aktarma penceresi: dosyadaki profil kesitini önizler; birim, katman, dönüş, ayna ve yerleşim
// seçilir; "İçe aktar" ile açık sketch'e sabit geometri olarak eklenir (ölçüler değişmez, çözücüde sabit).
// Okuma/temizlik core/import/dxf.ts'te; burada yalnız arayüz.
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { dxfToSketch, parseDxf, placeDxf, primBounds, type DxfData, type DxfPlacement, type DxfPrim } from '@/core/import/dxf';
import { addImportedEntities, newId } from '@/state/sketchSession';
import { useAssembly } from '@/state/useAssembly';
import '@/ui/params/params.css';

interface DialogState {
  data: DxfData | null;
  fileName: string;
}

const useDxfDialog = create<DialogState>(() => ({ data: null, fileName: '' }));

/** Dosya seçtirir, okur ve pencereyi açar (açık sketch gerekir) */
export function openDxfImport() {
  const st = useAssembly.getState();
  if (!st.modeling.sketch) {
    st.showToast('DXF içe aktarmak için önce bir sketch başlatın.', 'error');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dxf,.DXF';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    if (/\.dwg$/i.test(f.name)) {
      useAssembly.getState().showToast('DWG doğrudan açılamıyor; AutoCAD\'de "Farklı kaydet → DXF" ile kaydedin.', 'error');
      return;
    }
    openDxfText(await f.text(), f.name);
  };
  input.click();
}

/** DXF metnini okuyup pencereyi açar */
export function openDxfText(text: string, fileName: string) {
  try {
    const data = parseDxf(text);
    if (!data.prims.length) throw new Error('Dosyada çizgi/yay/daire bulunamadı.');
    useDxfDialog.setState({ data, fileName });
  } catch (e) {
    useAssembly.getState().showToast(`DXF okunamadı: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

const UNITS: { v: string; label: string; mm: number }[] = [
  { v: 'mm', label: 'mm', mm: 1 },
  { v: 'cm', label: 'cm', mm: 10 },
  { v: 'm', label: 'm', mm: 1000 },
  { v: 'in', label: 'inç', mm: 25.4 },
];

const SKIP_NAMES: Record<string, string> = {
  TEXT: 'yazı',
  MTEXT: 'yazı',
  DIMENSION: 'ölçü',
  HATCH: 'tarama',
  LEADER: 'açıklama oku',
  MLEADER: 'açıklama oku',
  POINT: 'nokta',
  SOLID: 'dolgu',
  '3DFACE': '3B yüz',
  POLYFACE: '3B ağ',
};

export function DxfImportDialog() {
  const data = useDxfDialog((s) => s.data);
  const fileName = useDxfDialog((s) => s.fileName);
  const sketchOpen = useAssembly((s) => !!s.modeling.sketch);
  if (!data || !sketchOpen) return null;
  return <DialogBody key={fileName} data={data} fileName={fileName} />;
}

function DialogBody({ data, fileName }: { data: DxfData; fileName: string }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data.prims) m.set(p.layer, (m.get(p.layer) ?? 0) + 1);
    return m;
  }, [data]);
  const fileUnit = data.unitMm ? (UNITS.find((u) => Math.abs(u.mm - data.unitMm!) < 1e-9)?.v ?? 'mm') : 'mm';
  const [unit, setUnit] = useState(fileUnit);
  const [layers, setLayers] = useState<string[]>(data.layers);
  const [rotate, setRotate] = useState(0);
  const [mirror, setMirror] = useState(false);
  const [anchor, setAnchor] = useState<DxfPlacement['anchor']>('minCorner');
  const [ox, setOx] = useState('0');
  const [oy, setOy] = useState('0');
  const [tol, setTol] = useState('0.01');

  const scale = UNITS.find((u) => u.v === unit)?.mm ?? 1;
  const num = (s: string, d = 0) => {
    const v = parseFloat(s.replace(',', '.'));
    return Number.isFinite(v) ? v : d;
  };
  const placement: DxfPlacement = { scale, layers, rotate, mirror, anchor, offset: [num(ox), num(oy)] };
  const placed = useMemo(() => placeDxf(data, placement), [data, scale, layers, rotate, mirror, anchor, ox, oy]); // eslint-disable-line react-hooks/exhaustive-deps
  const bb = primBounds(placed);
  const skipped = Object.entries(data.skipped)
    .map(([k, n]) => `${n} ${SKIP_NAMES[k] ?? k.toLowerCase()}`)
    .join(', ');

  const close = () => useDxfDialog.setState({ data: null, fileName: '' });
  const doImport = () => {
    if (!placed.length) return;
    const extId = newId('dxf');
    const r = dxfToSketch(placed, extId, (p) => newId(p), Math.max(1e-6, num(tol, 0.01)));
    const curves = r.entities.filter((e) => e.kind !== 'point').length;
    if (!addImportedEntities(r.entities)) return;
    const { snapped, split, duplicates } = r.stats;
    const fixes = [snapped && `${snapped} uç birleştirildi`, split && `${split} çizgi bölündü`, duplicates && `${duplicates} kopya silindi`]
      .filter(Boolean)
      .join(', ');
    useAssembly
      .getState()
      .showToast(`${fileName}: ${curves} eğri sabit geometri olarak eklendi${fixes ? ` (${fixes})` : ''}. Silmek için birini seçip Delete.`);
    close();
  };

  return (
    <div className="pd-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pd dxf-dialog" role="dialog" aria-modal="true" aria-label="DXF içe aktar">
        <div className="pd-head">
          <span className="pd-title">DXF içe aktar — {fileName}</span>
          <button type="button" className="pd-x" aria-label="Kapat" onClick={close}>
            ✕
          </button>
        </div>
        <div className="pd-body dxf-body">
          <Preview prims={placed} />
          <div className="dxf-opts">
            <label className="dxf-row">
              <span>Birim</span>
              <select className="select-input" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {UNITS.map((u) => (
                  <option key={u.v} value={u.v}>
                    {u.label}
                    {data.unitMm && u.v === fileUnit ? ' (dosyadan)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="dxf-row">
              <span>Yerleşim</span>
              <select className="select-input" value={anchor} onChange={(e) => setAnchor(e.target.value as DxfPlacement['anchor'])}>
                <option value="minCorner">Sol alt köşe orijinde</option>
                <option value="center">Merkez orijinde</option>
                <option value="origin">DXF orijini korunur</option>
              </select>
            </label>
            <label className="dxf-row">
              <span>Döndür</span>
              <select className="select-input" value={rotate} onChange={(e) => setRotate(Number(e.target.value))}>
                {[0, 90, 180, 270].map((a) => (
                  <option key={a} value={a}>
                    {a}°
                  </option>
                ))}
              </select>
            </label>
            <label className="pd-check">
              <input type="checkbox" className="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
              Yatay çevir (ayna)
            </label>
            <div className="dxf-row">
              <span>Kaydır (mm)</span>
              <span className="dxf-xy">
                X <input className="text-input" value={ox} onChange={(e) => setOx(e.target.value)} />
                Y <input className="text-input" value={oy} onChange={(e) => setOy(e.target.value)} />
              </span>
            </div>
            <label className="dxf-row" title="Bu mesafeden yakın uçlar tek noktada birleştirilir (açık kalan köşeler kapanır)">
              <span>Birleştirme toleransı (mm)</span>
              <input className="text-input dxf-tol" value={tol} onChange={(e) => setTol(e.target.value)} />
            </label>
            <div className="dxf-layers">
              <div className="dxf-sub">Katmanlar</div>
              {data.layers.map((l) => (
                <label key={l} className="pd-check">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={layers.includes(l)}
                    onChange={(e) => setLayers((cur) => (e.target.checked ? [...cur, l] : cur.filter((x) => x !== l)))}
                  />
                  {l} <span className="dxf-dim">({counts.get(l) ?? 0})</span>
                </label>
              ))}
            </div>
            <p className="pd-help pd-help-sm">
              {bb ? `Boyut: ${fmt(bb.max[0] - bb.min[0])} × ${fmt(bb.max[1] - bb.min[1])} mm · ${placed.length} eğri` : 'Seçili katmanda eğri yok'}
              {skipped && <><br />Atlanan: {skipped}</>}
              <br />
              Profil sabit geometri olarak eklenir (ölçüleri değişmez). Kapalı bölgeleri Extrude / Süpür ile katıya çevirin.
            </p>
          </div>
        </div>
        <div className="pd-foot">
          <button type="button" className="btn" onClick={close}>
            İptal
          </button>
          <button type="button" className="btn btn-primary" disabled={!placed.length} onClick={doImport}>
            İçe aktar
          </button>
        </div>
      </div>
    </div>
  );
}

const fmt = (v: number) => String(Number(v.toFixed(2)));

/** Önizleme: yerleştirilmiş eğriler + sketch orijini (y yukarı) */
function Preview({ prims }: { prims: DxfPrim[] }) {
  const bb = primBounds(prims);
  if (!bb) return <div className="dxf-preview dxf-empty">Önizleme yok</div>;
  // Orijin de görünsün
  const x0 = Math.min(bb.min[0], 0);
  const y0 = Math.min(bb.min[1], 0);
  const x1 = Math.max(bb.max[0], 0);
  const y1 = Math.max(bb.max[1], 0);
  const w = Math.max(x1 - x0, 1e-6);
  const h = Math.max(y1 - y0, 1e-6);
  const pad = Math.max(w, h) * 0.06;
  const sw = Math.max(w, h) / 400;
  const d = prims
    .map((p) => {
      if (p.kind === 'line') return `M${p.a[0]} ${p.a[1]}L${p.b[0]} ${p.b[1]}`;
      if (p.kind === 'circle') return `M${p.c[0] + p.r} ${p.c[1]}A${p.r} ${p.r} 0 1 1 ${p.c[0] - p.r} ${p.c[1]}A${p.r} ${p.r} 0 1 1 ${p.c[0] + p.r} ${p.c[1]}`;
      let sweep = (((p.a1 - p.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (sweep < 1e-12) sweep = 2 * Math.PI;
      const s = [p.c[0] + p.r * Math.cos(p.a0), p.c[1] + p.r * Math.sin(p.a0)];
      const e = [p.c[0] + p.r * Math.cos(p.a1), p.c[1] + p.r * Math.sin(p.a1)];
      return `M${s[0]} ${s[1]}A${p.r} ${p.r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${e[0]} ${e[1]}`;
    })
    .join('');
  const o = Math.max(w, h) * 0.04;
  return (
    <svg className="dxf-preview" viewBox={`${x0 - pad} ${-(y1 + pad)} ${w + 2 * pad} ${h + 2 * pad}`} preserveAspectRatio="xMidYMid meet">
      <g transform="scale(1,-1)">
        <path d={`M${-o} 0H${o}M0 ${-o}V${o}`} className="dxf-origin" strokeWidth={sw} />
        <path d={d} className="dxf-curves" strokeWidth={sw * 1.4} fill="none" />
      </g>
    </svg>
  );
}
