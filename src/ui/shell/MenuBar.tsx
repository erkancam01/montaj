// Klasik menü çubuğu (masaüstü CAD alışkanlığı): Dosya · Düzenle · Görünüm · Ekle · Araçlar · Yardım.
// Bir menü açıkken diğer başlığın üzerine gelmek onu açar. Dar ekranda tek "☰" düğmesinde birleşir.
import { useRef, useState } from 'react';
import { selectedPartIds } from '@/core/assembly/rigid';
import { FEATURE_TOOLS } from '@/core/features/registry';
import { useAssembly } from '@/state/useAssembly';
import { isPartFixed, setPartFixed } from '@/state/partStatus';
import { duplicate, groupSelection, removeSelection, toggleVisible, ungroup } from '@/state/assemblyActions';
import { exitBody, finishSketch } from '@/state/modelingActions';
import { viewerApi } from '@/services/viewerApi';
import { PopupMenu, type MenuEntry } from '@/ui/commands/PopupMenu';
import { redoAny, runCommand, sketchCommand, toggleMateTool, toolBlocker, undoAny, newPart } from '@/ui/commands/commands';
import { useCommandUi } from '@/ui/commands/commandStore';
import { selectedGroupId } from '@/ui/assembly/GroupList';
import { openParamsDialog } from '@/ui/params/ParamsDialog';
import { openDxfImport } from '@/ui/sketch/DxfImportDialog';
import { normalTo, setStandardView, STANDARD_VIEWS, type StandardView } from '@/ui/viewport/viewCommands';
import { CIcon } from '@/ui/icons/commandIcons';
import { FIcon } from '@/ui/icons/featureIcons';
import { IconMate } from '@/ui/icons/icons';
import { exportGlb, exportPng, exportStep, openFilePicker, saveProjectZip } from '@/ui/shell/fileActions';
import { openHelp } from '@/ui/shell/HelpDialog';
import { openNewDialog } from '@/ui/shell/NewDialog';
import { runFeatureTool } from '@/ui/shell/Toolbar';
import { toggleLibrary, useLibraryUi } from '@/ui/library/libraryUi';

const st = () => useAssembly.getState();

type MenuId = 'file' | 'edit' | 'view' | 'insert' | 'tools' | 'help';

const MENUS: { id: MenuId; label: string }[] = [
  { id: 'file', label: 'Dosya' },
  { id: 'edit', label: 'Düzenle' },
  { id: 'view', label: 'Görünüm' },
  { id: 'insert', label: 'Ekle' },
  { id: 'tools', label: 'Araçlar' },
  { id: 'help', label: 'Yardım' },
];

function fileEntries(): MenuEntry[] {
  const empty = st().doc.instances.length === 0 && st().doc.files.length === 0;
  return [
    { label: 'Yeni…', icon: 'newDoc', hint: 'Ctrl+N', onClick: openNewDialog },
    { label: 'Aç / içe aktar…', icon: 'addFile', hint: 'Ctrl+O', title: 'STEP, IGES, BREP ya da proje .zip', onClick: openFilePicker },
    { label: 'Kaydet (.zip)', icon: 'zip', hint: 'Ctrl+S', disabled: empty, title: 'Projeyi kaynak dosyalarıyla .zip olarak indir', onClick: () => void saveProjectZip() },
    { heading: 'Dışa aktar' },
    { label: 'STEP (.step)', icon: 'export', title: 'Görünür montajı STEP olarak dışa aktar', onClick: () => void exportStep() },
    { label: 'GLB (.glb)', icon: 'export', disabled: empty, onClick: () => void exportGlb() },
    { label: 'PNG ekran görüntüsü', icon: 'camera', onClick: () => void exportPng() },
  ];
}

