// Araç çubuğunun modelleme bölümü: yeni parça, parça düzenleme, sketch ve özellik araçları, STEP çıktısı.
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { downloadBlob } from '../../lib/download';
import {
  BASE_PLANES,
  bodyIdOfPart,
  createBody,
  enterBody,
  exitBody,
  FEATURE_LABELS,
  getBody,
  newFeatureDraft,
  planeFromFace,
  startFeature,
  startSketch,
} from '../../modeling/actions';
import { exportAssemblyAsStep } from '../../modeling/exportStep';
import { useAssembly, type AssemblyState } from '../../store/useAssembly';
import type { FeatureType } from '../../types';
import { bodyIdOfFile, isBodyFileId } from '../../types';
import { FIcon, type IconName } from './featureIcons';
import './modeling.css';

type Tool = Exclude<FeatureType, 'sketch'> | 'cut';

const SKETCH_PLANE_KEY = 'sketch-plane';

/** Sahnede seçili öğenin gövdesi (instance ya da parça) */
function selectedBodyId(s: AssemblyState): string | null {
  const sel = s.selection;
  if (!sel) return null;
  if (sel.kind === 'instance') {
    const inst = s.doc.instances.find((i) => i.id === sel.id);
    return inst && isBodyFileId(inst.fileId) ? bodyIdOfFile(inst.fileId) : null;
  }
  if (sel.kind === 'part') return bodyIdOfPart(sel.id);
  return null;
}

