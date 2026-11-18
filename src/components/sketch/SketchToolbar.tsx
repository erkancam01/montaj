// Sketch araç çubuğu (viewport üstünde): araçlar, ilişkiler, geri al/yinele, Bitir/İptal. DOM etiket katmanını da monte eder.
import { useMemo } from 'react';
import { finishSketch } from '../../modeling/actions';
import type { SkConstraintType, SkEntity } from '../../modeling/types';
import {
  addConstraint,
  applicableFor,
  constraintLabel,
  isDimension,
  redoSketch,
  undoSketch,
  useSketchUi,
  type SketchTool,
} from '../../sketch/session';
import { useAssembly } from '../../store/useAssembly';
import { IconRedo, IconUndo } from '../icons';
import { ConstraintIcon, IconCheck, IconConstruction, ToolIcon } from './sketchIcons';
import { SketchOverlay } from './SketchOverlay';
import { cancelAll, chooseTool, constructionKey, resetDraw } from './tools';
import './sketch.css';

const TOOLS: { tool: SketchTool; label: string; key: string; title: string }[] = [
  { tool: 'select', label: 'Seç', key: 'S', title: 'Seç ve sürükle (kutu seçimi: soldan sağa tam içerilen, sağdan sola kesişen)' },
  { tool: 'line', label: 'Çizgi', key: 'L', title: 'Çizgi zinciri (Esc / sağ tık / Enter bitirir; sayı yazarak uzunluk girin)' },
  { tool: 'rect', label: 'Dikdörtgen', key: 'R', title: 'İki köşeli dikdörtgen (sayı yazarak genişlik × yükseklik girin)' },
  { tool: 'rectCenter', label: 'Merkez dikd.', key: '⇧R', title: 'Merkez ve köşeden dikdörtgen' },
  { tool: 'circle', label: 'Daire', key: 'C', title: 'Merkez + yarıçap (sayı yazarak yarıçap girin)' },
  { tool: 'arc', label: 'Yay', key: 'A', title: 'Merkez → başlangıç → bitiş (fare hareketi yönü belirler)' },
  { tool: 'point', label: 'Nokta', key: 'P', title: 'Bağımsız nokta' },
  { tool: 'dimension', label: 'Ölçü', key: 'D', title: 'Ölçü: öğe(ler)i seçin, etiketi yerleştirmek için boşluğa tıklayın' },
];

export function SketchToolbar() {
  const open = useAssembly((s) => !!s.modeling.sketch);
  if (!open) return null;
  return (
    <>
      <SketchOverlay />
      <div className="sk-toolbar-wrap">
        <Bar />
        <Relations />
      </div>
    </>
  );
}

function Bar() {
  const tool = useSketchUi((s) => s.tool);
  const canUndo = useSketchUi((s) => s.canUndo);
  const canRedo = useSketchUi((s) => s.canRedo);
  const construction = useSketchUi((s) => s.construction);
  const name = useAssembly((s) => s.modeling.sketch?.data.name ?? 'Sketch');
  return (
    <div className="sk-toolbar" role="toolbar" aria-label="Sketch araçları" onPointerDown={(e) => e.stopPropagation()}>
      <div className="sk-title" title={name}>
        <span className="sk-title-dot" />
        {name}
      </div>
      <div className="sk-sep" />
      <div className="sk-group">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            className={`sk-tool ${tool === t.tool ? 'active' : ''}`}
            title={`${t.title} [${t.key}]`}
            aria-pressed={tool === t.tool}
            onClick={() => chooseTool(t.tool)}
          >
            <ToolIcon tool={t.tool} />
            <span className="sk-tool-label">{t.label}</span>
            <kbd>{t.key}</kbd>
          </button>
        ))}
      </div>
      <div className="sk-sep" />
      <button
        type="button"
        className={`sk-tool ${construction ? 'active' : ''}`}
        title="Yardımcı geometri: seçili eğrileri yardımcı yap / seçim yoksa yeni çizimler için yardımcı kipi aç-kapa [X]"
        aria-pressed={construction}
        onClick={constructionKey}
      >
        <IconConstruction />
        <span className="sk-tool-label">Yardımcı</span>
        <kbd>X</kbd>
      </button>
      <div className="sk-sep" />
      <button
        type="button"
        className="sk-icon-btn"
        title="Geri al [Ctrl+Z]"
        aria-label="Geri al"
        disabled={!canUndo}
        onClick={() => {
          resetDraw();
          undoSketch();
        }}
      >
        <IconUndo />
      </button>
      <button
        type="button"
        className="sk-icon-btn"
        title="Yinele [Ctrl+Y]"
        aria-label="Yinele"
        disabled={!canRedo}
        onClick={() => {
          resetDraw();
          redoSketch();
        }}
      >
        <IconRedo />
      </button>
      <div className="sk-sep" />
      <StatusPill />
      <button type="button" className="btn btn-ghost sk-cancel" title="Değişiklikleri at ve çık" onClick={confirmCancel}>
        İptal
      </button>
      <button type="button" className="btn btn-primary sk-finish" title="Sketch'i bitir [Enter]" onClick={() => finishSketch()}>
        <IconCheck size={14} /> Bitir
      </button>
    </div>
  );
}

