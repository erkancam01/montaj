// Üst komut çubuğu: solda menü çubuğu (Dosya · Düzenle · …) + hızlı geri al/yinele, ortada kipe göre sekmeler
// (montajda Montaj / Sketch / Değerlendir, parça kipinde Unsurlar / Sketch / Değerlendir); her sekmede yalnız
// ilgili komutlar (simge + altında ad).
import { useEffect, useRef, type MouseEvent as RMouseEvent, type ReactNode, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ACCEPT_ATTR } from '@/services/io/formats';
import { selectedPartIds } from '@/core/assembly/rigid';
import { viewerApi } from '@/services/viewerApi';
import { enterBody, exitBody, finishSketch } from '@/state/modelingActions';
import { useSketchUi } from '@/state/sketchSession';
import { groupSelection, ungroup } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import { isBodyFileId } from '@/core/types';
import { CIcon, type CmdIconName } from '@/ui/icons/commandIcons';
import {
  bodyCaps,
  newPart,
  redoAny,
  runCommand,
  selectedBodyId,
  sketchCommand,
  startTool,
  toggleMateTool,
  toolBlocker,
  undoAny,
  type FeatureTool,
} from '@/ui/commands/commands';
import { MenuBar } from '@/ui/shell/MenuBar';
import { useCommandUi, type CommandTab } from '@/ui/commands/commandStore';
import { openParamsDialog } from '@/ui/params/ParamsDialog';
import { selectedGroupId } from '@/ui/assembly/GroupList';
import { importWithConfirm } from '@/ui/shell/importWithConfirm';
import { IconGroup, IconMate, IconPlus, IconRedo, IconUndo, IconUngroup } from '@/ui/icons/icons';
import { FIcon } from '@/ui/icons/featureIcons';
import { confirmCancel, SKETCH_TOOLS, StatusPill } from '@/ui/sketch/SketchToolbar';
import { openDxfImport } from '@/ui/sketch/DxfImportDialog';
import { IconConstruction, ToolIcon } from '@/ui/icons/sketchIcons';
import { chooseTool, constructionKey } from '@/ui/sketch/tools';
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

export { openFilePicker, onNewProject, runExport, exportStep } from '@/ui/shell/fileActions';
import { exportPng, openFilePicker } from '@/ui/shell/fileActions';

function stepOptions(list: number[], current: number) {
  return list.includes(current) ? list : [...list, current].sort((a, b) => a - b);
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

// ---------------------------------------------------------------- çubuk

/** short: dar ekranda (mobile.css) gösterilen kısa etiket */
const TAB_DEFS: Record<CommandTab, { label: string; short: string }> = {
  features: { label: 'Unsurlar', short: 'Unsur' },
  sketch: { label: 'Sketch', short: 'Sketch' },
  assembly: { label: 'Montaj', short: 'Montaj' },
  evaluate: { label: 'Değerlendir', short: 'Analiz' },
};

/** Kipe göre sekmeler: parça kipinde Unsurlar, montajda Montaj */
export function visibleTabs(partMode: boolean): CommandTab[] {
  return partMode ? ['features', 'sketch', 'evaluate'] : ['assembly', 'sketch', 'evaluate'];
}

export function Toolbar() {
  const partMode = useAssembly((s) => !!s.modeling.activeBodyId);
  const tabs = visibleTabs(partMode);
  const want = useCommandUi((s) => s.tab);
  const tab = tabs.includes(want) ? want : tabs[0];
  const setTab = (t: CommandTab) => useCommandUi.getState().set({ tab: t });
  const TABS = tabs.map((id) => ({ id, ...TAB_DEFS[id] }));
  return (
    <header className="toolbar cmdbar">
      <div className="cmd-top">
        <MenuBar />
        <FilePickerHost />
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
        onClick={undoAny}
      >
        <IconUndo />
      </button>
      <button
        type="button"
        className="btn btn-icon"
        disabled={!r}
        title={sketchOpen ? 'Sketch: yinele (Ctrl+Y)' : 'Yinele (Ctrl+Y / Ctrl+Shift+Z)'}
        aria-label="Yinele"
        onClick={redoAny}
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

const PLANE_NAMES = { XY: 'Üst', XZ: 'Ön', YZ: 'Sağ' } as const;

/** Sketch komutu: seçili düzlem / yüzeyde açılır, seçim yoksa düzlem bekler */
function SketchButton({ disabled, title }: { disabled?: boolean; title?: string }) {
  const picking = useCommandUi((s) => s.planePick);
  const sel = useCommandUi((s) => (s.plane ? `${PLANE_NAMES[s.plane]} düzlem` : s.face ? 'seçili yüzey' : null));
  return (
    <CmdButton
      icon={<FIcon name="sketch" size={22} />}
      label="Sketch"
      title={title ?? (sel ? `Sketch: ${sel} üzerinde aç` : 'Sketch: bir düzlem (ağaçta Ön / Üst / Sağ) ya da düz bir yüzey seçin, sonra basın')}
      disabled={disabled}
      active={picking}
      onClick={() => runCommand('sketch', 'Sketch', sketchCommand)}
    />
  );
}

function FeaturesTab() {
  const { activeBodyId, sketchOpen, featureOpen } = useAssembly(
    useShallow((s) => ({ activeBodyId: s.modeling.activeBodyId, sketchOpen: !!s.modeling.sketch, featureOpen: !!s.modeling.feature })),
  );
  const blockers = useAssembly(useShallow((s) => FEATURE_TOOLS.map((t) => toolBlocker(s, t.needs))));
  const suggestion = useCommandUi((s) => s.suggestion);
  return (
    <>
      <CmdButton
        icon={<CIcon name="done" size={22} />}
        label="Montaja dön"
        title={sketchOpen ? "Önce sketch'ten çıkın" : 'Parça düzenlemesini bitir, montaja dön (açık özellik iptal edilir)'}
        disabled={sketchOpen || !activeBodyId}
        onClick={() => exitBody()}
      />
      <Sep />
      <SketchButton
        disabled={sketchOpen || featureOpen}
        title={sketchOpen ? 'Sketch oturumu zaten açık' : featureOpen ? 'Önce açık özelliği bitirin' : undefined}
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
        <SketchButton disabled={featureOpen} title={featureOpen ? 'Önce açık özelliği bitirin' : undefined} />
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
  const selBody = useAssembly(selectedBodyId);
  const mateTool = ui.tool === 'mate';
  const gizmoTitle = mateTool ? ' (Mate aracı açıkken gizmo kullanılmaz)' : '';
  return (
    <>
      <CmdButton
        icon={<CIcon name="addFile" size={22} />}
        label="Bileşen ekle"
        title="Montaja STEP / IGES / BREP dosyası ekle (Ctrl+O; sürükle-bırak da olur)"
        disabled={sketchOpen}
        onClick={openFilePicker}
      />
      <CmdButton
        icon={<CIcon name="newPart" size={22} />}
        label="Yeni parça"
        title="Montajda yeni parça modelle: parça kipine girer, ağaçta düzlem seçip Sketch'e basın"
        disabled={sketchOpen}
        onClick={() => runCommand('newpart', 'Yeni parça', newPart)}
      />
      <CmdButton
        icon={<CIcon name="editPart" size={22} />}
        label="Parçayı düzenle"
        title={selBody ? 'Seçili parçanın unsur ağacını düzenle (sahnede ya da ağaçta çift tık da olur)' : 'Önce çizilmiş bir parça seçin'}
        disabled={!selBody || sketchOpen}
        onClick={() => selBody && enterBody(selBody)}
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
  const shot = () => void exportPng();
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
