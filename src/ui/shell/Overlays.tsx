// Viewport üzerindeki katmanlar: boş durum, sürükle-bırak, işler listesi, mate ipucu, bildirim.
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDropZone } from '@/ui/hooks/useDropZone';
import { getFaceGeom } from '@/core/geometry/faceGeometry';
import { FACE_KIND_LABELS } from '@/core/assembly/mateMeta';
import { useAssembly } from '@/state/useAssembly';
import { importWithConfirm } from '@/ui/shell/importWithConfirm';
import { IconClose, IconMate, IconPlus, IconUpload } from '@/ui/icons/icons';
import { NewCards, startAssembly, startNewPart } from '@/ui/shell/NewDialog';
import { Breadcrumb } from '@/ui/shell/Breadcrumb';
import { AddFilesButton } from '@/ui/shell/Toolbar';
import { SketchToolbar } from '@/ui/sketch/SketchToolbar';
import { PickHint } from '@/ui/modeling/PickHint';
import { ContextUi } from '@/ui/commands/ContextUi';

export function Overlays() {
  return (
    <div className="overlays">
      <EmptyState />
      <Breadcrumb />
      <JobList />
      <MateHint />
      <SketchToolbar />
      <PickHint />
      <ContextUi />
      <Toast />
      <DropLayer />
    </div>
  );
}

function EmptyState() {
  const show = useAssembly((s) => s.doc.instances.length === 0 && s.jobs.length === 0);
  if (!show) return null;
  return (
    <div className="empty-state">
      <div className="empty-card">
        <div className="empty-title">Başlamak için seçin</div>
        <NewCards onPart={startNewPart} onAssembly={startAssembly} />
        <div className="empty-divider">
          <span>ya da</span>
        </div>
        <div className="empty-icon">
          <IconUpload size={24} />
        </div>
        <div className="empty-sub">STEP / IGES / BREP dosyalarını ya da proje .zip'ini buraya sürükleyin</div>
        <AddFilesButton>
          <IconPlus /> Dosya aç
        </AddFilesButton>
      </div>
    </div>
  );
}

/** Mate aracı açıkken viewport'un üst ortasında kalıcı ipucu */
function MateHint() {
  const { active, pending, partName, fileId, nodeKey } = useAssembly(
    useShallow((s) => {
      const f = s.pendingFace;
      const part = f ? s.doc.parts.find((p) => p.id === f.partId) : undefined;
      return {
        active: s.ui.tool === 'mate',
        pending: f,
        partName: part?.name,
        fileId: part?.fileId,
        nodeKey: part?.nodeKey,
      };
    }),
  );
  // geometryCache reaktif değil; dosya hazır olunca yüzey türünü yeniden oku
  useAssembly((s) => (fileId ? s.fileStatus[fileId]?.status : undefined));
  if (!active) return null;

  let kind: string | null = null;
  if (pending && fileId !== undefined && nodeKey !== undefined) {
    try {
      const g = getFaceGeom({ fileId, nodeKey }, pending.meshIndex, pending.faceIndex);
      if (g) kind = FACE_KIND_LABELS[g.kind];
    } catch (e) {
      console.error('Yüzey geometrisi okunamadı', e);
    }
  }

  return (
    <div className="mate-hint-wrap">
      <div className="mate-hint-band" role="status" aria-live="polite">
        <IconMate size={14} />
        {pending ? (
          <>
            <span className="mate-hint-step">2. yüzeyi seç (bu parça hareket eder)</span>
            <span className="mate-hint-face" title="Seçilen referans yüzey">
              Referans: {kind ?? 'yüzey'}
              {partName ? ` · ${partName}` : ''}
            </span>
          </>
        ) : (
          <span className="mate-hint-step">Mate: 1. yüzeyi seç (referans, yerinde kalır)</span>
        )}
        <span className="mate-hint-esc">
          <kbd>Esc</kbd> {pending ? 'iptal' : 'çık'}
        </span>
      </div>
    </div>
  );
}

function JobList() {
  const jobs = useAssembly((s) => s.jobs);
  const removeJob = useAssembly((s) => s.removeJob);
  if (!jobs.length) return null;
  return (
    <div className="jobs" role="status" aria-live="polite">
      {jobs.map((j) => (
        <div key={j.id} className={`job ${j.status === 'error' ? 'job-error' : ''}`}>
          {j.status === 'loading' ? <span className="spinner" aria-hidden="true" /> : <span className="job-dot" aria-hidden="true" />}
          <div className="job-body">
            <div className="job-name" title={j.name}>
              {j.name}
            </div>
            {j.status === 'loading' ? (
              <div className="job-sub">Yükleniyor…</div>
            ) : (
              <div className="job-sub" title={j.error}>
                {j.error ?? 'İçe aktarma başarısız'}
              </div>
            )}
          </div>
          {j.status === 'error' && (
            <button type="button" className="job-close" title="Kapat" aria-label="Kapat" onClick={() => removeJob(j.id)}>
              <IconClose size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const TOAST_MS = 4000;

function Toast() {
  const toast = useAssembly((s) => s.toast);
  // Mate ipucu bandı üstte durduğunda bildirim onun altına iner
  const belowHint = useAssembly((s) => s.ui.tool === 'mate');
  const [hiddenId, setHiddenId] = useState<number | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = toast.id;
    const t = window.setTimeout(() => setHiddenId(id), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  if (!toast || toast.id === hiddenId) return null;
  return (
    <div className={`toast-wrap ${belowHint ? 'below-hint' : ''}`}>
      <div
        key={toast.id}
        className={`toast toast-${toast.kind}`}
        role={toast.kind === 'error' ? 'alert' : 'status'}
        onClick={() => setHiddenId(toast.id)}
        title="Kapatmak için tıklayın"
      >
        {toast.text}
      </div>
    </div>
  );
}

function DropLayer() {
  const active = useDropZone(importWithConfirm);
  if (!active) return null;
  return (
    <div className="drop-layer">
      <div className="drop-card">
        <IconUpload size={32} />
        <div>Dosyaları bırakın (STEP, IGES, BREP veya proje .zip)</div>
      </div>
    </div>
  );
}
