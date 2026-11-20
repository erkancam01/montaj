// Tasarım kütüphanesi: sahnenin sağ kenarında açılır panel. STEP / IGES / BREP dosyaları tarayıcıda
// (projeden ayrı) saklanır; klasörlere ayrılır, sahneye sürüklenerek ya da çift tıklanarak montaja eklenir.
// Panele bilgisayardan dosya sürüklemek onları açık klasöre ekler.
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { folderPath, useLibrary, type LibFolder, type LibItem } from '@/state/libraryStore';
import { useAssembly } from '@/state/useAssembly';
import { downloadBlob } from '@/services/io/download';
import { CAD_EXTENSIONS } from '@/services/io/formats';
import {
  addFilesToLibrary,
  createFolder,
  exportLibraryZip,
  getItemFile,
  importLibraryZip,
  insertLibraryItem,
  loadLibrary,
  moveFolder,
  moveItems,
  removeFolder,
  removeItems,
  renameFolder,
  renameItem,
  storageInfo,
  type StorageInfo,
} from '@/services/io/library';
import { PopupMenu, type MenuEntry } from '@/ui/commands/PopupMenu';
import { CIcon } from '@/ui/icons/commandIcons';
import { IconClose, IconPlus } from '@/ui/icons/icons';
import { DND_FOLDER, DND_ITEM, dragHas, toggleLibrary, useLibraryUi } from '@/ui/library/libraryUi';
import '@/ui/library/library.css';

const toast = (t: string, kind?: 'error' | 'info') => useAssembly.getState().showToast(t, kind);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Sketch açıkken montaja dosya eklenmez */
function insertBlocked(): boolean {
  return !!useAssembly.getState().modeling.sketch;
}

export function insertItem(id: string) {
  if (insertBlocked()) {
    toast("Önce sketch'ten çıkın", 'error');
    return;
  }
  insertLibraryItem(id).catch((e: unknown) => toast(`Eklenemedi: ${errText(e)}`, 'error'));
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const stripExt = (n: string) => n.replace(/\.(step|stp|iges|igs|brep|brp)$/i, '');

const FolderIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5z" />
  </svg>
);

const NewFolderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M1.5 4.5v8a1 1 0 0 0 1 1h6M14.5 8V6a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5" />
    <path d="M12.5 10v4.5M10.25 12.25h4.5" />
  </svg>
);

const LibIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2" y="2.5" width="3.2" height="13" rx="0.6" />
    <rect x="6.6" y="2.5" width="3.2" height="13" rx="0.6" />
    <path d="M11.4 4.2l3-0.8 2.6 11.6-3 .8z" />
  </svg>
);

/** Panel kapalıyken sağ kenardaki sekme + açıkken panel */
export function LibraryDock() {
  const open = useLibraryUi((s) => s.open);
  useEffect(() => {
    void loadLibrary();
  }, []);
  return (
    <div className={`lib-dock ${open ? 'open' : ''}`} data-own-drop="">
      <button
        type="button"
        className={`lib-tab ${open ? 'on' : ''}`}
        aria-expanded={open}
        title={open ? 'Tasarım kütüphanesini kapat' : 'Tasarım kütüphanesi: kayıtlı parçaları sahneye sürükleyin'}
        onClick={toggleLibrary}
      >
        <LibIcon size={16} />
        <span>Kütüphane</span>
      </button>
      {open && <LibraryPanel />}
    </div>
  );
}

type Menu = { x: number; y: number; entries: MenuEntry[] } | null;