function nextName(base: string, existing: string[]): string {
  let n = 1;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Aracı başlatır: varsayılan taslakla özellik oturumu açar */
export function startTool(bodyId: string, tool: Tool) {
  if (tool === 'cut') {
    const d = newFeatureDraft(bodyId, 'extrude');
    if (d.type !== 'extrude') return;
    const names = getBody(bodyId)?.features.map((f) => f.name) ?? [];
    startFeature(bodyId, { ...d, operation: 'cut', name: nextName('Kesme', names) });
    return;
  }
  startFeature(bodyId, newFeatureDraft(bodyId, tool));
}

const TOOLS: { tool: Tool; label: string; icon: IconName; needs: 'sketch' | 'solid' | 'sketch+solid'; title: string }[] = [
  { tool: 'extrude', label: 'Extrude', icon: 'extrude', needs: 'sketch', title: 'Sketch profilini doğrusal uzatarak katı ekle' },
  { tool: 'cut', label: 'Kesme', icon: 'cut', needs: 'sketch+solid', title: 'Sketch profilini uzatıp gövdeden çıkar' },
  { tool: 'revolve', label: 'Revolve', icon: 'revolve', needs: 'sketch', title: 'Sketch profilini bir eksen etrafında döndür' },
  { tool: 'fillet', label: FEATURE_LABELS.fillet, icon: 'fillet', needs: 'solid', title: 'Seçilen kenarları yuvarlat' },
  { tool: 'chamfer', label: FEATURE_LABELS.chamfer, icon: 'chamfer', needs: 'solid', title: 'Seçilen kenarlara pah kır' },
  { tool: 'hole', label: FEATURE_LABELS.hole, icon: 'hole', needs: 'solid', title: 'Düz bir yüzeye delik aç' },
  { tool: 'linearPattern', label: 'Doğrusal desen', icon: 'linearPattern', needs: 'solid', title: 'Özellikleri bir yön boyunca çoğalt' },
  { tool: 'circularPattern', label: 'Dairesel desen', icon: 'circularPattern', needs: 'solid', title: 'Özellikleri bir eksen etrafında çoğalt' },
  { tool: 'mirror', label: FEATURE_LABELS.mirror, icon: 'mirror', needs: 'solid', title: 'Özellikleri ya da gövdeyi bir düzleme göre aynala' },
];

export function ModelingToolbar() {
  const { activeBodyId, sketchOpen, featureOpen, pickKey } = useAssembly(
    useShallow((s) => ({
      activeBodyId: s.modeling.activeBodyId,
      sketchOpen: !!s.modeling.sketch,
      featureOpen: !!s.modeling.feature,
      pickKey: s.modeling.pick?.key ?? null,
    })),
  );
  const selBody = useAssembly(selectedBodyId);
  const { hasSketch, hasSolid } = useAssembly(
    useShallow((s) => {
      const b = activeBodyId ? s.doc.bodies.find((x) => x.id === activeBodyId) : undefined;
      const fs = (b?.features ?? []).filter((f) => !f.suppressed);
      return {
        hasSketch: fs.some((f) => f.type === 'sketch'),
        hasSolid: fs.some((f) => (f.type === 'extrude' || f.type === 'revolve') && f.operation === 'add'),
      };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Sketch düzlemi için yüzey seçildi → sketch başlat
  const picked = useAssembly((s) => (s.modeling.pick?.key === SKETCH_PLANE_KEY ? s.modeling.pick.picked : null));
  useEffect(() => {
    if (!picked?.length) return;
    const st = useAssembly.getState();
    const bodyId = st.modeling.activeBodyId;
    const t = picked[0];
    st.endPick();
    if (!bodyId || t.kind !== 'face') return;
    const plane = planeFromFace(bodyId, t.ref);
    if (!plane) {
      st.showToast('Seçilen yüzey düz değil; düz bir yüzey seçin.', 'error');
      return;
    }
    startSketch(bodyId, plane);
  }, [picked]);

  // Menü dışına tıklayınca kapat
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Düzenleme modu kapanınca menü de kapanır
  useEffect(() => {
    if (!activeBodyId || sketchOpen) setMenuOpen(false);
  }, [activeBodyId, sketchOpen]);

  const onNewBody = () => {
    createBody();
    // Yeni parça: önce çizim düzlemi sorulur
    setMenuOpen(true);
  };

  const onExport = async () => {
    if (busy) return;
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  const pickSketchFace = () => {
    setMenuOpen(false);
    useAssembly.getState().startPick({
      key: SKETCH_PLANE_KEY,
      kinds: ['face'],
      filter: ['plane'],
      multi: false,
      prompt: 'Çizim için düz bir yüzey seçin',
    });
  };

  const sketchOn = (k: keyof typeof BASE_PLANES) => {
    setMenuOpen(false);
    if (activeBodyId) startSketch(activeBodyId, BASE_PLANES[k]);
  };

  const editing = !!activeBodyId;
  const toolsLocked = sketchOpen || featureOpen;
  const lockReason = sketchOpen
    ? 'Sketch oturumu açıkken kullanılamaz'
    : featureOpen
      ? 'Önce açık özelliği uygulayın ya da iptal edin'
      : null;

  return (
    <>
      <div className="tb-sep" aria-hidden="true" />
      <div className="tb-group mdl-tb">
        <span className="tb-label">Modelleme</span>
        <button
          type="button"
          className="btn"
          disabled={sketchOpen}
          title={sketchOpen ? 'Sketch oturumu açıkken kullanılamaz' : 'Yeni parametrik parça oluştur ve çizime başla'}
          onClick={onNewBody}
        >
          <FIcon name="body" /> Yeni parça
        </button>
        {!editing && selBody && (
          <button
            type="button"
            className="btn btn-primary"
            title="Seçili parçanın özellik geçmişini düzenle (sahnede çift tık da olur)"
            onClick={() => enterBody(selBody)}
          >
            <FIcon name="pencil" /> Parçayı düzenle
          </button>
        )}

        {editing && (
          <>
            <div className="mdl-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className={`btn ${menuOpen ? 'btn-toggle on' : ''} ${pickKey === SKETCH_PLANE_KEY ? 'btn-toggle on' : ''}`}
                disabled={toolsLocked}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={lockReason ?? 'Yeni sketch: çizim düzlemi seçin'}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <FIcon name="sketch" /> Sketch <span className="mdl-caret">▾</span>
              </button>
              {menuOpen && (
                <div className="mdl-menu" role="menu">
                  <div className="mdl-menu-title">Çizim düzlemi</div>
                  {(['XY', 'XZ', 'YZ'] as const).map((k) => (
                    <button key={k} type="button" role="menuitem" className="mdl-menu-item" onClick={() => sketchOn(k)}>
                      <span className={`mdl-plane-chip plane-${k}`}>{k}</span> {k} düzlemi
                    </button>
                  ))}
                  <div className="mdl-menu-sep" />
                  <button type="button" role="menuitem" className="mdl-menu-item" onClick={pickSketchFace}>
                    <span className="mdl-plane-chip">▱</span> Yüzey seç…
                  </button>
                </div>
              )}
            </div>
            {TOOLS.map((t) => {
              const missing =
                (t.needs.includes('sketch') && !hasSketch && 'Gövdede sketch yok: önce bir sketch çizin') ||
                (t.needs.includes('solid') && !hasSolid && 'Gövdede katı yok: önce Extrude ya da Revolve ile katı oluşturun') ||
                null;
              const why = lockReason ?? missing;
              return (
                <button
                  key={t.tool}
                  type="button"
                  className="btn mdl-tool"
                  disabled={!!why}
                  title={why ? `${t.label}: ${why}` : `${t.label}: ${t.title}`}
                  onClick={() => activeBodyId && startTool(activeBodyId, t.tool)}
                >
                  <FIcon name={t.icon} />
                  <span className="mdl-tool-label">{t.label}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="btn btn-primary"
              disabled={sketchOpen}
              title={sketchOpen ? 'Önce sketch oturumunu bitirin' : 'Parça düzenlemesini bitir (açık özellik iptal edilir)'}
              onClick={() => exitBody()}
            >
              <FIcon name="check" /> Düzenlemeyi bitir
            </button>
          </>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy}
          title="Tüm görünür montajı (çizilen ve içe aktarılan parçalar) STEP olarak dışa aktar"
          onClick={() => void onExport()}
        >
          {busy ? 'STEP…' : 'STEP'}
        </button>
      </div>
    </>
  );
}
