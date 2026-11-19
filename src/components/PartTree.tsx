// Sol panel. Normalde tek tasarım ağacı: montaj dosyaları → parçalar; çizilen parçalar açılınca özellik
// geçmişi; en altta Gruplar ve Mate'ler klasörleri. Bir sketch / özellik / mate komutu açıkken ağacın yerine
// o komutun ayarları (CommandPanel) gösterilir.
import { memo, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { geometryCache } from '../lib/geometryCache';
import { isPartFixed, usePartStatusMark } from '../lib/partStatus';
import { viewerApi } from '../lib/viewerApi';
import { enterBody, exitBody, renameBody } from '../modeling/actions';
import { clickPart, rename, setVisible } from '../store/actions';
import { useAssembly } from '../store/useAssembly';
import type { Mate, Part } from '../types';
import { bodyIdOfFile, isBodyFileId } from '../types';
import { CommandPanel, useCommandPanelOpen } from './command/CommandPanel';
import { commonPartEntries } from './command/menus';
import { PopupMenu, type MenuEntry } from './command/PopupMenu';
import { extraKeys, groupByPart, groupColor, GroupList, isAdditive } from './GroupList';
import { IconChevron, IconEye, IconEyeOff, IconLink } from './icons';
import { MateList } from './MateList';
import { FIcon } from './modeling/featureIcons';
import { BodyFeatureList, BuildBadge, RenameInput } from './modeling/FeatureTree';

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

/** Sabit (f) / eksik tanımlı (-) işareti */
function StatusMark({ partId }: { partId: string }) {
  const mark = usePartStatusMark(partId);
  if (!mark) return null;
  return (
    <span className={`tree-mark ${mark === '(f)' ? 'fixed' : 'under'}`} title={mark === '(f)' ? 'Sabit' : 'Serbest (eksik bağlı)'}>
      {mark}
    </span>
  );
}

type RowMenu = { x: number; y: number } | null;

export function PartTree() {
  const open = useCommandPanelOpen();
  return <aside className="panel tree-panel">{open ? <CommandPanel /> : <DesignTree />}</aside>;
}

function DesignTree() {
  const instanceIds = useAssembly(useShallow((s) => s.doc.instances.map((i) => i.id)));
  const total = useAssembly((s) => s.doc.parts.length);

  return (
    <>
      <header className="panel-header">
        <span>Tasarım ağacı</span>
        <span className="panel-meta">{total} parça</span>
      </header>
      <div className="panel-body tree utree" role="tree" aria-label="Tasarım ağacı">
        {instanceIds.length === 0 ? (
          <div className="empty-hint">Henüz parça yok. Dosya ekleyin ya da Özellikler › Yeni parça ile çizin.</div>
        ) : (
          instanceIds.map((id) => <InstanceRow key={id} id={id} />)
        )}
        <GroupList />
        <MateList />
      </div>
    </>
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
        fileId: inst?.fileId ?? '',
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
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<RowMenu>(null);
  const rowRef = useScrollIntoView(info.selected);

  // Seçili parça kapalı bir grubun içindeyse grubu aç (ki satırı görünsün)
  useEffect(() => {
    if (info.containsSel) setOpen(true);
  }, [info.containsSel]);

  // Çizilen parça: tek parçalı instance, özellik geçmişiyle birlikte gösterilir
  if (isBodyFileId(info.fileId) && partIds.length === 1) {
    return <BodyRow instanceId={id} partId={partIds[0]} bodyId={bodyIdOfFile(info.fileId)} instanceVisible={info.visible} />;
  }

  const cls = ['tree-row', 'tree-instance', info.selected && 'selected', !info.visible && 'hidden-item']
    .filter(Boolean)
    .join(' ');

  const entries: MenuEntry[] = [
    { heading: info.name },
    { label: info.visible ? 'Gizle' : 'Göster', icon: info.visible ? 'hide' : 'show', onClick: () => setVisible('instance', id, !info.visible) },
    { label: 'Odakla', icon: 'focus', onClick: () => focusInstance(id) },
    { label: 'Yeniden adlandır', icon: 'rename', onClick: () => setRenaming(true) },
    { label: open ? 'Daralt' : 'Genişlet', onClick: () => setOpen((o) => !o) },
  ];

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={info.selected}>
      <div
        ref={rowRef}
        className={cls}
        onClick={() => selectInstance(id)}
        onDoubleClick={() => focusInstance(id)}
        onContextMenu={(e) => {
          e.preventDefault();
          selectInstance(id);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
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
        <span className="tree-kind-icon" aria-hidden="true">
          <FIcon name="body" size={14} />
        </span>
        {renaming ? (
          <RenameInput
            value={info.name}
            onDone={(v) => {
              setRenaming(false);
              if (v !== null) rename('instance', id, v);
            }}
          />
        ) : (
          <span className="tree-name" title={info.name}>
            {info.name}
          </span>
        )}
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
      {menu && <PopupMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </div>
  );
});

/** Parça satırının ortak durum seçicisi */
function usePartInfo(id: string) {
  return useAssembly(
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
}

function PartBadges({ info }: { info: ReturnType<typeof usePartInfo> }) {
  return (
    <>
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
    </>
  );
}

function rowClass(info: ReturnType<typeof usePartInfo>, dim: boolean, extra: string) {
  return [
    'tree-row',
    extra,
    (info.selected || info.extra) && 'selected',
    info.extra && 'extra',
    !info.selected && !info.extra && info.groupSel && 'group-selected',
    dim && 'hidden-item',
  ]
    .filter(Boolean)
    .join(' ');
}

const PartRow = memo(function PartRow({ id, parentVisible }: { id: string; parentVisible: boolean }) {
  const info = usePartInfo(id);
  const rowRef = useScrollIntoView(info.selected);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<RowMenu>(null);

  const node = info.ready ? geometryCache.get(info.fileId)?.nodes[info.nodeKey] : undefined;
  const title = node && node.path.length ? [...node.path, node.name].join(' / ') : info.name;
  const dim = !info.visible || !parentVisible;

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        aria-selected={info.selected || info.extra}
        className={rowClass(info, dim, 'tree-part')}
        onClick={(e) => selectPartRow(id, isAdditive(e))}
        onDoubleClick={(e) => {
          if (!isAdditive(e)) focusPartRow(id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!info.selected && !info.extra) selectPartRow(id, false);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span
          className={`tree-swatch ${info.color ? '' : 'none'}`}
          style={info.color ? { background: info.color } : undefined}
          aria-hidden="true"
        />
        <StatusMark partId={id} />
        {renaming ? (
          <RenameInput
            value={info.name}
            onDone={(v) => {
              setRenaming(false);
              if (v !== null) rename('part', id, v);
            }}
          />
        ) : (
          <span className="tree-name" title={title}>
            {info.name}
          </span>
        )}
        <PartBadges info={info} />
        <EyeButton visible={info.visible} onToggle={() => setVisible('part', id, !info.visible)} />
      </div>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            { heading: info.name },
            { label: 'Yeniden adlandır', icon: 'rename', onClick: () => setRenaming(true) },
            ...commonPartEntries(id, info.visible, isPartFixed(id)),
          ]}
        />
      )}
    </>
  );
});

/** Çizilen (parametrik) parça: açılınca özellik geçmişi */
function BodyRow({ instanceId, partId, bodyId, instanceVisible }: { instanceId: string; partId: string; bodyId: string; instanceVisible: boolean }) {
  const info = usePartInfo(partId);
  const body = useAssembly(
    useShallow((s) => {
      const b = s.doc.bodies.find((x) => x.id === bodyId);
      const build = s.modeling.build[bodyId];
      return {
        name: b?.name ?? info.name,
        count: b?.features.length ?? 0,
        active: s.modeling.activeBodyId === bodyId,
        instSelected: s.selection?.kind === 'instance' && s.selection.id === instanceId,
        buildState: build?.state,
        nErr: build ? Object.keys(build.featureErrors).length : 0,
        buildMsg: build?.message,
        locked: !!s.modeling.sketch,
      };
    }),
  );
  const [open, setOpen] = useState(body.active);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<RowMenu>(null);
  const selected = info.selected || body.instSelected;
  const rowRef = useScrollIntoView(selected);

  // Düzenlemeye girince özellikleri göster
  useEffect(() => {
    if (body.active) setOpen(true);
  }, [body.active]);

  const dim = !info.visible || !instanceVisible;
  const cls = [rowClass(info, dim, 'tree-instance tree-body'), body.instSelected && 'selected', body.active && 'editing'].filter(Boolean).join(' ');
  const visible = info.visible && instanceVisible;

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={selected}>
      <div
        ref={rowRef}
        className={cls}
        title={body.active ? 'Düzenleniyor' : 'Çift tık: özellik geçmişini düzenle'}
        onClick={(e) => selectPartRow(partId, isAdditive(e))}
        onDoubleClick={() => {
          if (!body.active && !body.locked) enterBody(bodyId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!selected) selectPartRow(partId, false);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          type="button"
          className={`tree-toggle ${open ? 'open' : ''}`}
          aria-label={open ? 'Daralt' : 'Genişlet'}
          title={open ? 'Özellikleri gizle' : 'Özellikleri göster'}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <IconChevron size={12} />
        </button>
        <span className="tree-kind-icon body" aria-hidden="true">
          <FIcon name="body" size={14} />
        </span>
        <StatusMark partId={partId} />
        {renaming ? (
          <RenameInput
            value={body.name}
            onDone={(v) => {
              setRenaming(false);
              if (v !== null) renameBody(bodyId, v);
            }}
          />
        ) : (
          <span className="tree-name" title={body.name}>
            {body.name}
          </span>
        )}
        {body.active && <span className="tree-tag">düzenleniyor</span>}
        <BuildBadge state={body.buildState} nErr={body.nErr} message={body.buildMsg} />
        <PartBadges info={info} />
        <EyeButton visible={visible} onToggle={() => setVisible('part', partId, !info.visible)} />
      </div>
      {open && (
        <div role="group" className="tree-features">
          <BodyFeatureList bodyId={bodyId} />
        </div>
      )}
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            { heading: body.name },
            body.active
              ? { label: 'Düzenlemeyi bitir', icon: 'done', disabled: body.locked, onClick: () => exitBody() }
              : { label: 'Parçayı düzenle', icon: 'editPart', disabled: body.locked, onClick: () => enterBody(bodyId) },
            { label: 'Yeniden adlandır', icon: 'rename', onClick: () => setRenaming(true) },
            { label: open ? 'Özellikleri gizle' : 'Özellikleri göster', onClick: () => setOpen((o) => !o) },
            'sep',
            ...commonPartEntries(partId, info.visible, isPartFixed(partId)),
          ]}
        />
      )}
    </div>
  );
}
