// Viewport üstünde seçim isteği bandı: istem metni, seçilen sayısı, Bitti / İptal. Esc iptal eder.
// Delik merkezi ekleme modunda da benzer bir bant gösterilir.
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { updateFeatureDraft } from '../../modeling/actions';
import { useAssembly } from '../../store/useAssembly';
import { useModelingUi } from './modelingUi';
import './modeling.css';

function cancelPick() {
  const s = useAssembly.getState();
  // Kenar seçimi taslağa anında işlenir: iptal edilince başlangıç listesi geri yüklenir
  const snap = useModelingUi.getState().edgeSnapshot;
  const d = s.modeling.feature?.draft;
  if (s.modeling.pick?.key === 'edges' && snap && d && (d.type === 'fillet' || d.type === 'chamfer')) updateFeatureDraft({ edges: snap });
  s.setPicked([]);
  s.endPick();
}

export function PickHint() {
  const info = useAssembly(
    useShallow((s) => {
      const p = s.modeling.pick;
      if (!p) return null;
      const d = s.modeling.feature?.draft;
      // Radyus/pah kenarları taslağa anında işlenir; sayı taslaktan okunur
      const count = p.key === 'edges' && d && (d.type === 'fillet' || d.type === 'chamfer') ? d.edges.length : p.picked.length;
      return { key: p.key, prompt: p.prompt, multi: p.multi, count, kinds: p.kinds.join(',') };
    }),
  );
  const holePlace = useAssembly((s) => s.modeling.feature?.draft.type === 'hole' && !s.modeling.pick && !s.modeling.sketch);
  const holeOn = useModelingUi((s) => s.holePlace);
  const holeCount = useAssembly((s) => {
    const d = s.modeling.feature?.draft;
    return d?.type === 'hole' ? d.points.length : 0;
  });
  const showHole = holePlace && holeOn;
  const active = !!info || showHole;

  // Esc: seçimi iptal et (genel kısayollardan önce yakalanır)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.preventDefault();
      e.stopPropagation();
      if (useAssembly.getState().modeling.pick) cancelPick();
      else useModelingUi.getState().set({ holePlace: false });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);

  if (!info && !showHole) return null;

  if (!info) {
    return (
      <div className="mate-hint-wrap">
        <div className="mate-hint-band pick-band" role="status" aria-live="polite">
          <span className="pick-dot" aria-hidden="true" />
          <span className="mate-hint-step">Delik merkezi eklemek için yüzeye tıklayın</span>
          <span className="mate-hint-face">{holeCount} nokta</span>
          <button type="button" className="btn btn-small btn-primary" onClick={() => useModelingUi.getState().set({ holePlace: false })}>
            Bitti
          </button>
          <span className="mate-hint-esc">
            <kbd>Esc</kbd> bitir
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mate-hint-wrap">
      <div className="mate-hint-band pick-band" role="status" aria-live="polite">
        <span className="pick-dot" aria-hidden="true" />
        <span className="mate-hint-step">{info.prompt}</span>
        {info.multi && <span className="mate-hint-face">{info.count} seçili</span>}
        {info.multi && (
          <button type="button" className="btn btn-small btn-primary" title="Seçimi bitir" onClick={() => useAssembly.getState().endPick()}>
            Bitti
          </button>
        )}
        <button type="button" className="btn btn-small" title="Seçimi iptal et (Esc)" onClick={cancelPick}>
          İptal
        </button>
        <span className="mate-hint-esc">
          <kbd>Esc</kbd> iptal
        </span>
      </div>
    </div>
  );
}
