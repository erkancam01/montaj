// Viewport üstündeki sketch DOM katmanı: ölçü etiketleri (çift tık: değer düzenle, sürükle: taşı),
// kısıt rozetleri, imleç ipucu, çizerken ölçü giriş kutusu ve kutu seçimi dikdörtgeni.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { SkConstraint, SketchFeature } from '../../modeling/types';
import {
  beginGesture,
  endGesture,
  isDimension,
  setConstraintLabel,
  setConstraintValue,
  setHover,
  setSelection,
  toggleSelected,
  constraintLabel,
  useSketchUi,
} from '../../sketch/session';
import { useAssembly } from '../../store/useAssembly';
import { resolveExprInput } from '../params/ExprField';
import { badgesOf, dimGeometry, type Badge, type DimGeom } from './annotations';
import { fmt, parseNum, pointMap } from './geom';
import { ConstraintIcon } from './sketchIcons';
import { commitTyped, setTyped, useDraw } from './tools';
import { clientToSketch, registerLabel, view } from './view';

export function SketchOverlay() {
  const data = useAssembly((s) => s.modeling.sketch?.data);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    view.overlay = ref.current;
    return () => {
      view.overlay = null;
    };
  }, []);
  return (
    <div className="sk-overlay" ref={ref}>
      {data && <Annotations data={data} />}
      <BoxRect />
      <CursorHint />
      <TypedBox />
    </div>
  );
}

// ---------------------------------------------------------------- Etiketler ve rozetler

function Annotations({ data }: { data: SketchFeature }) {
  const px = useDraw((s) => s.px);
  const previewDim = useDraw((s) => s.preview?.dim);
  const sel = useSketchUi((s) => s.sel);
  const hover = useSketchUi((s) => s.hover);
  const editing = useSketchUi((s) => s.editing);
  const conflicting = useSketchUi((s) => s.status.conflicting);
  const { dims, badges, byId } = useMemo(() => {
    const pm = pointMap(data.entities);
    const ents = new Map(data.entities.map((e) => [e.id, e]));
    const refs = { get: (id: string) => ents.get(id), pm };
    const dims: { g: DimGeom; c: SkConstraint }[] = [];
    for (const c of data.constraints) {
      if (!isDimension(c.type)) continue;
      const g = dimGeometry(c, refs, px);
      if (g) dims.push({ g, c });
    }
    return { dims, badges: badgesOf(data.constraints, refs), byId: new Map(data.constraints.map((c) => [c.id, c])) };
  }, [data.entities, data.constraints, px]);
  const previewGeom = useMemo(() => {
    if (!previewDim) return null;
    const ents = new Map(data.entities.map((e) => [e.id, e]));
    return dimGeometry(previewDim, { get: (id) => ents.get(id), pm: pointMap(data.entities) }, px);
  }, [previewDim, data.entities, px]);
  const conf = useMemo(() => new Set(conflicting), [conflicting]);
  return (
    <>
      {dims.map(({ g, c }) => (
        <DimLabel
          key={c.id}
          g={g}
          c={c}
          selected={sel.includes(c.id)}
          hovered={hover === c.id}
          conflict={conf.has(c.id)}
          editing={editing === c.id}
        />
      ))}
      {previewGeom && <StaticLabel id="__preview" g={previewGeom} />}
      {badges.map((b) => (
        <BadgeEl
          key={b.key}
          b={b}
          selected={sel.includes(b.cid)}
          hovered={hover === b.cid}
          conflict={conf.has(b.cid)}
          title={constraintLabel(byId.get(b.cid)?.type ?? b.type)}
        />
      ))}
    </>
  );
}

/** Kaydedilen etiket elemanı; konumu her karede SketchLayer günceller */
function useRegistered(key: string, p: [number, number], dx = 0, dy = 0) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    registerLabel(key, el.current, p, dx, dy);
  });
  useEffect(() => () => registerLabel(key, null, [0, 0]), [key]);
  return el;
}

function StaticLabel({ id, g }: { id: string; g: DimGeom }) {
  const el = useRegistered(id, g.label);
  return (
    <div ref={el} className="sk-dim preview">
      {g.text}
    </div>
  );
}

const DimLabel = memo(function DimLabel({
  g,
  c,
  selected,
  hovered,
  conflict,
  editing,
}: {
  g: DimGeom;
  c: SkConstraint;
  selected: boolean;
  hovered: boolean;
  conflict: boolean;
  editing: boolean;
}) {
  const el = useRegistered(c.id, g.label);
  const drag = useRef<{ x: number; y: number; moving: boolean } | null>(null);

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelected(c.id);
    else if (!selected) setSelection([c.id]);
    drag.current = { x: e.clientX, y: e.clientY, moving: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
      d.moving = true;
      beginGesture();
    }
    const p = clientToSketch(e.clientX, e.clientY);
    if (p) setConstraintLabel(c.id, p, false);
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (d?.moving) endGesture();
  };

  const cls = ['sk-dim', selected && 'selected', hovered && 'hovered', conflict && 'conflict', editing && 'editing']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      ref={el}
      className={cls}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerEnter={() => setHover(c.id)}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useSketchUi.setState({ editing: c.id, sel: [c.id] });
      }}
      title={`${constraintLabel(c.type)}${c.expr ? ` = ${c.expr}` : ''} — düzenlemek için çift tıklayın (sayı, ifade ya da =AD), taşımak için sürükleyin`}
    >
      {editing ? (
        <DimEditor c={c} />
      ) : c.expr ? (
        <>
          <span className="sk-dim-fx">ƒx</span>
          {g.text}
        </>
      ) : (
        g.text
      )}
    </div>
  );
});

