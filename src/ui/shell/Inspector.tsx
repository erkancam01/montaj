import { useRef, useState, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { geometryCache } from '@/core/geometry/geometryCache';
import { eulerDegFromQuat, partLocalFromWorld, partWorld, quatFromEulerDeg } from '@/core/math/math';
import { viewerApi } from '@/services/viewerApi';
import { duplicate, remove, rename, resetTransform, setColor, setTransform, setVisible } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import type { ObjKind, Transform, Vec3 } from '@/core/types';
import { GroupInspector, MultiSelectionProps } from '@/ui/assembly/GroupInspector';
import { groupByPart, groupColor } from '@/ui/assembly/GroupList';
import { MateInspector } from '@/ui/assembly/MateInspector';

/** Dönüşümü doğrudan saklanan tek nesne seçimi (instance ya da parça) */
type ObjSel = { kind: ObjKind; id: string };
export const AXES = ['X', 'Y', 'Z'] as const;
export const DEFAULT_SWATCH = '#b4b8bf';

// ---------- yardımcılar ----------

export function fmt(v: number): string {
  return (Math.abs(v) < 0.0005 ? 0 : v).toFixed(3);
}

function parseNum(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function fmtSize(v: number): string {
  return String(Number(v.toFixed(2)));
}

export function toHex(c: [number, number, number]): string {
  return (
    '#' +
    c
      .map((x) =>
        Math.round(Math.min(1, Math.max(0, x)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

// ---------- sayı alanı ----------

export interface NumberFieldProps {
  /** Boşsa etiket gösterilmez */
  label?: string;
  /** Eksen rengi (0=X,1=Y,2=Z); verilmezse nötr etiket */
  axis?: number;
  value: number;
  step: number;
  mergeKey: string;
  onCommit(v: number, mergeKey?: string): void;
}

/**
 * Odak dışındayken değeri dışarıdan senkronlar (gizmo sürüklerken canlı güncellenir).
 * Enter/blur → commit, Escape → geri al, ArrowUp/Down → adım kadar artır/azalt.
 */
export function NumberField({ label, axis, value, step, mergeKey, onCommit }: NumberFieldProps) {
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const skipBlurCommit = useRef(false);

  const setDraft = (d: string | null) => {
    draftRef.current = d;
    setDraftState(d);
  };

  const commitDraft = (): number | null => {
    const d = draftRef.current;
    if (d === null) return null;
    const v = parseNum(d);
    if (v !== null && fmt(v) !== fmt(value)) onCommit(v);
    return v;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = commitDraft();
      setDraft(fmt(v ?? value));
      e.currentTarget.select();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      skipBlurCommit.current = true;
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parseNum(draftRef.current ?? '') ?? value;
      const v = round6(base + (e.key === 'ArrowUp' ? step : -step));
      onCommit(v, mergeKey);
      setDraft(fmt(v));
    }
  };

  return (
    <label className={`num-field ${axis === undefined ? 'num-single' : ''}`}>
      {label && <span className={axis === undefined ? 'num-unit' : `num-axis axis-${axis}`}>{label}</span>}
      <input
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        value={draft ?? fmt(value)}
        onFocus={(e) => {
          setDraft(fmt(value));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!skipBlurCommit.current) commitDraft();
          skipBlurCommit.current = false;
          setDraft(null);
        }}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}

// ---------- ad alanı ----------

export function NameField({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const skip = useRef(false);
  const setDraft = (d: string | null) => {
    draftRef.current = d;
    setDraftState(d);
  };
  return (
    <input
      className="text-input"
      type="text"
      spellCheck={false}
      value={draft ?? value}
      aria-label="Ad"
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const d = draftRef.current;
        if (!skip.current && d !== null && d.trim() && d.trim() !== value) onCommit(d);
        skip.current = false;
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          skip.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

// ---------- panel ----------

/** Sağ panelde gösterilecek bir şey var mı (yoksa masaüstünde panel gizlenir, görünüm genişler) */
export function useInspectorHasContent(): boolean {
  return useAssembly((s) => {
    if (s.modeling.sketch || s.modeling.feature) return false;
    if (s.mateSelection && s.ui.tool !== 'mate') return true;
    return !!s.selection;
  });
}

export function Inspector() {
  const selection = useAssembly((s) => s.selection);
  const multi = useAssembly((s) => s.extraSel.length > 0);
  const mateSelection = useAssembly((s) => s.mateSelection);
  const sketchOpen = useAssembly((s) => !!s.modeling.sketch);
  const featureOpen = useAssembly((s) => !!s.modeling.feature);
  // Mate aracı açıkken seçili mate sol komut panelinde düzenlenir
  const mateTool = useAssembly((s) => s.ui.tool === 'mate');
  return (
    <aside className="panel inspector-panel">
      <header className="panel-header">
        <span>Seçili nesne</span>
      </header>
      <div className="panel-body inspector">
        {sketchOpen || featureOpen ? null : mateSelection && !mateTool ? (
          <MateInspector key={mateSelection} id={mateSelection} />
        ) : selection && multi ? (
          // Ek seçim varken birincil grup olsa bile çoklu panel
          <MultiSelectionProps />
        ) : selection?.kind === 'group' ? (
          <GroupInspector key={`group:${selection.id}`} id={selection.id} />
        ) : selection ? (
          <SelectionProps key={`${selection.kind}:${selection.id}`} sel={{ kind: selection.kind, id: selection.id }} />
        ) : (
          <p className="empty-hint">Özelliklerini görmek için bir parça ya da mate seçin. Yardım: F1.</p>
        )}
      </div>
    </aside>
  );
}

function SelectionProps({ sel }: { sel: ObjSel }) {
  const { inst, part } = useAssembly(
    useShallow((s) => {
      if (sel.kind === 'instance') return { inst: s.doc.instances.find((i) => i.id === sel.id), part: undefined };
      const part = s.doc.parts.find((p) => p.id === sel.id);
      return { part, inst: part ? s.doc.instances.find((i) => i.id === part.instanceId) : undefined };
    }),
  );
  const { snap, snapMove, snapAngle } = useAssembly(
    useShallow((s) => ({ snap: s.ui.snap, snapMove: s.ui.snapMove, snapAngle: s.ui.snapAngle })),
  );
  /** Tek parça bir gruptaysa grubu (id, ad) */
  const group = useAssembly(
    useShallow((s) => {
      const g = sel.kind === 'part' ? groupByPart(s.doc.groups).get(sel.id) : undefined;
      return { id: g?.id ?? null, name: g?.name ?? '' };
    }),
  );
  const fileReady = useAssembly((s) => (inst ? s.fileStatus[inst.fileId]?.status : undefined));
  const fileName = useAssembly((s) => (inst ? s.doc.files.find((f) => f.id === inst.fileId)?.name : undefined));
  const partCount = useAssembly((s) =>
    sel.kind === 'instance' ? s.doc.parts.reduce((n, p) => (p.instanceId === sel.id ? n + 1 : n), 0) : 0,
  );
  /** Instance için: ilk özel renkli parçanın rengi */
  const instColor = useAssembly((s) =>
    sel.kind === 'instance' ? (s.doc.parts.find((p) => p.instanceId === sel.id && p.color)?.color ?? null) : null,
  );

  if (!inst || (sel.kind === 'part' && !part)) return null;

  const parsed = fileReady === 'ready' ? geometryCache.get(inst.fileId) : undefined;
  const node = part && parsed ? parsed.nodes[part.nodeKey] : undefined;
  const size: Vec3 | undefined = part ? node?.size : parsed?.size;

  const world: Transform = part ? partWorld(inst, part) : { position: inst.position, quaternion: inst.quaternion };
  const euler = eulerDegFromQuat(world.quaternion);
  const id = sel.id;

  const apply = (w: Transform, mergeKey?: string) => {
    if (part) {
      const l = partLocalFromWorld(inst, w);
      setTransform('part', part.id, l.position, l.quaternion, mergeKey);
    } else {
      setTransform('instance', inst.id, w.position, w.quaternion, mergeKey);
    }
  };
  const setPos = (axis: number, v: number, mergeKey?: string) => {
    const p = [...world.position] as Vec3;
    p[axis] = v;
    apply({ position: p, quaternion: world.quaternion }, mergeKey);
  };
  const setRot = (axis: number, v: number, mergeKey?: string) => {
    const e = [...euler] as Vec3;
    e[axis] = v;
    apply({ position: world.position, quaternion: quatFromEulerDeg(e) }, mergeKey);
  };

  const name = part ? part.name : inst.name;
  const visible = part ? part.visible : inst.visible;
  const customColor = part ? part.color : instColor;
  const stepColor = node?.meshes.find((m) => m.color)?.color;
  const swatch = customColor ?? (stepColor ? toHex(stepColor) : DEFAULT_SWATCH);

  return (
    <div className="props">
      <section className="prop-section">
        <div className="prop-head">
          <span className={`kind-tag ${sel.kind}`}>{sel.kind === 'instance' ? 'Montaj dosyası' : 'Parça'}</span>
        </div>
        <NameField value={name} onCommit={(v) => rename(sel.kind, id, v)} />
        {part ? (
          <button
            type="button"
            className="link-btn"
            title="Üst montaj dosyasını seç"
            onClick={() => useAssembly.getState().select({ kind: 'instance', id: inst.id })}
          >
            Montaj: {inst.name}
          </button>
        ) : (
          <div className="prop-meta">
            {fileName ?? 'Dosya'} · {partCount} parça
          </div>
        )}
        {group.id && (
          <>
            <button
              type="button"
              className="link-btn group-link"
              title="Parçanın ait olduğu rijit grubu seç"
              onClick={() => group.id && useAssembly.getState().select({ kind: 'group', id: group.id })}
            >
              <span className="group-dot" style={{ background: groupColor(group.id) }} aria-hidden="true" />
              Grup: {group.name}
            </button>
            <div className="prop-note warn" role="note">
              Gruptan bağımsız taşınıyor: bu parçayı taşımak gruptaki diğer parçalara göre yerini değiştirir. Tüm grubu
              taşımak için grubu seçin.
            </div>
          </>
        )}
      </section>

      <section className="prop-section">
        <div className="prop-title">
          Konum <span className="unit">mm · dünya</span>
        </div>
        <div className="num-row">
          {AXES.map((a, i) => (
            <NumberField
              key={a}
              label={a}
              axis={i}
              value={world.position[i]}
              step={snap ? snapMove : 1}
              mergeKey={`pos:${id}:${a}`}
              onCommit={(v, mk) => setPos(i, v, mk)}
            />
          ))}
        </div>
        <div className="prop-title">
          Dönüş <span className="unit">derece · XYZ</span>
        </div>
        <div className="num-row">
          {AXES.map((a, i) => (
            <NumberField
              key={a}
              label={a}
              axis={i}
              value={euler[i]}
              step={snap ? snapAngle : 1}
              mergeKey={`rot:${id}:${a}`}
              onCommit={(v, mk) => setRot(i, v, mk)}
            />
          ))}
        </div>
      </section>

      <section className="prop-section">
        <div className="prop-line">
          <span className="prop-label">Boyut</span>
          <span className="prop-value" title="Yerel (döndürülmemiş) sınır kutusu">
            {size ? `${fmtSize(size[0])} × ${fmtSize(size[1])} × ${fmtSize(size[2])} mm` : '—'}
          </span>
        </div>
        <div className="prop-line">
          <span className="prop-label">Renk</span>
          <span className="prop-value color-ctl">
            <input
              type="color"
              className="color-input"
              value={swatch}
              title={sel.kind === 'instance' ? 'Tüm parçalara renk uygula' : 'Parça rengi'}
              onChange={(e) => setColor(sel.kind, id, e.target.value)}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!customColor}
              title="STEP dosyasındaki orijinal renge dön"
              onClick={() => setColor(sel.kind, id, null)}
            >
              STEP rengi
            </button>
          </span>
        </div>
        <div className="prop-line">
          <span className="prop-label">Görünür</span>
          <span className="prop-value">
            <input
              type="checkbox"
              className="checkbox"
              checked={visible}
              title="Göster / gizle (H)"
              onChange={(e) => setVisible(sel.kind, id, e.target.checked)}
            />
          </span>
        </div>
      </section>

      <section className="prop-section actions-grid">
        <button type="button" className="btn" title="Zemine oturt (G)" onClick={() => viewerApi.dropToFloor(sel)}>
          Zemine oturt
        </button>
        <button type="button" className="btn" title="Odakla (F)" onClick={() => viewerApi.fit('selection')}>
          Odakla
        </button>
        <button type="button" className="btn" title="Çoğalt (Ctrl+D)" onClick={() => duplicate(sel)}>
          Çoğalt
        </button>
        <button type="button" className="btn" title="İlk içe aktarılan konuma döndür" onClick={() => resetTransform(sel)}>
          Konumu sıfırla
        </button>
        <button type="button" className="btn btn-danger span-2" title="Sil (Del)" onClick={() => remove(sel)}>
          Sil
        </button>
      </section>
    </div>
  );
}


