// Sağ panel (sketch açıkken): ad, çözüm durumu, seçili varlığın özellikleri, kısıt listesi, Bitir/İptal.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { finishSketch, getBody } from '@/state/modelingActions';
import type { SkConstraint, SkEntity, SketchFeature, Vec2 } from '@/core/types/modeling';
import {
  addItems,
  applySketch,
  constraintLabel,
  currentSketch,
  entityName,
  findConstraint,
  isDimension,
  newId,
  removeItems,
  setConstraintValue,
  setHover,
  setSelection,
  toggleConstruction,
  toggleSelected,
  useSketchUi,
} from '@/state/sketchSession';
import { useAssembly } from '@/state/useAssembly';
import { resolveExprInput } from '@/ui/params/ExprField';
import { dimText } from '@/ui/sketch/annotations';
import { add, arcAngles, dist, fmt, isCurve, linePts, mul, norm, parseNum, pointMap, sub, v2 } from '@/core/sketch/geom';
import { ConstraintIcon, IconCheck, IconSketch, IconTrash } from '@/ui/icons/sketchIcons';
import { confirmCancel } from '@/ui/sketch/SketchToolbar';
import '@/ui/sketch/sketch.css';

export function SketchInspector() {
  const data = useAssembly((s) => s.modeling.sketch?.data);
  const bodyId = useAssembly((s) => s.modeling.sketch?.bodyId);
  const isNew = useAssembly((s) => s.modeling.sketch?.isNew ?? false);
  if (!data) return null;
  const bodyName = bodyId ? getBody(bodyId)?.name : undefined;
  return (
    <div className="sk-inspector">
      <section className="prop-section">
        <div className="prop-head sk-insp-head">
          <span className="kind-tag sk-kind">
            <IconSketch size={12} /> Sketch
          </span>
          {isNew && <span className="sk-new">yeni</span>}
        </div>
        <NameField data={data} />
        <div className="prop-meta">
          {bodyName ? `${bodyName} · ` : ''}
          {data.entities.filter((e) => e.kind !== 'point').length} eğri · {data.constraints.length} kısıt
        </div>
      </section>
      <StatusSection />
      <SelectionSection data={data} />
      <ConstraintSection data={data} />
      <section className="prop-section">
        <div className="actions-grid sk-insp-actions">
          <button type="button" className="btn" onClick={confirmCancel}>
            İptal
          </button>
          <button type="button" className="btn btn-primary" onClick={() => finishSketch()}>
            <IconCheck size={14} /> Bitir
          </button>
        </div>
      </section>
      <section className="prop-section sk-help">
        <div className="prop-title">Fare ve klavye</div>
        <ul>
          <li>
            <b>Sol</b> çiz / seç / sürükle · <b>Orta</b> döndür · <b>Ctrl+orta</b> kaydır · <b>Tekerlek</b> yakınlaştır · <kbd>Ctrl+8</kbd> normal'e bak
          </li>
          <li>
            Çizerken sayı yazın: ölçü kutusu (<kbd>Tab</kbd> ikinci değer, <kbd>Enter</kbd> onay)
          </li>
          <li>
            <kbd>Esc</kbd> çizimi / aracı / seçimi bırakır · <kbd>Del</kbd> siler · <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd>
          </li>
          <li>Ölçü etiketine çift tıklayın: değeri düzenleyin; sürükleyin: taşıyın</li>
        </ul>
      </section>
    </div>
  );
}

