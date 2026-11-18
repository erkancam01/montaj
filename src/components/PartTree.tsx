import { memo, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { geometryCache } from '../lib/geometryCache';
import { viewerApi } from '../lib/viewerApi';
import { clickPart, setVisible } from '../store/actions';
import { useAssembly } from '../store/useAssembly';
import type { Mate, Part } from '../types';
import { extraKeys, groupByPart, groupColor, GroupList, isAdditive } from './GroupList';
import { IconChevron, IconEye, IconEyeOff, IconLink } from './icons';
import { MateList } from './MateList';
import { FeatureTree } from './modeling/FeatureTree';

/** Parçaları otomatik kapalı başlatma eşiği */
const COLLAPSE_THRESHOLD = 40;

interface PartIndex {
  byId: Map<string, Part>;
  byInstance: Map<string, string[]>;
}

// parts dizisi değişmedikçe (referans) aynı indeks kullanılır; tüm satır seçicileri O(1) arar.
const partIndexCache = new WeakMap<Part[], PartIndex>();
function partIndex(parts: Part[]): PartIndex {
  let idx = partIndexCache.get(parts);
  if (!idx) {
    const byId = new Map<string, Part>();
    const byInstance = new Map<string, string[]>();
    for (const p of parts) {
      byId.set(p.id, p);
      const list = byInstance.get(p.instanceId);
      if (list) list.push(p.id);
      else byInstance.set(p.instanceId, [p.id]);
    }
    idx = { byId, byInstance };
    partIndexCache.set(parts, idx);
  }
  return idx;
}

const EMPTY_IDS: string[] = [];

// Bir mate'in hareketli (b) tarafı olan parçalar; mates dizisi değişmedikçe aynı küme
const movingCache = new WeakMap<Mate[], Set<string>>();
function movingParts(mates: Mate[]): Set<string> {
  let set = movingCache.get(mates);
  if (!set) {
    set = new Set(mates.map((m) => m.b.partId));
    movingCache.set(mates, set);
  }
  return set;
}

/** Instance satırı: değiştirici tuşlar ek seçim yapmaz, her zaman normal seçim */
function selectInstance(id: string) {
  useAssembly.getState().select({ kind: 'instance', id });
}

function focusInstance(id: string) {
  selectInstance(id);
  viewerApi.fit('selection');
}

/** Parça satırı: gruptaki parçanın da kendisini seçer; Ctrl/Shift ek seçime ekler/çıkarır */
function selectPartRow(id: string, additive: boolean) {
  clickPart(id, { direct: true, additive });
}

function focusPartRow(id: string) {
  clickPart(id, { direct: true });
  viewerApi.fit('selection');
}

function useScrollIntoView(selected: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return ref;
}

function EyeButton({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="tree-eye"
      title={visible ? 'Gizle (H)' : 'Göster (H)'}
      aria-label={visible ? 'Gizle' : 'Göster'}
      aria-pressed={!visible}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {visible ? <IconEye /> : <IconEyeOff />}
    </button>
  );
}

export function PartTree() {
  const instanceIds = useAssembly(useShallow((s) => s.doc.instances.map((i) => i.id)));
  const total = useAssembly((s) => s.doc.parts.length);

  return (
    <aside className="panel tree-panel">
      <header className="panel-header">
        <span>Montaj ağacı</span>
        <span className="panel-meta">{total} parça</span>
      </header>
      <FeatureTree />
      <div className="panel-body tree" role="tree" aria-label="Montaj ağacı">
        {instanceIds.length === 0 ? (
          <div className="empty-hint">Henüz parça yok</div>
        ) : (
          instanceIds.map((id) => <InstanceRow key={id} id={id} />)
        )}
      </div>
      <GroupList />
      <MateList />
    </aside>
  );
}

const InstanceRow = memo(function InstanceRow({ id }: { id: string }) {
  const info = useAssembly(
    useShallow((s) => {
      const inst = s.doc.instances.find((i) => i.id === id);
      const fs = inst ? s.fileStatus[inst.fileId] : undefined;
      const sel = s.selection;
      const idx = partIndex(s.doc.parts);
      const inInst = (pid: string) => idx.byId.get(pid)?.instanceId === id;
      return {
        name: inst?.name ?? '',
        visible: inst?.visible ?? true,
        status: fs?.status,
        error: fs?.error,
        selected: sel?.kind === 'instance' && sel.id === id,
        containsSel:
          (sel?.kind === 'part' && inInst(sel.id)) || s.extraSel.some((e) => e.kind === 'part' && inInst(e.id)),
      };
    }),
  );
  const partIds = useAssembly(useShallow((s) => partIndex(s.doc.parts).byInstance.get(id) ?? EMPTY_IDS));
  const [open, setOpen] = useState(() => partIds.length <= COLLAPSE_THRESHOLD);
  const rowRef = useScrollIntoView(info.selected);

  // Seçili parça kapalı bir grubun içindeyse grubu aç (ki satırı görünsün)
  useEffect(() => {
    if (info.containsSel) setOpen(true);
  }, [info.containsSel]);

  const cls = ['tree-row', 'tree-instance', info.selected && 'selected', !info.visible && 'hidden-item']
    .filter(Boolean)
    .join(' ');

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={info.selected}>
      <div
        ref={rowRef}
        className={cls}
        onClick={() => selectInstance(id)}
        onDoubleClick={() => focusInstance(id)}
      >
        <button
          type="button"
          className={`tree-toggle ${open ? 'open' : ''}`}
          aria-label={open ? 'Daralt' : 'Genişlet'}
          title={open ? 'Daralt' : 'Genişlet'}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <IconChevron size={12} />
        </button>
        <span className="tree-name" title={info.name}>
          {info.name}
        </span>
        {info.status === 'loading' && <span className="badge badge-loading">yükleniyor…</span>}
        {info.status === 'error' && (
          <span className="badge badge-error" title={info.error ?? 'Dosya ayrıştırılamadı'}>
            hata
          </span>
        )}
        <span className="tree-count" title={`${partIds.length} parça`}>
          {partIds.length}
        </span>
        <EyeButton visible={info.visible} onToggle={() => setVisible('instance', id, !info.visible)} />
      </div>
      {open && partIds.length > 0 && (
        <div role="group">
          {partIds.map((pid) => (
            <PartRow key={pid} id={pid} parentVisible={info.visible} />
          ))}
        </div>
      )}
    </div>
  );
});

