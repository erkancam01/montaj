// Üst komut çubuğu: solda Dosya menüsü + hızlı geri al/yinele, ortada sekmeler (Özellikler / Çizim / Montaj /
// Değerlendir); her sekmede yalnız ilgili komutlar (simge + altında ad).
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { downloadBlob } from '@/services/io/download';
import { ACCEPT_ATTR } from '@/services/io/formats';
import { selectedPartIds } from '@/core/assembly/rigid';
import { exportProjectZip, newProject } from '@/services/io/session';
import { viewerApi } from '@/services/viewerApi';
import { enterBody, exitBody, finishSketch } from '@/state/modelingActions';
import { exportAssemblyAsStep } from '@/services/io/exportAssemblyStep';
import { redoSketch, undoSketch, useSketchUi } from '@/state/sketchSession';
import { groupSelection, ungroup } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import { isBodyFileId } from '@/core/types';
import { CIcon, type CmdIconName } from '@/ui/icons/commandIcons';
import {
  bodyCaps,
  runCommand,
  selectedBodyId,
  sketchOnFace,
  sketchOnPlane,
  newPartOnPlane,
  startTool,
  toggleMateTool,
  toolBlocker,
  type FeatureTool,
} from '@/ui/commands/commands';
import { useCommandUi, type CommandTab } from '@/ui/commands/commandStore';
import { PopupMenu, type MenuEntry } from '@/ui/commands/PopupMenu';
import { openParamsDialog } from '@/ui/params/ParamsDialog';
import { selectedGroupId } from '@/ui/assembly/GroupList';
import { importWithConfirm, isDocEmpty } from '@/ui/shell/importWithConfirm';
import { IconGroup, IconMate, IconPlus, IconRedo, IconUndo, IconUngroup } from '@/ui/icons/icons';
import { FIcon } from '@/ui/icons/featureIcons';
import { confirmCancel, SKETCH_TOOLS, StatusPill } from '@/ui/sketch/SketchToolbar';
import { openDxfImport } from '@/ui/sketch/DxfImportDialog';
import { IconConstruction, ToolIcon } from '@/ui/icons/sketchIcons';
import { chooseTool, constructionKey, resetDraw } from '@/ui/sketch/tools';
import { FEATURE_TOOL_GROUPS, FEATURE_TOOLS } from '@/core/features/registry';
import '@/ui/commands/command.css';

const MOVE_STEPS = [0.1, 0.5, 1, 5, 10, 50, 100];
const ANGLE_STEPS = [1, 5, 15, 30, 45, 90];

/** Gizli dosya seçicili "Dosya ekle" düğmesi (komut çubuğu ve boş durum kartı kullanır) */
export function AddFilesButton({ className = 'btn btn-primary', children }: { className?: string; children?: ReactNode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        title="STEP, IGES, BREP dosyası veya proje .zip ekle (sürükle-bırak da olur)"
        onClick={() => inputRef.current?.click()}
      >
        {children ?? (
          <>
            <IconPlus /> Dosya ekle
          </>
        )}
      </button>
      <FileInput inputRef={inputRef} />
    </>
  );
}

function FileInput({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={ACCEPT_ATTR}
      hidden
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        e.currentTarget.value = '';
        if (files.length) void importWithConfirm(files);
      }}
    />
  );
}

/** Dosya menüsünün tek dosya seçicisi (openFilePicker olayını dinler) */
function FilePickerHost() {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const open = () => inputRef.current?.click();
    window.addEventListener('app:add-files', open);
    return () => window.removeEventListener('app:add-files', open);
  }, []);
  return <FileInput inputRef={inputRef} />;
}

/** Dosya seçiciyi açar */
export function openFilePicker() {
  window.dispatchEvent(new Event('app:add-files'));
}

function stepOptions(list: number[], current: number) {
  return list.includes(current) ? list : [...list, current].sort((a, b) => a - b);
}