function NameField({ data }: { data: SketchFeature }) {
  const [text, setText] = useState(data.name);
  const skip = useRef(false);
  useEffect(() => setText(data.name), [data.name]);
  const commit = () => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const n = text.trim();
    if (!n || n === data.name) {
      setText(data.name);
      return;
    }
    applySketch((d) => ({ ...d, name: n }), { noSolve: true });
  };
  return (
    <input
      className="text-input"
      value={text}
      aria-label="Sketch adı"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          skip.current = true;
          setText(data.name);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function StatusSection() {
  const status = useSketchUi((s) => s.status);
  const ready = useSketchUi((s) => s.solverReady);
  const error = useSketchUi((s) => s.solverError);
  let cls = 'unknown';
  let text: ReactNode;
  if (error) {
    cls = 'bad';
    text = `Çözücü yüklenemedi: ${error}`;
  } else if (!ready || !status.known) {
    text = 'Çözücü hazır değil — kısıtlar kaydedilir ama çözülmez.';
  } else if (!status.ok || status.conflicting.length) {
    cls = 'bad';
    text = 'Çelişkili kısıt var';
  } else if (status.dof === 0) {
    cls = 'ok';
    text = 'Tam tanımlı';
  } else {
    cls = 'free';
    text = status.dof < 0 ? 'Eksik tanımlı' : `${status.dof} serbestlik derecesi`;
  }
  return (
    <section className="prop-section">
      <div className={`sk-insp-status ${cls}`}>
        <span className="sk-insp-status-dot" />
        <span>{text}</span>
      </div>
      {status.known && status.redundant.length > 0 && (
        <div className="prop-note warn">{status.redundant.length} gereksiz kısıt var.</div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Seçim özellikleri

function setPts(d: SketchFeature, pos: Map<string, Vec2>): SketchFeature {
  return {
    ...d,
    entities: d.entities.map((e) => {
      if (e.kind !== 'point') return e;
      const p = pos.get(e.id);
      return p ? { ...e, x: p[0], y: p[1] } : e;
    }),
  };
}

/** Noktayı sürükleme gibi konuma çeker */
function movePoint(id: string, p: Vec2) {
  applySketch((d) => setPts(d, new Map([[id, p]])), {
    drag: { pointId: id, x: p[0], y: p[1] },
    failMessage: 'Nokta bu konuma taşınamadı (kısıtlar izin vermiyor).',
  });
}

function setLineLength(lineId: string, L: number) {
  if (!(L > 0)) return;
  const d = currentSketch();
  if (!d) return;
  const existing = findConstraint(d, 'distance', [lineId]);
  if (existing) {
    setConstraintValue(existing.id, L);
    return;
  }
  const line = d.entities.find((e) => e.id === lineId);
  if (!line || line.kind !== 'line') return;
  const lp = linePts(line, pointMap(d.entities));
  if (!lp) return;
  const p2 = add(lp[0], mul(norm(sub(lp[1], lp[0])), L));
  const c: SkConstraint = { id: newId('k', d), type: 'distance', refs: [lineId], value: L };
  applySketch((x) => addItems(setPts(x, new Map([[line.p2, p2]])), [], [c]), {
    failMessage: 'Uzunluk ölçüsü eklenemedi: kısıtlar çelişiyor.',
  });
}

function setLineAngle(lineId: string, deg: number) {
  const d = currentSketch();
  const line = d?.entities.find((e) => e.id === lineId);
  if (!d || !line || line.kind !== 'line') return;
  const lp = linePts(line, pointMap(d.entities));
  if (!lp) return;
  const L = dist(lp[0], lp[1]);
  const a = (deg * Math.PI) / 180;
  movePoint(line.p2, [lp[0][0] + L * Math.cos(a), lp[0][1] + L * Math.sin(a)]);
}

function setRadius(id: string, r: number) {
  if (!(r > 0)) return;
  const d = currentSketch();
  if (!d) return;
  const rc = findConstraint(d, 'radius', [id]);
  if (rc) {
    setConstraintValue(rc.id, r);
    return;
  }
  const dc = findConstraint(d, 'diameter', [id]);
  if (dc) {
    setConstraintValue(dc.id, 2 * r);
    return;
  }
  const ent = d.entities.find((e) => e.id === id);
  if (!ent || (ent.kind !== 'circle' && ent.kind !== 'arc')) return;
  const c: SkConstraint = { id: newId('k', d), type: ent.kind === 'circle' ? 'diameter' : 'radius', refs: [id], value: ent.kind === 'circle' ? 2 * r : r };
  applySketch(
    (x) => {
      let out: SketchFeature = { ...x, entities: x.entities.map((e) => (e.id === id ? { ...ent, r } : e)) };
      if (ent.kind === 'arc') {
        const a = arcAngles(ent, pointMap(x.entities));
        if (a) {
          out = setPts(
            out,
            new Map([
              [ent.start, [a.c[0] + r * Math.cos(a.a0), a.c[1] + r * Math.sin(a.a0)]],
              [ent.end, [a.c[0] + r * Math.cos(a.a0 + a.sweep), a.c[1] + r * Math.sin(a.a0 + a.sweep)]],
            ]),
          );
        }
      }
      return addItems(out, [], [c]);
    },
    { failMessage: 'Yarıçap ölçüsü eklenemedi: kısıtlar çelişiyor.' },
  );
}

function SelectionSection({ data }: { data: SketchFeature }) {
  const sel = useSketchUi((s) => s.sel);
  const ents = useMemo(() => {
    const m = new Map(data.entities.map((e) => [e.id, e]));
    return sel.map((id) => m.get(id)).filter((e): e is SkEntity => !!e);
  }, [sel, data.entities]);
  if (!ents.length) {
    return (
      <section className="prop-section">
        <div className="prop-title">Seçim</div>
        <div className="sk-empty">Özellikleri görmek için bir öğe seçin.</div>
      </section>
    );
  }
  if (ents.length > 1) {
    const curves = ents.filter(isCurve);
    return (
      <section className="prop-section">
        <div className="prop-title">Seçim</div>
        <div className="sk-empty">{ents.length} öğe seçili. İlişkiler üst araç çubuğunda.</div>
        {curves.length > 0 && (
          <label className="checkbox sk-check">
            <input type="checkbox" checked={curves.every((c) => c.construction)} onChange={() => toggleConstruction(curves.map((c) => c.id))} />
            Yardımcı geometri
          </label>
        )}
      </section>
    );
  }
  const e = ents[0];
  const pm = pointMap(data.entities);
  return (
    <section className="prop-section">
      <div className="prop-title">{entityName(data, e.id)}</div>
      {e.kind === 'point' && (
        <div className="sk-fields">
          <NumField label="X" axis={0} value={e.x} unit="mm" onCommit={(v) => movePoint(e.id, [v, e.y])} />
          <NumField label="Y" axis={1} value={e.y} unit="mm" onCommit={(v) => movePoint(e.id, [e.x, v])} />
        </div>
      )}
      {e.kind === 'line' &&
        (() => {
          const lp = linePts(e, pm);
          if (!lp) return null;
          const d = sub(lp[1], lp[0]);
          const ang = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
          return (
            <div className="sk-fields">
              <NumField label="Uzunluk" value={dist(lp[0], lp[1])} unit="mm" min={1e-6} onCommit={(v) => setLineLength(e.id, v)} />
              <NumField label="Açı" value={ang} unit="°" digits={2} onCommit={(v) => setLineAngle(e.id, v)} />
            </div>
          );
        })()}
      {(e.kind === 'circle' || e.kind === 'arc') &&
        (() => {
          const c = pm.get(e.c);
          const a = e.kind === 'arc' ? arcAngles(e, pm) : null;
          return (
            <div className="sk-fields">
              <NumField label="Yarıçap" value={e.r} unit="mm" min={1e-6} onCommit={(v) => setRadius(e.id, v)} />
              {c && (
                <>
                  <NumField label="Merkez X" axis={0} value={c.x} unit="mm" onCommit={(v) => movePoint(c.id, [v, c.y])} />
                  <NumField label="Merkez Y" axis={1} value={c.y} unit="mm" onCommit={(v) => movePoint(c.id, [c.x, v])} />
                </>
              )}
              {a && (
                <div className="prop-line">
                  <span className="prop-label">Açıklık</span>
                  <span className="sk-ro">{fmt((a.sweep * 180) / Math.PI, 2)}°</span>
                </div>
              )}
            </div>
          );
        })()}
      {isCurve(e) && (
        <label className="checkbox sk-check">
          <input type="checkbox" checked={!!e.construction} onChange={() => toggleConstruction([e.id])} />
          Yardımcı geometri
        </label>
      )}
      {e.kind === 'point' && (
        <div className="prop-meta">
          {v2(e).every((x) => Math.abs(x) < 1e-9) ? 'Orijinde' : `Orijine uzaklık ${fmt(Math.hypot(e.x, e.y))} mm`}
        </div>
      )}
    </section>
  );
}

function NumField({
  label,
  value,
  unit,
  onCommit,
  axis,
  digits = 3,
  min,
}: {
  label: string;
  value: number;
  unit: string;
  onCommit: (v: number) => void;
  axis?: number;
  digits?: number;
  min?: number;
}) {
  const shown = fmt(value, digits);
  const [text, setText] = useState(shown);
  const [focus, setFocus] = useState(false);
  const skip = useRef(false);
  useEffect(() => {
    if (!focus) setText(shown);
  }, [shown, focus]);
  const commit = () => {
    if (skip.current) {
      skip.current = false;
      setText(shown);
      return;
    }
    const v = parseNum(text);
    if (v === null || (min !== undefined && v < min)) {
      setText(shown);
      return;
    }
    if (fmt(v, digits) !== shown) onCommit(v);
  };
  return (
    <div className="sk-field">
      <span className={`sk-field-label ${axis !== undefined ? `axis-${axis}` : ''}`}>{label}</span>
      <div className="num-field num-single">
        <input
          value={text}
          inputMode="decimal"
          aria-label={label}
          onFocus={(e) => {
            setFocus(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocus(false);
            commit();
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              skip.current = true;
              e.currentTarget.blur();
            }
          }}
        />
        <span className="num-unit">{unit}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Kısıt listesi

function ConstraintSection({ data }: { data: SketchFeature }) {
  const sel = useSketchUi((s) => s.sel);
  const hover = useSketchUi((s) => s.hover);
  const conflicting = useSketchUi((s) => s.status.conflicting);
  const redundant = useSketchUi((s) => s.status.redundant);
  const conf = useMemo(() => new Set(conflicting), [conflicting]);
  const red = useMemo(() => new Set(redundant), [redundant]);
  const selSet = useMemo(() => new Set(sel), [sel]);
  // Seçili varlık varsa onların kısıtları önce
  const list = useMemo(() => {
    const ents = new Set(sel);
    const rel = data.constraints.filter((c) => c.refs.some((r) => ents.has(r)));
    const rest = data.constraints.filter((c) => !c.refs.some((r) => ents.has(r)));
    return [...rel, ...rest];
  }, [data.constraints, sel]);
  return (
    <section className="prop-section">
      <div className="prop-title">
        Kısıtlar <span className="unit">{data.constraints.length}</span>
      </div>
      {!list.length ? (
        <div className="sk-empty">Henüz kısıt yok. Öğe seçip üst çubuktan ilişki ekleyin ya da Ölçü aracını (D) kullanın.</div>
      ) : (
        <ul className="sk-clist">
          {list.map((c) => (
            <ConstraintRow
              key={c.id}
              c={c}
              data={data}
              selected={selSet.has(c.id)}
              related={c.refs.some((r) => selSet.has(r))}
              hovered={hover === c.id}
              conflict={conf.has(c.id)}
              redundant={red.has(c.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConstraintRow({
  c,
  data,
  selected,
  related,
  hovered,
  conflict,
  redundant,
}: {
  c: SkConstraint;
  data: SketchFeature;
  selected: boolean;
  related: boolean;
  hovered: boolean;
  conflict: boolean;
  redundant: boolean;
}) {
  const refs = c.refs.map((r) => entityName(data, r)).join(', ');
  const cls = ['sk-crow', selected && 'selected', related && 'related', hovered && 'hovered', conflict && 'conflict']
    .filter(Boolean)
    .join(' ');
  return (
    <li
      className={cls}
      onPointerEnter={() => setHover(c.id)}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelected(c.id);
        else setSelection([c.id]);
      }}
      title={conflict ? 'Çelişkili kısıt' : redundant ? 'Gereksiz kısıt' : undefined}
    >
      <span className="sk-crow-icon">
        <ConstraintIcon type={c.type} size={13} />
      </span>
      <span className="sk-crow-body">
        <span className="sk-crow-name">
          {constraintLabel(c.type)}
          {redundant && <span className="sk-crow-flag">gereksiz</span>}
        </span>
        <span className="sk-crow-refs">{refs || 'orijin'}</span>
      </span>
      {isDimension(c.type) && <ValueInput c={c} />}
      <button
        type="button"
        className="sk-crow-del"
        title="Kısıtı sil"
        aria-label="Kısıtı sil"
        onClick={(e) => {
          e.stopPropagation();
          applySketch((d) => removeItems(d, [c.id]), { allowFail: true });
        }}
      >
        <IconTrash size={13} />
      </button>
    </li>
  );
}

function ValueInput({ c }: { c: SkConstraint }) {
  const shown = c.expr ?? fmt(c.value ?? 0, 3);
  const [text, setText] = useState(shown);
  const [focus, setFocus] = useState(false);
  const skip = useRef(false);
  useEffect(() => {
    if (!focus) setText(shown);
  }, [shown, focus]);
  const commit = () => {
    if (skip.current) {
      skip.current = false;
      setText(shown);
      return;
    }
    if (text.trim() === shown) return;
    // Sayı, ifade (FFH - 40) ya da "=AD" (yeni parametre)
    const r = resolveExprInput(text, c.value ?? 0, c.type === 'angle' ? 'deg' : 'mm');
    if (!r || !setConstraintValue(c.id, c.type === 'angle' ? r.value : Math.abs(r.value), r.expr)) setText(shown);
  };
  return (
    <span
      className={`sk-crow-val ${c.expr ? 'has-expr' : ''}`}
      onClick={(e) => e.stopPropagation()}
      title={c.expr ? `${c.expr} = ${fmt(c.value ?? 0, 3)}` : dimText(c)}
    >
      {c.expr && <span className="expr-badge">ƒx</span>}
      <input
        value={text}
        inputMode="decimal"
        aria-label={`${constraintLabel(c.type)} değeri`}
        onFocus={(e) => {
          setFocus(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocus(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            skip.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      <span className="sk-crow-unit">{c.type === 'angle' ? '°' : 'mm'}</span>
    </span>
  );
}
