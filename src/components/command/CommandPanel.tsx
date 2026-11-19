// Sol komut paneli: sketch / özellik / mate komutu açıkken ağacın yerinde o komutun ayarları; üstte yeşil ✓
// (onayla) ve kırmızı ✕ (iptal). Sahnenin sağ üst köşesindeki onay köşesi (ConfirmCorner) de aynı eylemleri kullanır.
import { useShallow } from 'zustand/react/shallow';
import { getFaceGeom } from '../../lib/faceGeometry';
import { FACE_KIND_LABELS } from '../../lib/mateMeta';
import { cancelFeature, FEATURE_LABELS, finishSketch } from '../../modeling/actions';
import { useAssembly } from '../../store/useAssembly';
import type { Feature } from '../../types';
import { IconMate } from '../icons';
import { MateInspector } from '../MateInspector';
import { FeatureInspector, tryApplyFeature, useFeatureInvalid } from '../modeling/FeatureInspector';
import { featureIconName, FIcon } from '../modeling/featureIcons';
import { SketchInspector } from '../sketch/SketchInspector';
import { confirmCancel } from '../sketch/SketchToolbar';
import { CIcon } from './commandIcons';
import { acceptMateSession, cancelMateSession, mateSessionAdded } from './commands';
import { useMobileUi } from '../mobile/mobileStore';
import './command.css';

export type CommandKind = 'sketch' | 'feature' | 'mate' | null;

export function useCommandKind(): CommandKind {
  return useAssembly((s) => (s.modeling.sketch ? 'sketch' : s.modeling.feature ? 'feature' : s.ui.tool === 'mate' ? 'mate' : null));
}

export function useCommandPanelOpen(): boolean {
  return useCommandKind() !== null;
}

export interface CommandActions {
  title: string;
  okLabel: string;
  cancelLabel: string;
  okDisabled: string | null;
  ok(): void;
  cancel(): void;
}

/** Açık komutun ✓ / ✕ eylemleri */
export function useCommandActions(): CommandActions | null {
  const kind = useCommandKind();
  const invalid = useFeatureInvalid();
  const featureTitle = useAssembly((s) => {
    const d = s.modeling.feature?.draft;
    if (!d) return '';
    return d.type === 'extrude' && d.operation === 'cut' ? 'Kesme' : FEATURE_LABELS[d.type];
  });
  const sketchName = useAssembly((s) => s.modeling.sketch?.data.name ?? 'Sketch');
  if (kind === 'sketch') {
    return {
      title: sketchName,
      okLabel: "Sketch'ten çık (kaydet)",
      cancelLabel: 'Sketch değişikliklerini at',
      okDisabled: null,
      ok: () => finishSketch(),
      cancel: confirmCancel,
    };
  }
  if (kind === 'feature') {
    return {
      title: featureTitle,
      okLabel: 'Uygula (Enter)',
      cancelLabel: 'İptal (Esc)',
      okDisabled: invalid,
      ok: () => void tryApplyFeature(),
      cancel: () => cancelFeature(),
    };
  }
  if (kind === 'mate') {
    return {
      title: 'Mate',
      okLabel: 'Bitti: kurulan mate’ler kalır (Enter)',
      cancelLabel: 'İptal: bu oturumda kurulan mate’leri kaldır',
      okDisabled: null,
      ok: acceptMateSession,
      cancel: cancelMateSession,
    };
  }
  return null;
}

export function OkCancel({ a, compact }: { a: CommandActions; compact?: boolean }) {
  return (
    <div className={`okc ${compact ? 'compact' : ''}`}>
      <button
        type="button"
        className="okc-btn ok"
        disabled={!!a.okDisabled}
        title={a.okDisabled ?? a.okLabel}
        aria-label={a.okLabel}
        onClick={a.ok}
      >
        <CIcon name="done" size={compact ? 18 : 16} />
      </button>
      <button type="button" className="okc-btn cancel" title={a.cancelLabel} aria-label={a.cancelLabel} onClick={a.cancel}>
        <CIcon name="close" size={compact ? 18 : 16} />
      </button>
    </div>
  );
}