function LibraryPanel() {
  const folders = useLibrary((s) => s.folders);
  const items = useLibrary((s) => s.items);
  const loaded = useLibrary((s) => s.loaded);
  const busy = useLibrary((s) => s.busy);
  const folderId = useLibraryUi((s) => s.folderId);
  const setFolder = useLibraryUi((s) => s.setFolder);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [dropActive, setDropActive] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Gezilen klasör silindiyse köke dön
  useEffect(() => {
    if (folderId && loaded && !folders.some((f) => f.id === folderId)) setFolder(null);
  }, [folderId, folders, loaded, setFolder]);

  // Depolama kullanımı (öğe sayısı değişince yenilenir)
  useEffect(() => {
    let alive = true;
    void storageInfo().then((s) => alive && setStorage(s));
    return () => {
      alive = false;
    };
  }, [items.length]);

  const q = query.trim().toLocaleLowerCase('tr');
  const path = useMemo(() => folderPath(folders, folderId), [folders, folderId]);

  const shownFolders: LibFolder[] = q
    ? []
    : folders.filter((f) => f.parentId === folderId).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const shownItems: LibItem[] = (q
    ? items.filter((i) => i.name.toLocaleLowerCase('tr').includes(q))
    : items.filter((i) => i.folderId === folderId)
  ).sort((a, b) => a.name.localeCompare(b.name, 'tr'));

  const addFiles = (files: File[]) => {
    const zips = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
    const rest = files.filter((f) => !f.name.toLowerCase().endsWith('.zip'));
    for (const z of zips) importZip(z);
    if (rest.length) void addFilesToLibrary(rest, q ? null : folderId);
  };

  const importZip = (z: File) => {
    importLibraryZip(z)
      .then((n) => toast(`${n} parça kütüphaneye aktarıldı`, 'info'))
      .catch((e: unknown) => toast(`Kütüphane içe aktarılamadı: ${errText(e)}`, 'error'));
  };

  const newFolder = () => {
    const id = createFolder('Yeni klasör', folderId);
    setQuery('');
    setRenaming(id);
  };

  const exportZip = async () => {
    try {
      const blob = await exportLibraryZip();
      if (!blob) {
        toast('Kütüphane boş');
        return;
      }
      downloadBlob(blob, 'parca-kutuphanesi.zip');
    } catch (e) {
      toast(`Dışa aktarılamadı: ${errText(e)}`, 'error');
    }
  };

  // --- bırakma hedefi: panelin kendisi (bilgisayardan dosya) ---
  const onPanelDragEnter = (e: DragEvent) => {
    if (!dragHas(e, 'Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setDropActive(true);
  };
  const onPanelDragOver = (e: DragEvent) => {
    if (dragHas(e, 'Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    } else if (dragHas(e, DND_ITEM) || dragHas(e, DND_FOLDER)) {
      // Kendi öğesi panel boşluğuna bırakılırsa sahneye eklenmesin
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    }
  };
  const onPanelDragLeave = (e: DragEvent) => {
    if (!dragHas(e, 'Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropActive(false);
  };
  const onPanelDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDropActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) addFiles(files);
  };

  // --- öğe / klasör taşıma (klasör kutucuğuna ya da yol çubuğuna bırak) ---
  const moveDropProps = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragHas(e, DND_ITEM) && !dragHas(e, DND_FOLDER)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).classList.add('drop-over');
    },
    onDragLeave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-over'),
    onDrop: (e: DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove('drop-over');
      const item = e.dataTransfer.getData(DND_ITEM);
      const folder = e.dataTransfer.getData(DND_FOLDER);
      if (!item && !folder) return;
      e.preventDefault();
      e.stopPropagation();
      if (item) moveItems([item], target);
      if (folder && folder !== target && !moveFolder(folder, target)) toast('Klasör kendi içine taşınamaz', 'error');
    },
  });

  const itemMenu = (it: LibItem, x: number, y: number) => {
    setSelected(it.id);
    setMenu({
      x,
      y,
      entries: [
        { heading: stripExt(it.name) },
        { label: 'Montaja ekle', icon: 'addFile', primary: true, onClick: () => insertItem(it.id) },
        { label: 'Yeniden adlandır', icon: 'rename', onClick: () => setRenaming(it.id) },
        {
          label: 'Dosyayı indir',
          icon: 'export',
          onClick: () =>
            void getItemFile(it.id).then((f) => (f ? downloadBlob(f, it.name) : toast('Dosya bulunamadı', 'error'))),
        },
        ...(it.folderId
          ? [{ label: 'Köke taşı', icon: 'move' as const, onClick: () => moveItems([it.id], null) }]
          : []),
        'sep',
        {
          label: 'Kütüphaneden sil',
          icon: 'trash',
          danger: true,
          onClick: () => {
            if (window.confirm(`"${it.name}" kütüphaneden silinsin mi? (Montajdaki kopyalar etkilenmez)`)) void removeItems([it.id]);
          },
        },
      ],
    });
  };

  const folderMenu = (f: LibFolder, x: number, y: number) => {
    setMenu({
      x,
      y,
      entries: [
        { heading: f.name },
        { label: 'Aç', icon: 'show', onClick: () => setFolder(f.id) },
        { label: 'Yeniden adlandır', icon: 'rename', onClick: () => setRenaming(f.id) },
        'sep',
        {
          label: 'Klasörü sil',
          icon: 'trash',
          danger: true,
          onClick: () => {
            if (window.confirm(`"${f.name}" klasörü ve içindeki tüm parçalar kütüphaneden silinsin mi?`)) void removeFolder(f.id);
          },
        },
      ],
    });
  };

  const moreMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      entries: [
        { heading: 'Kütüphane' },
        { label: 'Kütüphaneyi dışa aktar (.zip)', icon: 'zip', title: 'Başka bilgisayara / tarayıcıya taşımak için', onClick: () => void exportZip() },
        { label: 'Kütüphane .zip içe aktar…', icon: 'addFile', onClick: () => zipInput.current?.click() },
      ],
    });

  const empty = loaded && !shownFolders.length && !shownItems.length;
  const total = items.length;

  return (
    <aside
      className={`panel lib-panel ${dropActive ? 'drop-active' : ''}`}
      aria-label="Tasarım kütüphanesi"
      onDragEnter={onPanelDragEnter}
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
    >
      <header className="panel-header">
        <span>Tasarım kütüphanesi</span>
        <span className="lib-head-right">
          <span className="panel-meta">{total} parça</span>
          <button type="button" className="lib-icon-btn" title="Kapat" aria-label="Kapat" onClick={toggleLibrary}>
            <IconClose size={14} />
          </button>
        </span>
      </header>

      <div className="lib-actions">
        <button type="button" className="lib-btn" title="Bilgisayardan STEP / IGES / BREP dosyası ekle" onClick={() => fileInput.current?.click()}>
          <IconPlus size={14} />
          <span>Dosya ekle</span>
        </button>
        <button type="button" className="lib-icon-btn" title="Yeni klasör" aria-label="Yeni klasör" onClick={newFolder}>
          <NewFolderIcon />
        </button>
        <button
          type="button"
          className="lib-icon-btn"
          title="Dışa / içe aktar"
          aria-label="Diğer"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            moreMenu(r.left, r.bottom + 2);
          }}
        >
          <CIcon name="menu" size={16} />
        </button>
        <input
          className="lib-search"
          type="search"
          placeholder="Ara…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Kütüphanede ara"
        />
      </div>

      <nav className="lib-path" aria-label="Klasör yolu">
        {q ? (
          <span className="lib-crumb current">Arama: {shownItems.length} sonuç</span>
        ) : (
          <>
            <Crumb current={!folderId} onClick={() => setFolder(null)} drop={moveDropProps(null)}>
              Kütüphane
            </Crumb>
            {path.map((f, i) => (
              <span key={f.id} className="lib-crumb-wrap">
                <span className="lib-crumb-sep">›</span>
                <Crumb current={i === path.length - 1} onClick={() => setFolder(f.id)} drop={moveDropProps(f.id)}>
                  {f.name}
                </Crumb>
              </span>
            ))}
          </>
        )}
      </nav>

      <div className="panel-body lib-body" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        {!loaded && <div className="empty-hint">Yükleniyor…</div>}
        {empty && (
          <div className="lib-empty">
            <LibIcon size={30} />
            {q ? (
              <p>Eşleşen parça yok.</p>
            ) : (
              <p>
                STEP / IGES / BREP dosyalarını buraya sürükleyin ya da <b>Dosya ekle</b>'ye basın.
                <br />
                Sonra parçayı sahneye sürükleyerek montaja ekleyin.
              </p>
            )}
          </div>
        )}
        <div className="lib-grid">
          {shownFolders.map((f) => (
            <FolderTile
              key={f.id}
              folder={f}
              count={items.filter((i) => i.folderId === f.id).length + folders.filter((x) => x.parentId === f.id).length}
              renaming={renaming === f.id}
              onRenamed={(name) => {
                setRenaming(null);
                if (name !== null) renameFolder(f.id, name);
              }}
              onOpen={() => setFolder(f.id)}
              onMenu={(x, y) => folderMenu(f, x, y)}
              drop={moveDropProps(f.id)}
            />
          ))}
          {shownItems.map((it) => (
            <ItemTile
              key={it.id}
              item={it}
              busy={!!busy[it.id]}
              selected={selected === it.id}
              renaming={renaming === it.id}
              onRenamed={(name) => {
                setRenaming(null);
                if (name !== null) renameItem(it.id, name);
              }}
              onSelect={() => setSelected(it.id)}
              onMenu={(x, y) => itemMenu(it, x, y)}
            />
          ))}
        </div>
        {dropActive && (
          <div className="lib-drop-hint">
            <IconPlus size={22} />
            <span>{path.length && !q ? `"${path[path.length - 1].name}" klasörüne ekle` : 'Kütüphaneye ekle'}</span>
          </div>
        )}
      </div>

      <footer className="lib-foot">
        <span>Sahneye sürükleyin ya da çift tıklayın</span>
        {storage && storage.quota > 0 && (
          <span
            className="lib-storage"
            title={`Bu sitenin tarayıcıda kullandığı alan (proje + kütüphane). Üst sınır tarayıcıya ve boş diske bağlıdır.${
              storage.persisted ? '\nKalıcı depolama açık: tarayıcı veriyi kendiliğinden silmez.' : '\nKalıcı depolama izni yok: disk dolarsa tarayıcı veriyi silebilir.'
            }`}
          >
            {fmtSize(storage.usage)} / {fmtSize(storage.quota)}
          </span>
        )}
      </footer>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={CAD_EXTENSIONS.join(',')}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) addFiles(files);
        }}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) importZip(f);
        }}
      />
      {menu && <PopupMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
    </aside>
  );
}

