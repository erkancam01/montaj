import { useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { downloadBlob } from '../lib/download';
import { ACCEPT_ATTR } from '../lib/formats';
import { selectedPartIds } from '../lib/rigid';
import { exportProjectZip, newProject } from '../lib/session';
import { viewerApi } from '../lib/viewerApi';
import { groupSelection, ungroup } from '../store/actions';
import { useAssembly } from '../store/useAssembly';
import { selectedGroupId } from './GroupList';
import { importWithConfirm, isDocEmpty } from './importWithConfirm';
import { IconFit, IconGroup, IconMate, IconPlus, IconRedo, IconUndo, IconUngroup } from './icons';
import { ModelingToolbar } from './modeling/ModelingToolbar';

const MOVE_STEPS = [0.1, 0.5, 1, 5, 10, 50, 100];
const ANGLE_STEPS = [1, 5, 15, 30, 45, 90];

/** Gizli dosya seçicili "Dosya ekle" düğmesi (araç çubuğu ve boş durum kartı kullanır) */
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
    </>
  );
}

function Sep() {
  return <div className="tb-sep" aria-hidden="true" />;
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

export function Toolbar() {
  const ui = useAssembly((s) => s.ui);
  const setUi = useAssembly((s) => s.setUi);
  const { canUndo, canRedo, empty } = useAssembly(
    useShallow((s) => ({
      canUndo: s.past.length > 0,
      canRedo: s.future.length > 0,
      empty: s.doc.instances.length === 0 && s.doc.files.length === 0,
    })),
  );
  const selCount = useAssembly((s) => selectedPartIds(s.doc, s.selection, s.extraSel).length);
  const groupId = useAssembly(selectedGroupId);
  const [busy, setBusy] = useState<string | null>(null);
  const mateTool = ui.tool === 'mate';

  const exportAs = async (what: string, make: () => Promise<Blob | null>, filename: string, emptyMsg: string) => {
    if (busy) return;
    setBusy(what);
    try {
      await runExport(make, filename, emptyMsg);
    } finally {
      setBusy(null);
    }
  };

  const onNew = async () => {
    if (!isDocEmpty() && !window.confirm('Mevcut proje temizlenecek. Devam edilsin mi?')) return;
    try {
      await newProject();
    } catch (err) {
      console.error(err);
      useAssembly.getState().showToast('Yeni proje oluşturulamadı', 'error');
    }
  };

  return (
    <header className="toolbar">
      <div className="tb-brand">STEP Montaj</div>
      <Sep />
      <AddFilesButton />
      <Sep />

      <div
        className={`tb-group ${mateTool ? 'tb-passive' : ''}`}
        title={mateTool ? 'Mate aracı açıkken gizmo kullanılmaz' : undefined}
      >
        <div className="seg" role="group" aria-label="Dönüşüm aracı">
          <button
            type="button"
            className={ui.mode === 'translate' ? 'active' : ''}
            aria-pressed={ui.mode === 'translate'}
            title="Taşı (W)"
            onClick={() => setUi({ mode: 'translate' })}
          >
            Taşı
          </button>
          <button
            type="button"
            className={ui.mode === 'rotate' ? 'active' : ''}
            aria-pressed={ui.mode === 'rotate'}
            title="Döndür (E)"
            onClick={() => setUi({ mode: 'rotate' })}
          >
            Döndür
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost tb-space"
          title="Gizmo ekseni: Dünya / Yerel (Q)"
          onClick={() => setUi({ space: ui.space === 'world' ? 'local' : 'world' })}
        >
          {ui.space === 'world' ? 'Dünya' : 'Yerel'}
        </button>
      </div>
      <Sep />

      <div className="tb-group">
        <button
          type="button"
          className={`btn btn-toggle ${ui.snap ? 'on' : ''}`}
          aria-pressed={ui.snap}
          title="Adımlı hareket (snap) aç/kapa"
          onClick={() => setUi({ snap: !ui.snap })}
        >
          Snap
        </button>
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
      <Sep />

      <div className="tb-group">
        <span className="tb-label">Seçim</span>
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
        <button
          type="button"
          className={`btn btn-toggle tb-mate ${mateTool ? 'on' : ''}`}
          aria-pressed={mateTool}
          title="Mate (M): iki yüzey seçerek parçaları bağla"
          onClick={() => setUi({ tool: mateTool ? 'select' : 'mate' })}
        >
          <IconMate /> Mate
        </button>
      </div>
      <Sep />

      <div className="tb-group">
        <button
          type="button"
          className="btn"
          disabled={selCount < 2}
          title={
            selCount < 2
              ? 'Grupla (Ctrl+G): önce Ctrl/Shift+tık ile en az iki parça seçin'
              : `Seçili ${selCount} parçayı tek rijit grupta birleştir (Ctrl+G)`
          }
          onClick={() => groupSelection()}
        >
          <IconGroup /> Grupla
        </button>
        <button
          type="button"
          className="btn"
          disabled={!groupId}
          title={groupId ? 'Grubu çöz; parçalar yerinde kalır (Ctrl+Shift+G)' : 'Grubu çöz (Ctrl+Shift+G): önce bir grup seçin'}
          onClick={() => groupId && ungroup(groupId)}
        >
          <IconUngroup /> Grubu çöz
        </button>
      </div>
      <Sep />

      <div className="tb-group">
        <button
          type="button"
          className="btn btn-icon"
          disabled={!canUndo}
          title="Geri al (Ctrl+Z)"
          aria-label="Geri al"
          onClick={() => useAssembly.getState().undo()}
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="btn btn-icon"
          disabled={!canRedo}
          title="Yinele (Ctrl+Y / Ctrl+Shift+Z)"
          aria-label="Yinele"
          onClick={() => useAssembly.getState().redo()}
        >
          <IconRedo />
        </button>
      </div>
      <Sep />

      <div className="tb-group">
        <button
          type="button"
          className="btn"
          title="Tüm montajı görünüme sığdır (seçim yokken F)"
          onClick={() => viewerApi.fit('all')}
        >
          <IconFit /> Sığdır
        </button>
        <button
          type="button"
          className={`btn btn-toggle ${ui.showEdges ? 'on' : ''}`}
          aria-pressed={ui.showEdges}
          title="Kenar çizgilerini göster/gizle"
          onClick={() => setUi({ showEdges: !ui.showEdges })}
        >
          Kenarlar
        </button>
      </div>

      <div className="tb-spacer" />

      <div className="tb-group">
        <span className="tb-label">Proje</span>
        <button type="button" className="btn" title="Yeni boş proje" onClick={onNew}>
          Yeni
        </button>
        <button
          type="button"
          className="btn"
          disabled={empty || !!busy}
          title="Projeyi kaynak dosyalarıyla birlikte .zip olarak indir"
          onClick={() => exportAs('zip', exportProjectZip, 'montaj-proje.zip', 'Kaydedilecek proje içeriği yok')}
        >
          {busy === 'zip' ? 'Kaydediliyor…' : 'Projeyi kaydet (.zip)'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={empty || !!busy}
          title="Görünür montajı GLB olarak dışa aktar"
          onClick={() => exportAs('glb', () => viewerApi.exportGLB(), 'montaj.glb', 'Dışa aktarılacak görünür parça yok')}
        >
          {busy === 'glb' ? 'GLB…' : 'GLB'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!!busy}
          title="Görünümün PNG ekran görüntüsünü indir"
          onClick={() => exportAs('png', () => viewerApi.screenshot(), 'montaj.png', 'Ekran görüntüsü alınamadı')}
        >
          {busy === 'png' ? 'PNG…' : 'PNG'}
        </button>
      </div>
      <ModelingToolbar />
    </header>
  );
}