function editEntries(): MenuEntry[] {
  const s = st();
  const sketch = !!s.modeling.sketch;
  const sel = s.selection;
  const parts = selectedPartIds(s.doc, s.selection, s.extraSel);
  const fixed = parts.length > 0 && parts.every((id) => isPartFixed(id));
  const gid = selectedGroupId(s);
  const noSel = !sel || sketch;
  return [
    { label: 'Geri al', icon: 'rotate', hint: 'Ctrl+Z', disabled: sketch ? false : !s.past.length, onClick: undoAny },
    { label: 'Yinele', icon: 'rotate', hint: 'Ctrl+Y', disabled: sketch ? false : !s.future.length, onClick: redoAny },
    'sep',
    { label: 'Sil', icon: 'trash', hint: 'Del', disabled: noSel, onClick: removeSelection },
    { label: 'Çoğalt', icon: 'copy', hint: 'Ctrl+D', disabled: noSel, onClick: () => duplicate(st().selection) },
    { label: 'Gizle / göster', icon: 'hide', hint: 'H', disabled: noSel, onClick: () => toggleVisible(st().selection) },
    {
      label: fixed ? 'Serbest bırak' : 'Sabitle',
      icon: fixed ? 'unpin' : 'pin',
      disabled: !parts.length || sketch,
      onClick: () => parts.forEach((id) => setPartFixed(id, !fixed)),
    },
    'sep',
    { label: 'Grupla', icon: 'pickAssembly', hint: 'Ctrl+G', disabled: parts.length < 2 || sketch, onClick: () => void groupSelection() },
    { label: 'Grubu çöz', icon: 'pickAssembly', hint: 'Ctrl+Shift+G', disabled: !gid, onClick: () => gid && ungroup(gid) },
  ];
}

function viewEntries(): MenuEntry[] {
  const s = st();
  const ui = useCommandUi.getState();
  const views = (Object.keys(STANDARD_VIEWS) as StandardView[]).map(
    (k): MenuEntry => ({ label: STANDARD_VIEWS[k].label, icon: 'plane', hint: STANDARD_VIEWS[k].key, onClick: () => setStandardView(k) }),
  );
  return [
    { heading: 'Standart görünümler' },
    ...views,
    { label: 'Seçime dik', icon: 'plane', hint: 'Ctrl+8', onClick: () => normalTo() },
    'sep',
    { label: 'Tümünü sığdır', icon: 'fit', hint: 'F', onClick: () => viewerApi.fit('all') },
    { label: 'Seçime odakla', icon: 'focus', disabled: !s.selection, onClick: () => viewerApi.fit('selection') },
    'sep',
    { label: s.ui.showEdges ? 'Kenarları gizle' : 'Kenarları göster', icon: 'edges', onClick: () => st().setUi({ showEdges: !st().ui.showEdges }) },
    {
      label: ui.showPlanes ? 'Düzlemleri gizle' : 'Düzlemleri göster',
      icon: 'plane',
      title: 'Ön / Üst / Sağ temel düzlemleri sahnede göster',
      onClick: () => useCommandUi.getState().set({ showPlanes: !useCommandUi.getState().showPlanes }),
    },
    'sep',
    {
      label: useLibraryUi.getState().open ? 'Tasarım kütüphanesini kapat' : 'Tasarım kütüphanesi',
      icon: 'addFile',
      title: 'Kayıtlı parçalar: sahneye sürükleyerek montaja ekleyin',
      onClick: toggleLibrary,
    },
  ];
}

function insertEntries(): MenuEntry[] {
  const s = st();
  const sketch = !!s.modeling.sketch;
  const feats = FEATURE_TOOLS.map((t): MenuEntry => {
    const why = toolBlocker(s, t.needs);
    return {
      label: t.label,
      icon: <FIcon name={t.icon} size={16} />,
      disabled: !!why,
      title: why ?? t.title,
      onClick: () => runFeatureTool(t.tool),
    };
  });
  return [
    { heading: 'Bileşen' },
    { label: 'Dosyadan…', icon: 'addFile', disabled: sketch, title: 'STEP, IGES, BREP dosyasını montaja ekle', onClick: openFilePicker },
    { label: 'Kütüphaneden…', icon: 'addFile', disabled: sketch, title: 'Tasarım kütüphanesini aç', onClick: () => useLibraryUi.getState().setOpen(true) },
    { label: 'Yeni parça', icon: 'newPart', disabled: sketch, onClick: () => runCommand('newpart', 'Yeni parça', newPart) },
    'sep',
    sketch
      ? { label: "Sketch'ten çık", icon: 'exitSketch', primary: true, hint: 'Enter', onClick: () => finishSketch() }
      : { label: 'Sketch', icon: <FIcon name="sketch" size={16} />, disabled: !!s.modeling.feature, onClick: () => runCommand('sketch', 'Sketch', sketchCommand) },
    { label: 'DXF profil…', icon: 'importDxf', disabled: !sketch, title: sketch ? 'DXF profil kesitini sketch’e aktar' : 'Önce bir sketch açın', onClick: openDxfImport },
    { heading: 'Unsurlar' },
    ...feats,
    { heading: 'Montaj' },
    { label: 'Mate', icon: <IconMate size={16} />, hint: 'M', disabled: sketch, onClick: () => runCommand('mate', 'Mate', toggleMateTool) },
  ];
}