type DropProps = {
  onDragOver(e: DragEvent): void;
  onDragLeave(e: DragEvent): void;
  onDrop(e: DragEvent): void;
};

function Crumb({ current, onClick, drop, children }: { current: boolean; onClick(): void; drop: DropProps; children: ReactNode }) {
  return (
    <button type="button" className={`lib-crumb ${current ? 'current' : ''}`} onClick={onClick} {...drop}>
      {children}
    </button>
  );
}

function NameEdit({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="lib-name-edit"
      autoFocus
      value={v}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(v)}
    />
  );
}

function FolderTile({
  folder,
  count,
  renaming,
  onRenamed,
  onOpen,
  onMenu,
  drop,
}: {
  folder: LibFolder;
  count: number;
  renaming: boolean;
  onRenamed(name: string | null): void;
  onOpen(): void;
  onMenu(x: number, y: number): void;
  drop: DropProps;
}) {
  return (
    <div
      className="lib-tile lib-folder"
      draggable={!renaming}
      title={`${folder.name} (${count})`}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_FOLDER, folder.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => !renaming && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      {...drop}
    >
      <div className="lib-thumb">
        <FolderIcon size={40} />
        <span className="lib-count">{count}</span>
      </div>
      {renaming ? <NameEdit initial={folder.name} onDone={onRenamed} /> : <div className="lib-name">{folder.name}</div>}
    </div>
  );
}