export function confirmCancel() {
  const changed = useSketchUi.getState().canUndo;
  if (changed && !window.confirm('Sketch değişiklikleri atılsın mı?')) return;
  cancelAll();
}

function StatusPill() {
  const status = useSketchUi((s) => s.status);
  const ready = useSketchUi((s) => s.solverReady);
  if (!ready || !status.known) {
    return (
      <span className="sk-status unknown" title="Çözücü hazır değil: kısıtlar kaydedilir ama çözülmez">
        Çözücü yok
      </span>
    );
  }
  if (!status.ok || status.conflicting.length) return <span className="sk-status bad">Çelişkili</span>;
  if (status.dof === 0) return <span className="sk-status ok">Tam tanımlı</span>;
  return <span className="sk-status free">{status.dof} SD</span>;
}

/** Seçime uygun ilişki/ölçü düğmeleri */
function Relations() {
  const sel = useSketchUi((s) => s.sel);
  const entities = useAssembly((s) => s.modeling.sketch?.data.entities);
  const selected = useMemo(() => {
    if (!entities) return [] as SkEntity[];
    const m = new Map(entities.map((e) => [e.id, e]));
    return sel.map((id) => m.get(id)).filter((e): e is SkEntity => !!e);
  }, [sel, entities]);
  const types = useMemo(() => (selected.length ? applicableFor(selected) : []), [selected]);
  if (!selected.length) return null;
  return (
    <div className="sk-relations" onPointerDown={(e) => e.stopPropagation()}>
      <span className="sk-rel-count">{selected.length} öğe</span>
      {types.length ? (
        types.map((t) => (
          <button key={t} type="button" className="sk-rel" title={constraintLabel(t)} onClick={() => applyRelation(t, selected)}>
            <ConstraintIcon type={t} size={13} />
            <span>{constraintLabel(t)}</span>
          </button>
        ))
      ) : (
        <span className="sk-rel-none">Bu seçime uygun ilişki yok</span>
      )}
    </div>
  );
}

function applyRelation(type: SkConstraintType, selected: SkEntity[]) {
  const ids = selected.map((e) => e.id);
  const lines = selected.filter((e) => e.kind === 'line');
  // Çoklu çizgi: her çizgiye ayrı (yatay/dikey) ya da ilk çizgiyle çiftler (paralel/eşit)
  if (selected.length > 2 && lines.length === selected.length) {
    if (type === 'horizontal' || type === 'vertical') {
      for (const l of lines) addConstraint(type, [l.id]);
      return;
    }
    if (type === 'parallel' || type === 'equal' || type === 'perpendicular') {
      for (const l of lines.slice(1)) addConstraint(type, [lines[0].id, l.id]);
      return;
    }
  }
  const id = addConstraint(type, ids);
  if (id && isDimension(type)) useSketchUi.setState({ editing: id, sel: [id] });
}