const PartRow = memo(function PartRow({ id, parentVisible }: { id: string; parentVisible: boolean }) {
  const info = useAssembly(
    useShallow((s) => {
      const p = partIndex(s.doc.parts).byId.get(id);
      const sel = s.selection;
      const extra = extraKeys(s.extraSel);
      const g = groupByPart(s.doc.groups).get(id);
      return {
        name: p?.name ?? '',
        visible: p?.visible ?? true,
        color: p?.color ?? null,
        fileId: p?.fileId ?? '',
        nodeKey: p?.nodeKey ?? -1,
        // geometryCache reaktif değil; dosya hazır olunca yol bilgisini okumak için yeniden çiz
        ready: p ? s.fileStatus[p.fileId]?.status === 'ready' : false,
        selected: sel?.kind === 'part' && sel.id === id,
        extra: extra.has(`part:${id}`),
        groupId: g?.id ?? null,
        groupName: g?.name ?? '',
        /** Parçanın grubu seçili (birincil ya da ek) */
        groupSel: !!g && ((sel?.kind === 'group' && sel.id === g.id) || extra.has(`group:${g.id}`)),
        mated: movingParts(s.doc.mates).has(id),
      };
    }),
  );
  const rowRef = useScrollIntoView(info.selected);

  const node = info.ready ? geometryCache.get(info.fileId)?.nodes[info.nodeKey] : undefined;
  const title = node && node.path.length ? [...node.path, node.name].join(' / ') : info.name;
  const dim = !info.visible || !parentVisible;
  const cls = [
    'tree-row',
    'tree-part',
    (info.selected || info.extra) && 'selected',
    info.extra && 'extra',
    !info.selected && !info.extra && info.groupSel && 'group-selected',
    dim && 'hidden-item',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-selected={info.selected || info.extra}
      className={cls}
      onClick={(e) => selectPartRow(id, isAdditive(e))}
      onDoubleClick={(e) => {
        if (!isAdditive(e)) focusPartRow(id);
      }}
    >
      <span
        className={`tree-swatch ${info.color ? '' : 'none'}`}
        style={info.color ? { background: info.color } : undefined}
        aria-hidden="true"
      />
      <span className="tree-name" title={title}>
        {info.name}
      </span>
      {info.groupId && (
        <span
          className="tree-group-dot"
          style={{ background: groupColor(info.groupId) }}
          title={`Grup: ${info.groupName}`}
          aria-label={`Grup: ${info.groupName}`}
          role="img"
        />
      )}
      {info.mated && (
        <span className="tree-link" title="Mate ile bağlı" aria-label="Mate ile bağlı" role="img">
          <IconLink size={12} />
        </span>
      )}
      <EyeButton visible={info.visible} onToggle={() => setVisible('part', id, !info.visible)} />
    </div>
  );
});