function ItemTile({
  item,
  busy,
  selected,
  renaming,
  onRenamed,
  onSelect,
  onMenu,
}: {
  item: LibItem;
  busy: boolean;
  selected: boolean;
  renaming: boolean;
  onRenamed(name: string | null): void;
  onSelect(): void;
  onMenu(x: number, y: number): void;
}) {
  const name = stripExt(item.name);
  return (
    <div
      className={`lib-tile ${selected ? 'selected' : ''}`}
      draggable={!renaming}
      title={`${item.name} · ${fmtSize(item.size)}\nSahneye sürükleyin ya da çift tıklayın`}
      onDragStart={(e) => {
        onSelect();
        e.dataTransfer.setData(DND_ITEM, item.id);
        e.dataTransfer.setData('text/plain', item.name);
        e.dataTransfer.effectAllowed = 'copyMove';
        const img = e.currentTarget.querySelector('img');
        if (img) e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
      }}
      onClick={onSelect}
      onDoubleClick={() => !renaming && insertItem(item.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div className="lib-thumb">
        {item.thumb ? (
          <img src={item.thumb} alt="" draggable={false} />
        ) : busy ? (
          <span className="lib-spinner" aria-label="Önizleme hazırlanıyor" />
        ) : (
          <span className="lib-ext">{item.name.split('.').pop()?.toUpperCase()}</span>
        )}
        <button
          type="button"
          className="lib-insert"
          title="Montaja ekle"
          aria-label={`${name} montaja ekle`}
          onClick={(e) => {
            e.stopPropagation();
            insertItem(item.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <IconPlus size={14} />
        </button>
      </div>
      {renaming ? <NameEdit initial={name} onDone={onRenamed} /> : <div className="lib-name">{name}</div>}
    </div>
  );
}
