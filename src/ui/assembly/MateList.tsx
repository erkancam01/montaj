// Montaj ağacının altındaki "Mate'ler" bölümü ve mate durum yardımcıları (Inspector da kullanır).
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { MATE_LABELS } from '@/core/assembly/mateMeta';
import { updateMate } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import type { Mate, MateStatus, MateType, Part } from '@/core/types';
import { groupByPart } from '@/ui/assembly/GroupList';
import {
  IconChevron,
  IconEye,
  IconEyeOff,
  IconMateAngle,
  IconMateCoincident,
  IconMateConcentric,
  IconMateParallel,
  IconMatePerpendicular,
} from '@/ui/icons/icons';

// ---------- ortak yardımcılar ----------

export type MateState = MateStatus['state'];

/** Bastırma bayrağı önceliklidir; çözücü henüz durum üretmediyse 'pending' sayılır */
export function mateStateOf(mate: Pick<Mate, 'suppressed'>, status: MateStatus | undefined): MateState {
  if (mate.suppressed) return 'suppressed';
  return status?.state ?? 'pending';
}

export const MATE_STATE_LABELS: Record<MateState, string> = {
  ok: 'Sağlandı',
  error: 'Çözülemedi',
  pending: 'Geometri yükleniyor…',
  suppressed: 'Bastırıldı',
};

export function mateStateText(state: MateState, status: MateStatus | undefined): string {
  return state === 'error' ? (status?.message ?? MATE_STATE_LABELS.error) : MATE_STATE_LABELS[state];
}

const TYPE_ICONS: Record<MateType, (p: { size?: number }) => ReactNode> = {
  coincident: IconMateCoincident,
  concentric: IconMateConcentric,
  parallel: IconMateParallel,
  perpendicular: IconMatePerpendicular,
  angle: IconMateAngle,
};

export function MateTypeIcon({ type, size = 14 }: { type: MateType; size?: number }) {
  const Icon = TYPE_ICONS[type] ?? IconMateCoincident;
  return <Icon size={size} />;
}

// parts dizisi değişmedikçe aynı ad tablosu kullanılır
const nameCache = new WeakMap<Part[], Map<string, string>>();
function partNames(parts: Part[]): Map<string, string> {
  let m = nameCache.get(parts);
  if (!m) {
    m = new Map(parts.map((p) => [p.id, p.name]));
    nameCache.set(parts, m);
  }
  return m;
}

// ---------- liste ----------

export function MateList() {
  const ids = useAssembly(useShallow((s) => s.doc.mates.map((m) => m.id)));
  const hasMateSel = useAssembly((s) => s.mateSelection !== null);
  const [open, setOpen] = useState(true);

  // Bir mate seçilince (ör. sahnede yeni kurulunca) bölümü aç
  useEffect(() => {
    if (hasMateSel) setOpen(true);
  }, [hasMateSel]);

  return (
    <section className={`mate-section ${open ? 'open' : ''}`} aria-label="Mate'ler">
      <button
        type="button"
        className="mate-section-header"
        aria-expanded={open}
        title={open ? 'Daralt' : 'Genişlet'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`tree-toggle ${open ? 'open' : ''}`} aria-hidden="true">
          <IconChevron size={12} />
        </span>
        <span className="mate-section-title">Mate'ler ({ids.length})</span>
      </button>
      {open && (
        <div className="mate-list" role="list">
          {ids.length === 0 ? (
            <div className="empty-hint">Henüz mate yok. Araç çubuğundan Mate (M) ile iki yüzey seçin.</div>
          ) : (
            ids.map((id) => <MateRow key={id} id={id} />)
          )}
        </div>
      )}
    </section>
  );
}

const MateRow = memo(function MateRow({ id }: { id: string }) {
  const info = useAssembly(
    useShallow((s) => {
      const m = s.doc.mates.find((x) => x.id === id);
      const names = partNames(s.doc.parts);
      const status = s.mateStatus[id];
      return {
        exists: !!m,
        name: m?.name ?? '',
        type: m?.type ?? 'coincident',
        suppressed: m?.suppressed ?? false,
        aName: (m && names.get(m.a.partId)) ?? '?',
        bName: (m && names.get(m.b.partId)) ?? '?',
        /** Hareketli parça bir gruptaysa tüm grup hareket eder */
        bGroup: (m && groupByPart(s.doc.groups).get(m.b.partId)?.name) ?? null,
        state: m ? mateStateOf(m, status) : 'pending',
        message: status?.message,
        selected: s.mateSelection === id,
      };
    }),
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (info.selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [info.selected]);

  if (!info.exists) return null;

  const stateText = mateStateText(info.state, { state: info.state, message: info.message });
  const groupNote = info.bGroup ? ` (Grup: ${info.bGroup} — tüm grup hareket eder)` : '';
  const cls = ['mate-row', info.selected && 'selected', info.suppressed && 'suppressed', info.state === 'error' && 'has-error']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref}
      role="listitem"
      aria-selected={info.selected}
      className={cls}
      onClick={() => useAssembly.getState().selectMate(id)}
    >
      <span className="mate-type-icon" title={MATE_LABELS[info.type]}>
        <MateTypeIcon type={info.type} />
      </span>
      <div className="mate-row-body">
        <div className="mate-row-name" title={`${MATE_LABELS[info.type]} · ${info.name}`}>
          {info.name}
        </div>
        <div className="mate-row-parts" title={`Referans: ${info.aName} → Hareketli: ${info.bName}${groupNote}`}>
          {info.aName} → {info.bGroup ? `${info.bGroup} (grup)` : info.bName}
        </div>
      </div>
      <span className={`mate-dot state-${info.state}`} title={stateText} aria-label={stateText} role="img" />
      <button
        type="button"
        className="tree-eye"
        title={info.suppressed ? 'Etkinleştir' : 'Bastır'}
        aria-label={info.suppressed ? 'Etkinleştir' : 'Bastır'}
        aria-pressed={info.suppressed}
        onClick={(e) => {
          e.stopPropagation();
          updateMate(id, { suppressed: !info.suppressed });
        }}
      >
        {info.suppressed ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  );
});
