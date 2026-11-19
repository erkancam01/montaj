// Sketch arayüzü parçaları: araç listesi ve çözücü durumu (komut çubuğunun Çizim sekmesi kullanır), viewport
// üstündeki seçime uygun ilişki şeridi ve DOM etiket katmanı.
import { useMemo } from 'react';
import type { SkConstraintType, SkEntity } from '../../modeling/types';
import {
  addConstraint,
  applicableFor,
  constraintLabel,
  isDimension,
  useSketchUi,
  type SketchTool,
} from '../../sketch/session';
import { useAssembly } from '../../store/useAssembly';
import { ConstraintIcon } from './sketchIcons';
import { SketchOverlay } from './SketchOverlay';
import { cancelAll } from './tools';
import './sketch.css';

export const SKETCH_TOOLS: { tool: SketchTool; label: string; key: string; title: string }[] = [
  { tool: 'select', label: 'Seç', key: 'Esc', title: 'Seç ve sürükle (kutu seçimi: soldan sağa tam içerilen, sağdan sola kesişen)' },
  { tool: 'line', label: 'Çizgi', key: 'L', title: 'Çizgi zinciri (Esc / sağ tık / Enter bitirir; sayı yazarak uzunluk girin)' },
  { tool: 'rect', label: 'Dikdörtgen', key: 'R', title: 'İki köşeli dikdörtgen (sayı yazarak genişlik × yükseklik girin)' },
  { tool: 'rectCenter', label: 'Merkez dikd.', key: '⇧R', title: 'Merkez ve köşeden dikdörtgen' },
  { tool: 'circle', label: 'Daire', key: 'C', title: 'Merkez + yarıçap (sayı yazarak yarıçap girin)' },
  { tool: 'arc', label: 'Yay', key: 'A', title: 'Merkez → başlangıç → bitiş (fare hareketi yönü belirler)' },
  { tool: 'point', label: 'Nokta', key: 'P', title: 'Bağımsız nokta' },
  { tool: 'dimension', label: 'Ölçü', key: 'D', title: 'Ölçü: öğe(ler)i seçin, etiketi yerleştirmek için boşluğa tıklayın' },
  {
    tool: 'project',
    label: 'Projeksiyon',
    key: 'J',
    title: "Başka bir parçanın yüzünü (dış hat + delikler) ya da kenarını sketch'e aktar; kaynak taşınınca güncellenir",
  },
];

export function SketchToolbar() {
  const open = useAssembly((s) => !!s.modeling.sketch);
  if (!open) return null;
  return (
    <>
      <SketchOverlay />
      <div className="sk-toolbar-wrap">
        <Relations />
      </div>
    </>
  );
}

export function confirmCancel() {
  const changed = useSketchUi.getState().canUndo;
  if (changed && !window.confirm('Sketch değişiklikleri atılsın mı?')) return;
  cancelAll();
}

export function StatusPill() {
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