function DimEditor({ c }: { c: SkConstraint }) {
  const [text, setText] = useState(() => c.expr ?? fmt(c.value ?? 0, 4));
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const close = () => useSketchUi.setState({ editing: null });
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const t = text.trim();
    if (t && t !== (c.expr ?? fmt(c.value ?? 0, 4))) {
      // Sayı, ifade (FFH - 40) ya da "=AD" (yeni parametre)
      const plain = parseNum(t);
      const r = plain !== null && !c.expr ? { value: plain, expr: undefined } : resolveExprInput(t, c.value ?? 0, c.type === 'angle' ? 'deg' : 'mm');
      if (r) setConstraintValue(c.id, c.type === 'angle' ? r.value : Math.abs(r.value), r.expr);
    }
    close();
  };
  const unit = c.type === 'angle' ? '°' : 'mm';
  return (
    <span className="sk-dim-edit" onPointerDown={(e) => e.stopPropagation()}>
      {c.type === 'radius' ? 'R' : c.type === 'diameter' ? 'Ø' : ''}
      <input
        ref={input}
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            done.current = true;
            close();
          }
        }}
        onBlur={commit}
        aria-label="Ölçü değeri"
      />
      <span className="sk-dim-unit">{unit}</span>
    </span>
  );
}

const BadgeEl = memo(function BadgeEl({
  b,
  selected,
  hovered,
  conflict,
  title,
}: {
  b: Badge;
  selected: boolean;
  hovered: boolean;
  conflict: boolean;
  title: string;
}) {
  const el = useRegistered(b.key, b.p, b.dx, b.dy);
  const cls = ['sk-badge', selected && 'selected', hovered && 'hovered', conflict && 'conflict'].filter(Boolean).join(' ');
  return (
    <div
      ref={el}
      className={cls}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelected(b.cid);
        else setSelection([b.cid]);
      }}
      onPointerEnter={() => setHover(b.cid)}
      onPointerLeave={() => setHover(null)}
    >
      <ConstraintIcon type={b.type} size={11} />
    </div>
  );
});

// ---------------------------------------------------------------- İmleç ipucu, giriş kutusu, kutu seçimi

function CursorHint() {
  const cursor = useDraw((s) => s.cursor);
  const hint = useDraw((s) => s.hint);
  const typed = useDraw((s) => s.typed);
  const tool = useSketchUi((s) => s.tool);
  const construction = useSketchUi((s) => s.construction);
  if (!cursor || tool === 'select' || (!hint && !construction) || typed) return null;
  return (
    <div className="sk-hint" style={{ transform: `translate(${cursor.x + 16}px, ${cursor.y + 18}px)` }}>
      {construction && tool !== 'dimension' && <span className="sk-hint-tag">Yardımcı</span>}
      {hint}
    </div>
  );
}

function TypedBox() {
  const typed = useDraw((s) => s.typed);
  const cursor = useDraw((s) => s.cursor);
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];
  const active = typed?.active ?? 0;
  useEffect(() => {
    const el = refs[active]?.current;
    if (el && document.activeElement !== el) {
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }
  }, [typed?.kind, active]); // refs sabit
  if (!typed) return null;
  const pos = cursor ?? { x: 40, y: 40 };
  const labels = typed.kind === 'rect' ? ['G', 'Y'] : typed.kind === 'circle' ? ['R'] : ['L'];
  const titles = typed.kind === 'rect' ? ['Genişlik', 'Yükseklik'] : typed.kind === 'circle' ? ['Yarıçap'] : ['Uzunluk'];
  const onKey = (i: number) => (e: RKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTyped();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTyped(null);
    } else if (e.key === 'Tab' && typed.values.length > 1) {
      e.preventDefault();
      setTyped({ ...typed, active: (i + (e.shiftKey ? typed.values.length - 1 : 1)) % typed.values.length });
    }
  };
  return (
    <div
      className="sk-typed"
      style={{ transform: `translate(${pos.x + 18}px, ${pos.y + 20}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {typed.values.map((v, i) => (
        <label key={i} className={`sk-typed-field ${i === active ? 'active' : ''}`} title={titles[i]}>
          <span className="sk-typed-label">{labels[i]}</span>
          <input
            ref={refs[i]}
            value={v}
            inputMode="decimal"
            onFocus={() => i !== active && setTyped({ ...typed, active: i })}
            onChange={(e) => {
              const values = [...typed.values];
              values[i] = e.target.value;
              setTyped({ ...typed, values });
            }}
            onKeyDown={onKey(i)}
            aria-label={titles[i]}
          />
          {i === 0 && typed.values.length > 1 && <span className="sk-typed-x">×</span>}
        </label>
      ))}
      <span className="sk-typed-unit">mm</span>
      <span className="sk-typed-help">
        <kbd>Enter</kbd>
        {typed.values.length > 1 && <kbd>Tab</kbd>}
      </span>
    </div>
  );
}

function BoxRect() {
  const box = useDraw((s) => s.box);
  if (!box) return null;
  const crossing = box.x1 < box.x0;
  const x = Math.min(box.x0, box.x1);
  const y = Math.min(box.y0, box.y1);
  return (
    <div
      className={`sk-box ${crossing ? 'crossing' : ''}`}
      style={{ left: x, top: y, width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
    />
  );
}