function toolsEntries(): MenuEntry[] {
  const s = st();
  return [
    { label: 'Parametreler…', icon: 'measure', title: 'Kullanıcı parametreleri tablosu', onClick: openParamsDialog },
    'sep',
    {
      label: s.ui.invertWheel ? 'Tekerlek yönü: ters ✓' : 'Tekerlek yönü: ters',
      icon: 'rotate',
      title: 'Fare tekerleği ile yakınlaştırma yönünü çevir',
      onClick: () => st().setUi({ invertWheel: !st().ui.invertWheel }),
    },
    ...(s.modeling.activeBodyId && !s.modeling.sketch
      ? (['sep', { label: 'Montaja dön', icon: 'done', onClick: () => exitBody() }] as MenuEntry[])
      : []),
  ];
}

function helpEntries(): MenuEntry[] {
  return [{ label: 'Kullanım ve kısayollar', icon: 'info', hint: 'F1', onClick: openHelp }];
}

const BUILDERS: Record<MenuId, () => MenuEntry[]> = {
  file: fileEntries,
  edit: editEntries,
  view: viewEntries,
  insert: insertEntries,
  tools: toolsEntries,
  help: helpEntries,
};

/** Dar ekran: tüm menüler başlıklı tek liste */
function allEntries(): MenuEntry[] {
  return MENUS.flatMap((m) => [{ heading: m.label } as MenuEntry, ...BUILDERS[m.id]().filter((e) => !(typeof e === 'object' && 'heading' in e))]);
}

export function MenuBar() {
  const [open, setOpen] = useState<{ id: MenuId | 'all'; x: number; y: number } | null>(null);
  // Açık menünün kendi başlığına basınca: pointerdown dışarı tıklama sayılıp kapatır, ardından click yeniden açmasın
  const closedAt = useRef<{ id: string; t: number } | null>(null);
  // Menüler açıldığı anda kurulur (seçim / geri al durumu güncel olsun)
  const [, force] = useState(0);
  const toggle = (id: MenuId | 'all', el: HTMLElement) => {
    const c = closedAt.current;
    if (c && c.id === id && performance.now() - c.t < 300) return;
    const r = el.getBoundingClientRect();
    force((n) => n + 1);
    setOpen({ id, x: r.left, y: r.bottom + 2 });
  };
  return (
    <nav className="menubar" aria-label="Menü çubuğu">
      <button
        type="button"
        className={`menubar-burger ${open?.id === 'all' ? 'active' : ''}`}
        aria-label="Menü"
        onClick={(e) => toggle('all', e.currentTarget)}
      >
        <CIcon name="menu" />
      </button>
      {MENUS.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`menubar-item ${open?.id === m.id ? 'active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open?.id === m.id}
          onClick={(e) => toggle(m.id, e.currentTarget)}
          onMouseEnter={(e) => {
            if (open && open.id !== m.id && open.id !== 'all') {
              const r = e.currentTarget.getBoundingClientRect();
              setOpen({ id: m.id, x: r.left, y: r.bottom + 2 });
            }
          }}
        >
          {m.label}
        </button>
      ))}
      {open && (
        <PopupMenu
          key={open.id}
          x={open.x}
          y={open.y}
          className="menubar-menu"
          entries={open.id === 'all' ? allEntries() : BUILDERS[open.id]()}
          onClose={() => {
            closedAt.current = { id: open.id, t: performance.now() };
            setOpen(null);
          }}
        />
      )}
    </nav>
  );
}