async function runExport(make: () => Promise<Blob | null>, filename: string, emptyMsg: string) {
  const { showToast } = useAssembly.getState();
  try {
    const blob = await make();
    if (!blob || blob.size === 0) {
      showToast(emptyMsg, 'error');
      return;
    }
    downloadBlob(blob, filename);
  } catch (err) {
    console.error(err);
    showToast(`Dışa aktarma başarısız: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function exportStep() {
  const { showToast } = useAssembly.getState();
  try {
    const { blob, warnings } = await exportAssemblyAsStep();
    downloadBlob(blob, 'montaj.step');
    if (warnings.length) {
      const more = warnings.length > 2 ? ` (+${warnings.length - 2} uyarı)` : '';
      showToast(`STEP uyarıları: ${warnings.slice(0, 2).join(' · ')}${more}`, 'error');
      console.warn('STEP dışa aktarma uyarıları', warnings);
    }
  } catch (err) {
    console.error(err);
    showToast(`STEP dışa aktarma başarısız: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

export async function onNewProject() {
  if (!isDocEmpty() && !window.confirm('Mevcut proje temizlenecek. Devam edilsin mi?')) return;
  try {
    await newProject();
  } catch (err) {
    console.error(err);
    useAssembly.getState().showToast('Yeni proje oluşturulamadı', 'error');
  }
}

// ---------------------------------------------------------------- ortak düğme

interface CmdButtonProps {
  icon: ReactNode;
  label: string;
  title: string;
  onClick(e: RMouseEvent<HTMLButtonElement>): void;
  disabled?: boolean;
  /** Basılı / açık */
  active?: boolean;
  /** Önerilen sonraki adım (vurgulu) */
  suggest?: boolean;
  caret?: boolean;
  kbd?: string;
}

export function CmdButton({ icon, label, title, onClick, disabled, active, suggest, caret, kbd }: CmdButtonProps) {
  return (
    <button
      type="button"
      className={`cmd-btn ${active ? 'active' : ''} ${suggest ? 'suggest' : ''}`}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="cmd-btn-icon">{icon}</span>
      <span className="cmd-btn-label">
        {label}
        {caret && <span className="cmd-caret">▾</span>}
      </span>
      {kbd && <kbd className="cmd-kbd">{kbd}</kbd>}
    </button>
  );
}

const Sep = () => <div className="cmd-sep" aria-hidden="true" />;

// ---------------------------------------------------------------- sketch düzlemi menüsü

const SKETCH_PLANE_KEY = 'sketch-plane';
/** Yüzey seçimi "yeni parça" için mi başlatıldı */
let planePickNewPart = false;

function pickSketchFace(newPart: boolean) {
  planePickNewPart = newPart;
  useAssembly.getState().startPick({
    key: SKETCH_PLANE_KEY,
    kinds: ['face'],
    filter: ['plane'],
    multi: false,
    prompt: 'Çizim için düz bir yüzey seçin (başka parçanın yüzü seçilirse sketch ona bağlanır)',
  });
}

/** Düzlem seçim menüsü girdileri (Yeni parça ve Sketch düğmeleri) */
function planeEntries(newPart: boolean, hasParts: boolean): MenuEntry[] {
  const plane = (k: 'XY' | 'XZ' | 'YZ', label: string): MenuEntry => ({
    label,
    icon: 'plane',
    onClick: () =>
      runCommand(newPart ? `newpart-${k}` : `sketch-${k}`, newPart ? `Yeni parça (${k})` : `Sketch (${k})`, () =>
        newPart ? newPartOnPlane(k) : sketchOnPlane(k),
      ),
  });
  return [
    { heading: newPart ? 'Yeni parça · çizim düzlemi' : 'Sketch düzlemi' },
    ...(hasParts
      ? [{ label: 'Bir parçanın yüzeyine çiz…', icon: 'pickPart', primary: true, onClick: () => pickSketchFace(newPart) } as MenuEntry, 'sep' as const]
      : []),
    plane('XY', 'Üst düzlem (XY)'),
    plane('XZ', 'Ön düzlem (XZ)'),
    plane('YZ', 'Sağ düzlem (YZ)'),
  ];
}

/** Sketch düzlemi için yüzey seçildi → sketch başlat */
function usePlanePick() {
  const picked = useAssembly((s) => (s.modeling.pick?.key === SKETCH_PLANE_KEY ? s.modeling.pick.picked : null));
  useEffect(() => {
    if (!picked?.length) return;
    const st = useAssembly.getState();
    const t = picked[0];
    st.endPick();
    if (t.kind !== 'face') return;
    sketchOnFace(t.ref, { newPart: planePickNewPart });
  }, [picked]);
}

// ---------------------------------------------------------------- çubuk

/** short: dar ekranda (mobile.css) gösterilen kısa etiket */
const TABS: { id: CommandTab; label: string; short: string }[] = [
  { id: 'features', label: 'Özellikler', short: 'Özellik' },
  { id: 'sketch', label: 'Çizim', short: 'Çizim' },
  { id: 'assembly', label: 'Montaj', short: 'Montaj' },
  { id: 'evaluate', label: 'Değerlendir', short: 'Analiz' },
];

export function Toolbar() {
  const tab = useCommandUi((s) => s.tab);
  const setTab = (t: CommandTab) => useCommandUi.getState().set({ tab: t });
  usePlanePick();
  return (
    <header className="toolbar cmdbar">
      <div className="cmd-top">
        <FileMenu />
        <QuickAccess />
        <div className="cmd-tabs" role="tablist" aria-label="Komut sekmeleri">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`cmd-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className="lbl-long">{t.label}</span>
              <span className="lbl-short">{t.short}</span>
            </button>
          ))}
        </div>
        <div className="tb-spacer" />
        <div className="tb-brand">STEP Montaj</div>
      </div>
      <div className="cmd-row" role="tabpanel">
        {tab === 'features' && <FeaturesTab />}
        {tab === 'sketch' && <SketchTab />}
        {tab === 'assembly' && <AssemblyTab />}
        {tab === 'evaluate' && <EvaluateTab />}
      </div>
    </header>
  );
}

function FileMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const empty = useAssembly((s) => s.doc.instances.length === 0 && s.doc.files.length === 0);
  const exportAs = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`cmd-file ${menu ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title="Dosya ve proje işlemleri"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 2 });
        }}
      >
        <CIcon name="menu" /> {busy ? 'Kaydediliyor…' : 'Dosya'}
      </button>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            { label: 'Yeni proje', icon: 'newDoc', onClick: () => void onNewProject() },
            { label: 'Dosya ekle…', icon: 'addFile', title: 'STEP, IGES, BREP ya da proje .zip', onClick: openFilePicker },
            { label: 'Parametreler…', icon: 'measure', title: 'Kullanıcı parametreleri tablosu', onClick: openParamsDialog },
            'sep',
            {
              label: 'Projeyi kaydet (.zip)',
              icon: 'zip',
              disabled: empty || !!busy,
              title: 'Projeyi kaynak dosyalarıyla birlikte .zip olarak indir',
              onClick: () =>
                void exportAs('zip', () => runExport(exportProjectZip, 'montaj-proje.zip', 'Kaydedilecek proje içeriği yok')),
            },
            { heading: 'Dışa aktar' },
            {
              label: 'STEP (.step)',
              icon: 'export',
              disabled: !!busy,
              title: 'Tüm görünür montajı (çizilen ve içe aktarılan parçalar) STEP olarak dışa aktar',
              onClick: () => void exportAs('step', exportStep),
            },
            {
              label: 'GLB (.glb)',
              icon: 'export',
              disabled: empty || !!busy,
              title: 'Görünür montajı GLB olarak dışa aktar',
              onClick: () =>
                void exportAs('glb', () => runExport(() => viewerApi.exportGLB(), 'montaj.glb', 'Dışa aktarılacak görünür parça yok')),
            },
            {
              label: 'PNG ekran görüntüsü',
              icon: 'camera',
              disabled: !!busy,
              onClick: () =>
                void exportAs('png', () => runExport(() => viewerApi.screenshot(), 'montaj.png', 'Ekran görüntüsü alınamadı')),
            },
          ]}
        />
      )}
      <FilePickerHost />
    </>
  );
}

