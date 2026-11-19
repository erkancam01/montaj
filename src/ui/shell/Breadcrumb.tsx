// Viewport sol üstünde yol işareti: Montaj ▸ Parça ▸ Sketch. "Montaj"a tıklamak parça kipinden çıkar.
import { useShallow } from 'zustand/react/shallow';
import { exitBody } from '@/state/modelingActions';
import { useAssembly } from '@/state/useAssembly';
import '@/ui/shell/shell.css';

export function Breadcrumb() {
  const info = useAssembly(
    useShallow((s) => {
      const id = s.modeling.activeBodyId;
      if (!id) return null;
      return {
        part: s.doc.bodies.find((b) => b.id === id)?.name ?? 'Parça',
        sketch: s.modeling.sketch?.data.name ?? null,
        feature: s.modeling.feature?.draft.name ?? null,
      };
    }),
  );
  if (!info) return null;
  const locked = !!info.sketch;
  return (
    <nav className="breadcrumb" aria-label="Konum">
      <button
        type="button"
        className="breadcrumb-link"
        disabled={locked}
        title={locked ? "Önce sketch'ten çıkın" : 'Montaja dön'}
        onClick={() => exitBody()}
      >
        Montaj
      </button>
      <span className="breadcrumb-sep">▸</span>
      <span className={info.sketch || info.feature ? '' : 'breadcrumb-cur'}>{info.part}</span>
      {(info.sketch || info.feature) && (
        <>
          <span className="breadcrumb-sep">▸</span>
          <span className="breadcrumb-cur">{info.sketch ?? info.feature}</span>
        </>
      )}
    </nav>
  );
}
