// Mate kurulunca imleç yanında açılan küçük mate araç kutusu: uygun türler, yönü çevir, mesafe / açı, ✓ ve ✕.
// ✓ mate'i kabul eder ve komutu açık bırakır (sıradaki iki yüzey seçilebilir); ✕ bu mate'i geri alır.
// Komutu bitirmek için sol paneldeki ✓ ya da Enter.
import { useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getFaceGeom } from '@/core/geometry/faceGeometry';
import { compatibleTypes, MATE_HINTS, MATE_LABELS } from '@/core/assembly/mateMeta';
import { mateExprKey } from '@/core/modeling/params';
import type { FaceGeom, FaceRef, MateType, Part } from '@/core/types';
import { removeMate, updateMate } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import { useCommandUi } from '@/ui/commands/commandStore';
import { MateTypeIcon } from '@/ui/assembly/MateList';
import { ExprField } from '@/ui/params/ExprField';
import { CIcon } from '@/ui/icons/commandIcons';
import { IconSwap } from '@/ui/icons/icons';
import '@/ui/shell/shell.css';

const FLIP_TYPES = new Set<MateType>(['coincident', 'concentric', 'parallel', 'angle']);

function geom(part: Part | undefined, ref: FaceRef): FaceGeom | null {
  if (!part) return null;
  try {
    return getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  } catch {
    return null;
  }
}

/** Kabul: araç kutusu kapanır, mate seçimi kalkar; mate aracı açık kalır */
export function acceptMatePopup() {
  useCommandUi.getState().set({ matePopup: null });
  useAssembly.getState().selectMate(null);
}

export function MatePopup() {
  const pop = useCommandUi((s) => s.matePopup);
  const { mate, partA, partB, snap, snapMove, snapAngle } = useAssembly(
    useShallow((s) => {
      const mate = pop ? s.doc.mates.find((m) => m.id === pop.mateId) : undefined;
      return {
        mate,
        partA: mate ? s.doc.parts.find((p) => p.id === mate.a.partId) : undefined,
        partB: mate ? s.doc.parts.find((p) => p.id === mate.b.partId) : undefined,
        snap: s.ui.snap,
        snapMove: s.ui.snapMove,
        snapAngle: s.ui.snapAngle,
      };
    }),
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!pop || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(pop.x + 14, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(pop.y + 14, window.innerHeight - r.height - 4)),
    });
  }, [pop]);
  if (!pop || !mate) return null;
  const ga = geom(partA, mate.a);
  const gb = geom(partB, mate.b);
  const types = ga && gb ? compatibleTypes(ga, gb) : [mate.type];
  return (
    <div
      ref={ref}
      className="mate-popup"
      role="toolbar"
      aria-label="Mate türü"
      style={pos ?? { left: pop.x + 14, top: pop.y + 14 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mate-popup-row">
        {types.map((t) => (
          <button
            key={t}
            type="button"
            className={`mate-popup-btn ${mate.type === t ? 'active' : ''}`}
            title={`${MATE_LABELS[t]}: ${MATE_HINTS[t]}`}
            aria-pressed={mate.type === t}
            onClick={() => updateMate(mate.id, { type: t })}
          >
            <MateTypeIcon type={t} size={16} />
          </button>
        ))}
        {FLIP_TYPES.has(mate.type) && (
          <button
            type="button"
            className={`mate-popup-btn ${mate.flip ? 'active' : ''}`}
            title="Hizalamayı çevir"
            aria-pressed={!!mate.flip}
            onClick={() => updateMate(mate.id, { flip: !mate.flip })}
          >
            <IconSwap size={15} />
          </button>
        )}
        <span className="mate-popup-sep" />
        <button type="button" className="mate-popup-btn ok" title="Mate'i ekle; sıradaki iki yüzeyi seçin" onClick={acceptMatePopup}>
          <CIcon name="done" size={16} />
        </button>
        <button
          type="button"
          className="mate-popup-btn cancel"
          title="Bu mate'i geri al"
          onClick={() => {
            useCommandUi.getState().set({ matePopup: null });
            removeMate(mate.id);
          }}
        >
          <CIcon name="close" size={14} />
        </button>
      </div>
      <div className="mate-popup-row mate-popup-info">
        <span className="mate-popup-name">{MATE_LABELS[mate.type]}</span>
        {mate.type === 'coincident' && (
          <label className="mate-popup-val" title="Yüzeyler arası mesafe (0 = çakışık)">
            Mesafe
            <ExprField
              value={mate.offset}
              expr={mate.offsetExpr}
              step={snap ? snapMove : 1}
              mergeKey={`mate-offset:${mate.id}`}
              errorKey={mateExprKey(mate.id, 'offset')}
              onCommit={({ value, expr }) => updateMate(mate.id, { offset: value, offsetExpr: expr })}
            />
          </label>
        )}
        {mate.type === 'angle' && (
          <label className="mate-popup-val">
            Açı
            <ExprField
              value={mate.angle ?? 0}
              expr={mate.angleExpr}
              unit="deg"
              step={snap ? snapAngle : 1}
              mergeKey={`mate-angle:${mate.id}`}
              errorKey={mateExprKey(mate.id, 'angle')}
              onCommit={({ value, expr }) => updateMate(mate.id, { angle: Math.min(180, Math.max(0, value)), angleExpr: expr })}
            />
          </label>
        )}
      </div>
    </div>
  );
}