/** Sol üstte geri al / yinele (sketch oturumunda sketch geçmişi) */
function QuickAccess() {
  const sketchOpen = useAssembly((s) => !!s.modeling.sketch);
  const { canUndo, canRedo } = useAssembly(useShallow((s) => ({ canUndo: s.past.length > 0, canRedo: s.future.length > 0 })));
  const skUndo = useSketchUi((s) => s.canUndo);
  const skRedo = useSketchUi((s) => s.canRedo);
  const u = sketchOpen ? skUndo : canUndo;
  const r = sketchOpen ? skRedo : canRedo;
  return (
    <div className="cmd-quick">
      <button
        type="button"
        className="btn btn-icon"
        disabled={!u}
        title={sketchOpen ? 'Sketch: geri al (Ctrl+Z)' : 'Geri al (Ctrl+Z)'}
        aria-label="Geri al"
        onClick={() => {
          if (sketchOpen) {
            resetDraw();
            undoSketch();
          } else useAssembly.getState().undo();
        }}
      >
        <IconUndo />
      </button>
      <button
        type="button"
        className="btn btn-icon"
        disabled={!r}
        title={sketchOpen ? 'Sketch: yinele (Ctrl+Y)' : 'Yinele (Ctrl+Y / Ctrl+Shift+Z)'}
        aria-label="Yinele"
        onClick={() => {
          if (sketchOpen) {
            resetDraw();
            redoSketch();
          } else useAssembly.getState().redo();
        }}
      >
        <IconRedo />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Özellikler

/** Özellik komutları: tanımları core/features/registry.ts'te */
export { FEATURE_TOOLS };

/** Özellik aracını son komut olarak kaydedip başlatır */
export function runFeatureTool(tool: FeatureTool) {
  const t = FEATURE_TOOLS.find((x) => x.tool === tool);
  runCommand(`feature-${tool}`, t?.label ?? tool, () => {
    const s = useAssembly.getState();
    const why = toolBlocker(s, t?.needs ?? 'solid');
    if (why) {
      s.showToast(`${t?.label ?? tool}: ${why}`, 'error');
      return;
    }
    const bodyId = s.modeling.activeBodyId ?? selectedBodyId(s);
    if (bodyId) startTool(bodyId, tool);
  });
}

function useHasParts() {
  return useAssembly((s) => s.doc.parts.some((p) => p.visible));
}

function PlaneMenuButton({ newPart, label, icon, title, disabled }: { newPart: boolean; label: string; icon: ReactNode; title: string; disabled?: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hasParts = useHasParts();
  const picking = useAssembly((s) => s.modeling.pick?.key === SKETCH_PLANE_KEY);
  return (
    <>
      <CmdButton
        icon={icon}
        label={label}
        title={title}
        caret
        disabled={disabled}
        active={!!menu || (picking && planePickNewPart === newPart)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 2 });
        }}
      />
      {menu && <PopupMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} entries={planeEntries(newPart, hasParts)} />}
    </>
  );
}