export function CommandPanel() {
  const kind = useCommandKind();
  const a = useCommandActions();
  const icon = useAssembly((s) => {
    const d = s.modeling.feature?.draft;
    return d ? featureIconName(d as Feature & { operation?: string }) : null;
  });
  if (!kind || !a) return null;
  return (
    <div className="cmd-panel">
      <header className="cmd-panel-head">
        <span className="cmd-panel-icon">
          {kind === 'sketch' ? <FIcon name="sketch" /> : kind === 'mate' ? <IconMate size={16} /> : icon ? <FIcon name={icon} /> : null}
        </span>
        <span className="cmd-panel-title" title={a.title}>
          {a.title}
        </span>
        <SheetToggle />
        <OkCancel a={a} />
      </header>
      {kind === 'feature' && a.okDisabled && <div className="cmd-panel-msg">{a.okDisabled}</div>}
      <div className="panel-body cmd-panel-body inspector">
        {kind === 'sketch' && <SketchInspector />}
        {kind === 'feature' && <FeatureInspector />}
        {kind === 'mate' && <MatePanel />}
      </div>
    </div>
  );
}

/** Dar ekranda komut sayfasını başlık satırına daraltır / açar (masaüstünde gizli) */
function SheetToggle() {
  const min = useMobileUi((s) => s.sheetMin);
  return (
    <button
      type="button"
      className={`cmd-sheet-toggle ${min ? 'min' : ''}`}
      aria-label={min ? 'Komut panelini aç' : 'Komut panelini daralt'}
      aria-expanded={!min}
      onClick={() => useMobileUi.getState().set({ sheetMin: !min })}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3 5.5 7 9.5 11 5.5" />
      </svg>
    </button>
  );
}

/** Mate aracı adımları + yeni kurulan mate'in ayarları */
function MatePanel() {
  const { pending, partName, fileId, nodeKey, mateSel } = useAssembly(
    useShallow((s) => {
      const f = s.pendingFace;
      const part = f ? s.doc.parts.find((p) => p.id === f.partId) : undefined;
      return { pending: f, partName: part?.name, fileId: part?.fileId, nodeKey: part?.nodeKey, mateSel: s.mateSelection };
    }),
  );
  // Oturumda kurulan mate sayısı (belge değişince yeniden hesaplanır)
  const added = useAssembly((s) => (s.doc.mates.length >= 0 ? mateSessionAdded().length : 0));
  useAssembly((s) => (fileId ? s.fileStatus[fileId]?.status : undefined));
  let kind: string | null = null;
  if (pending && fileId !== undefined && nodeKey !== undefined) {
    try {
      const g = getFaceGeom({ fileId, nodeKey }, pending.meshIndex, pending.faceIndex);
      if (g) kind = FACE_KIND_LABELS[g.kind];
    } catch {
      kind = null;
    }
  }
  return (
    <div className="props">
      <section className="prop-section">
        <div className="prop-title">Mate seçimleri</div>
        <ol className="mate-steps">
          <li className={pending ? 'done' : 'current'}>
            <b>1.</b> Referans yüzey (yerinde kalır)
            {pending && (
              <div className="mate-step-val">
                {kind ?? 'yüzey'}
                {partName ? ` · ${partName}` : ''}
              </div>
            )}
          </li>
          <li className={pending ? 'current' : ''}>
            <b>2.</b> Hareket edecek parçanın yüzeyi
          </li>
        </ol>
        <div className="prop-meta">
          {added ? `Bu oturumda ${added} mate kuruldu.` : 'Sahnede yüzeylere tıklayın.'} Esc: seçimi geri al.
        </div>
      </section>
      {mateSel && <MateInspector key={mateSel} id={mateSel} />}
    </div>
  );
}
