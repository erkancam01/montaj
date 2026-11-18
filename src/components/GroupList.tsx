// Montaj ağacının altındaki "Gruplar" bölümü ve grup yardımcıları (ağaç, mate listesi ve Inspector da kullanır).
import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { viewerApi } from '../lib/viewerApi';
import { toggleVisible, ungroup } from '../store/actions';
import { useAssembly, type AssemblyState } from '../store/useAssembly';
import type { ExtraSel, Group, Part } from '../types';
import { IconChevron, IconEye, IconEyeOff, IconUngroup } from './icons';

// ---------- ortak yardımcılar ----------

/** Grup göstergesi renkleri (vurgu mavisinden ayrışır) */
const GROUP_COLORS = ['#d9a441', '#b57bee', '#3fb8af', '#e8798a', '#8fbf4d', '#e08a4f', '#5ab0e6', '#c9a0ff'];

/** Grup id'sinden kararlı gösterge rengi */
export function groupColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GROUP_COLORS[Math.abs(h) % GROUP_COLORS.length];
}

// groups dizisi değişmedikçe aynı parça → grup tablosu kullanılır
const byPartCache = new WeakMap<Group[], Map<string, Group>>();
export function groupByPart(groups: Group[]): Map<string, Group> {
  let m = byPartCache.get(groups);
  if (!m) {
    m = new Map();
    for (const g of groups) for (const pid of g.partIds) m.set(pid, g);
    byPartCache.set(groups, m);
  }
  return m;
}

// extraSel dizisi değişmedikçe aynı "kind:id" kümesi
const extraKeyCache = new WeakMap<ExtraSel[], Set<string>>();
export function extraKeys(extra: ExtraSel[]): Set<string> {
  let set = extraKeyCache.get(extra);
  if (!set) {
    set = new Set(extra.map((e) => `${e.kind}:${e.id}`));
    extraKeyCache.set(extra, set);
  }
  return set;
}

// parts dizisi değişmedikçe aynı parça tablosu
const partMapCache = new WeakMap<Part[], Map<string, Part>>();
export function partMap(parts: Part[]): Map<string, Part> {
  let m = partMapCache.get(parts);
  if (!m) {
    m = new Map(parts.map((p) => [p.id, p]));
    partMapCache.set(parts, m);
  }
  return m;
}

/** Çözülecek grup: birincil seçim grupsa o, değilse ek seçimdeki ilk grup */
export function selectedGroupId(s: Pick<AssemblyState, 'selection' | 'extraSel'>): string | null {
  if (s.selection?.kind === 'group') return s.selection.id;
  return s.extraSel.find((e) => e.kind === 'group')?.id ?? null;
}

/** Ctrl / Cmd / Shift basılı tık: ek seçime ekle / çıkar */
export const isAdditive = (e: MouseEvent) => e.ctrlKey || e.metaKey || e.shiftKey;

// ---------- liste ----------

export function GroupList() {
  const ids = useAssembly(useShallow((s) => s.doc.groups.map((g) => g.id)));
  const hasGroupSel = useAssembly((s) => s.selection?.kind === 'group');
  const [open, setOpen] = useState(true);

  // Bir grup seçilince (ör. sahnede tıklanınca ya da yeni gruplanınca) bölümü aç
  useEffect(() => {
    if (hasGroupSel) setOpen(true);
  }, [hasGroupSel]);

  return (
    <section className={`mate-section group-section ${open ? 'open' : ''}`} aria-label="Gruplar">
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
        <span className="mate-section-title">Gruplar ({ids.length})</span>
      </button>
      {open && (
        <div className="mate-list" role="list">
          {ids.length === 0 ? (
            <div className="empty-hint">Henüz grup yok. Parçaları Ctrl+tık ile seçip Grupla (Ctrl+G) deyin.</div>
          ) : (
            ids.map((id) => <GroupRow key={id} id={id} />)
          )}
        </div>
      )}
    </section>
  );
}

const GroupRow = memo(function GroupRow({ id }: { id: string }) {
  const info = useAssembly(
    useShallow((s) => {
      const g = s.doc.groups.find((x) => x.id === id);
      const parts = partMap(s.doc.parts);
      return {
        exists: !!g,
        name: g?.name ?? '',
        count: g?.partIds.length ?? 0,
        visible: g ? g.partIds.some((pid) => parts.get(pid)?.visible) : true,
        selected: s.selection?.kind === 'group' && s.selection.id === id,
        extra: extraKeys(s.extraSel).has(`group:${id}`),
      };
    }),
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (info.selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [info.selected]);

  if (!info.exists) return null;

  const cls = ['tree-row', 'group-row', (info.selected || info.extra) && 'selected', info.extra && 'extra', !info.visible && 'hidden-item']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref}
      role="listitem"
      aria-selected={info.selected || info.extra}
      className={cls}
      onClick={(e) => {
        const st = useAssembly.getState();
        if (isAdditive(e)) st.toggleExtra({ kind: 'group', id });
        else st.select({ kind: 'group', id });
      }}
      onDoubleClick={(e) => {
        if (isAdditive(e)) return;
        useAssembly.getState().select({ kind: 'group', id });
        viewerApi.fit('selection');
      }}
    >
      <span className="group-dot" style={{ background: groupColor(id) }} aria-hidden="true" />
      <span className="tree-name" title={info.name}>
        {info.name}
      </span>
      <span className="tree-count" title={`${info.count} parça`}>
        {info.count}
      </span>
      <button
        type="button"
        className="tree-eye"
        title="Grubu çöz (parçalar yerinde kalır)"
        aria-label="Grubu çöz"
        onClick={(e) => {
          e.stopPropagation();
          ungroup(id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <IconUngroup size={14} />
      </button>
      <button
        type="button"
        className="tree-eye"
        title={info.visible ? 'Gizle (H)' : 'Göster (H)'}
        aria-label={info.visible ? 'Gizle' : 'Göster'}
        aria-pressed={!info.visible}
        onClick={(e) => {
          e.stopPropagation();
          toggleVisible({ kind: 'group', id });
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {info.visible ? <IconEye /> : <IconEyeOff />}
      </button>
    </div>
  );
});