function FeaturesTab() {
  const { activeBodyId, sketchOpen, featureOpen } = useAssembly(
    useShallow((s) => ({ activeBodyId: s.modeling.activeBodyId, sketchOpen: !!s.modeling.sketch, featureOpen: !!s.modeling.feature })),
  );
  const selBody = useAssembly(selectedBodyId);
  const blockers = useAssembly(useShallow((s) => FEATURE_TOOLS.map((t) => toolBlocker(s, t.needs))));
  const suggestion = useCommandUi((s) => s.suggestion);
  return (
    <>
      <PlaneMenuButton
        newPart
        label="Yeni parça"
        icon={<CIcon name="newPart" size={22} />}
        title={sketchOpen ? 'Sketch oturumu açıkken kullanılamaz' : 'Yeni parametrik parça oluştur ve çizim düzlemini seç'}
        disabled={sketchOpen}
      />
      {activeBodyId ? (
        <CmdButton
          icon={<CIcon name="done" size={22} />}
          label="Düzenlemeyi bitir"
          title={sketchOpen ? 'Önce sketch oturumunu bitirin' : 'Parça düzenlemesini bitir (açık özellik iptal edilir)'}
          disabled={sketchOpen}
          active
          onClick={() => exitBody()}
        />
      ) : (
        <CmdButton
          icon={<CIcon name="editPart" size={22} />}
          label="Parçayı düzenle"
          title={selBody ? 'Seçili parçanın özellik geçmişini düzenle (sahnede çift tık da olur)' : 'Önce çizilmiş bir parça seçin'}
          disabled={!selBody}
          onClick={() => selBody && enterBody(selBody)}
        />
      )}
      <Sep />
      <PlaneMenuButton
        newPart={false}
        label="Sketch"
        icon={<FIcon name="sketch" size={22} />}
        title={sketchOpen ? 'Sketch oturumu zaten açık' : featureOpen ? 'Önce açık özelliği bitirin' : 'Yeni sketch: çizim düzlemi seçin'}
        disabled={sketchOpen || featureOpen}
      />
      <CmdButton
        icon={<span className="cmd-fx">ƒx</span>}
        label="Parametreler"
        title="Kullanıcı parametreleri tablosu: ölçüleri adlandırılmış değerlere bağlayın, tek yerden değiştirin"
        onClick={openParamsDialog}
      />
      <Sep />
      {FEATURE_TOOLS.map((t, i) => (
        <span key={t.tool} className="cmd-inline">
          {i > 0 && FEATURE_TOOL_GROUPS.includes(t.tool) && <Sep />}
          <CmdButton
            icon={<FIcon name={t.icon} size={22} />}
            label={t.label}
            title={blockers[i] ? `${t.label}: ${blockers[i]}` : `${t.label}: ${t.title}`}
            disabled={!!blockers[i]}
            suggest={!!suggestion && (t.tool === 'extrude' || (t.tool === 'cut' && suggestion.hasSolid))}
            onClick={() => runFeatureTool(t.tool)}
          />
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- Çizim

function SketchTab() {
  const sketchOpen = useAssembly((s) => !!s.modeling.sketch);
  const featureOpen = useAssembly((s) => !!s.modeling.feature);
  const tool = useSketchUi((s) => s.tool);
  const construction = useSketchUi((s) => s.construction);
  const name = useAssembly((s) => s.modeling.sketch?.data.name);
  const off = 'Önce bir sketch başlatın (Sketch düğmesi ya da bir yüzeye tıklayıp Sketch)';
  return (
    <>
      {sketchOpen ? (
        <CmdButton
          icon={<CIcon name="exitSketch" size={22} />}
          label="Sketch'ten çık"
          title={`${name ?? 'Sketch'}: bitir ve kaydet [Enter]`}
          active
          onClick={() => finishSketch()}
        />
      ) : (
        <PlaneMenuButton
          newPart={false}
          label="Sketch"
          icon={<FIcon name="sketch" size={22} />}
          title={featureOpen ? 'Önce açık özelliği bitirin' : 'Yeni sketch: çizim düzlemi seçin'}
          disabled={featureOpen}
        />
      )}
      <Sep />
      {SKETCH_TOOLS.map((t) => (
        <CmdButton
          key={t.tool}
          icon={<ToolIcon tool={t.tool} size={22} />}
          label={t.label}
          title={sketchOpen ? `${t.title} [${t.key}]` : off}
          kbd={t.key}
          disabled={!sketchOpen}
          active={sketchOpen && tool === t.tool}
          onClick={() => runCommand(`sk-${t.tool}`, t.label, () => chooseTool(t.tool))}
        />
      ))}
      <CmdButton
        icon={<CIcon name="importDxf" size={22} />}
        label="DXF"
        title={sketchOpen ? "DXF profil kesitini sketch'e sabit geometri olarak aktar (DWG için önce DXF olarak kaydedin)" : off}
        disabled={!sketchOpen}
        onClick={() => runCommand('sk-dxf', 'DXF içe aktar', openDxfImport)}
      />
      <Sep />
      <CmdButton
        icon={<IconConstruction size={22} />}
        label="Yardımcı"
        kbd="X"
        title={
          sketchOpen
            ? 'Yardımcı geometri: seçili eğrileri yardımcı yap / seçim yoksa yeni çizimler için yardımcı kipi aç-kapa [X]'
            : off
        }
        disabled={!sketchOpen}
        active={sketchOpen && construction}
        onClick={constructionKey}
      />
      {sketchOpen && (
        <>
          <Sep />
          <div className="cmd-stack">
            <StatusPill />
            <button type="button" className="btn btn-small btn-ghost" title="Değişiklikleri at ve çık" onClick={confirmCancel}>
              İptal
            </button>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Montaj

function AssemblyTab() {
  const ui = useAssembly((s) => s.ui);
  const setUi = useAssembly((s) => s.setUi);
  const selCount = useAssembly((s) => selectedPartIds(s.doc, s.selection, s.extraSel).length);
  const groupId = useAssembly(selectedGroupId);
  const sketchOpen = useAssembly((s) => !!s.modeling.sketch);
  const mateTool = ui.tool === 'mate';
  const gizmoTitle = mateTool ? ' (Mate aracı açıkken gizmo kullanılmaz)' : '';
  return (
    <>
      <AddFilesButton className="cmd-btn">
        <span className="cmd-btn-icon">
          <CIcon name="addFile" size={22} />
        </span>
        <span className="cmd-btn-label">Dosya ekle</span>
      </AddFilesButton>
      <PlaneMenuButton
        newPart
        label="Yeni parça"
        icon={<CIcon name="newPart" size={22} />}
        title="Montajda yeni parametrik parça çiz"
        disabled={sketchOpen}
      />
      <Sep />
      <CmdButton
        icon={<CIcon name="move" size={22} />}
        label="Taşı"
        kbd="W"
        title={`Taşı (W)${gizmoTitle}`}
        active={ui.mode === 'translate' && !mateTool}
        onClick={() => runCommand('move', 'Taşı', () => setUi({ mode: 'translate', tool: 'select' }))}
      />
      <CmdButton
        icon={<CIcon name="rotate" size={22} />}
        label="Döndür"
        kbd="E"
        title={`Döndür (E)${gizmoTitle}`}
        active={ui.mode === 'rotate' && !mateTool}
        onClick={() => runCommand('rotate', 'Döndür', () => setUi({ mode: 'rotate', tool: 'select' }))}
      />
      <CmdButton
        icon={<CIcon name={ui.space === 'world' ? 'globe' : 'axes'} size={22} />}
        label={ui.space === 'world' ? 'Dünya' : 'Yerel'}
        kbd="Q"
        title="Gizmo ekseni: Dünya / Yerel (Q)"
        onClick={() => setUi({ space: ui.space === 'world' ? 'local' : 'world' })}
      />
      <div className="cmd-stack">
        <button
          type="button"
          className={`btn btn-toggle btn-small ${ui.snap ? 'on' : ''}`}
          aria-pressed={ui.snap}
          title="Adımlı hareket (snap) aç/kapa"
          onClick={() => setUi({ snap: !ui.snap })}
        >
          <CIcon name="snap" size={13} /> Snap
        </button>
        <div className="cmd-stack-row">
          <select
            className="tb-select"
            value={ui.snapMove}
            disabled={!ui.snap}
            title="Taşıma adımı (mm)"
            onChange={(e) => setUi({ snapMove: Number(e.target.value) })}
          >
            {stepOptions(MOVE_STEPS, ui.snapMove).map((v) => (
              <option key={v} value={v}>
                {v} mm
              </option>
            ))}
          </select>
          <select
            className="tb-select"
            value={ui.snapAngle}
            disabled={!ui.snap}
            title="Dönüş adımı (derece)"
            onChange={(e) => setUi({ snapAngle: Number(e.target.value) })}
          >
            {stepOptions(ANGLE_STEPS, ui.snapAngle).map((v) => (
              <option key={v} value={v}>
                {v}°
              </option>
            ))}
          </select>
        </div>
      </div>
      <Sep />
      <div className="cmd-stack">
        <span className="cmd-stack-label">Sahnede seç</span>
        <div className="seg" role="group" aria-label="Seçim modu">
          <button
            type="button"
            className={ui.selectMode === 'part' ? 'active' : ''}
            aria-pressed={ui.selectMode === 'part'}
            title="Sahnede tıklayınca tek parçayı seç"
            onClick={() => setUi({ selectMode: 'part' })}
          >
            Parça
          </button>
          <button
            type="button"
            className={ui.selectMode === 'instance' ? 'active' : ''}
            aria-pressed={ui.selectMode === 'instance'}
            title="Sahnede tıklayınca tüm montaj dosyasını seç"
            onClick={() => setUi({ selectMode: 'instance' })}
          >
            Montaj
          </button>
        </div>
      </div>
      <Sep />
      <CmdButton
        icon={<IconMate size={22} />}
        label="Mate"
        kbd="M"
        title="Mate (M): iki yüzey seçerek parçaları bağla"
        active={mateTool}
        disabled={sketchOpen}
        onClick={() => runCommand('mate', 'Mate', toggleMateTool)}
      />
      <Sep />
      <CmdButton
        icon={<IconGroup size={22} />}
        label="Grupla"
        title={
          selCount < 2
            ? 'Grupla (Ctrl+G): önce Ctrl/Shift+tık ile en az iki parça seçin'
            : `Seçili ${selCount} parçayı tek rijit grupta birleştir (Ctrl+G)`
        }
        disabled={selCount < 2}
        onClick={() => runCommand('group', 'Grupla', () => void groupSelection())}
      />
      <CmdButton
        icon={<IconUngroup size={22} />}
        label="Grubu çöz"
        title={groupId ? 'Grubu çöz; parçalar yerinde kalır (Ctrl+Shift+G)' : 'Grubu çöz (Ctrl+Shift+G): önce bir grup seçin'}
        disabled={!groupId}
        onClick={() => groupId && ungroup(groupId)}
      />
    </>
  );
}

// ---------------------------------------------------------------- Değerlendir

function EvaluateTab() {
  const showEdges = useAssembly((s) => s.ui.showEdges);
  const setUi = useAssembly((s) => s.setUi);
  const stats = useAssembly(
    useShallow((s) => ({
      parts: s.doc.parts.length,
      bodies: s.doc.instances.filter((i) => isBodyFileId(i.fileId)).length,
      mates: s.doc.mates.length,
      groups: s.doc.groups.length,
      activeName: s.modeling.activeBodyId ? (s.doc.bodies.find((b) => b.id === s.modeling.activeBodyId)?.name ?? null) : null,
      features: s.modeling.activeBodyId ? (s.doc.bodies.find((b) => b.id === s.modeling.activeBodyId)?.features.length ?? 0) : 0,
    })),
  );
  const caps = useAssembly(useShallow((s) => bodyCaps(s, s.modeling.activeBodyId)));
  const shot = () => void runExport(() => viewerApi.screenshot(), 'montaj.png', 'Ekran görüntüsü alınamadı');
  const icon = (n: CmdIconName) => <CIcon name={n} size={22} />;
  return (
    <>
      <CmdButton icon={icon('fit')} label="Sığdır" title="Tüm montajı görünüme sığdır" onClick={() => viewerApi.fit('all')} />
      <CmdButton
        icon={icon('focus')}
        label="Seçime odakla"
        title="Seçili öğeyi görünüme sığdır"
        onClick={() => viewerApi.fit('selection')}
      />
      <CmdButton
        icon={icon('edges')}
        label="Kenarlar"
        title="Kenar çizgilerini göster/gizle"
        active={showEdges}
        onClick={() => setUi({ showEdges: !showEdges })}
      />
      <Sep />
      <CmdButton icon={icon('camera')} label="Ekran görüntüsü" title="Görünümün PNG ekran görüntüsünü indir" onClick={shot} />
      <Sep />
      <div className="cmd-stats" title="Montaj bilgisi">
        <span>
          <b>{stats.parts}</b> parça · <b>{stats.bodies}</b> çizilen
        </span>
        <span>
          <b>{stats.mates}</b> mate · <b>{stats.groups}</b> grup
        </span>
        {stats.activeName && (
          <span>
            {stats.activeName}: <b>{stats.features}</b> özellik{caps.hasSolid ? ' · katı' : ''}
          </span>
        )}
      </div>
    </>
  );
}
