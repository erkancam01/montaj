// Viewport üstündeki komut katmanları: sağ üst onay köşesi, yüzey bağlam kutusu, sağ tık menüsü, S menüsü ve
// sketch bitince Extrude önerisi.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useAssembly } from '@/state/useAssembly';
import { FIcon } from '@/ui/icons/featureIcons';
import { runFeatureTool } from '@/ui/shell/Toolbar';
import { CIcon } from '@/ui/icons/commandIcons';
import { OkCancel, useCommandActions, useCommandKind } from '@/ui/commands/CommandPanel';
import { runCommand, startTool } from '@/ui/commands/commands';
import { useCommandUi } from '@/ui/commands/commandStore';
import { contextBoxItems, emptyMenu, partMenu, sMenuEntries } from '@/ui/commands/menus';
import { PopupMenu } from '@/ui/commands/PopupMenu';
import { MatePopup } from '@/ui/assembly/MatePopup';
import '@/ui/commands/command.css';

export function ContextUi() {
  return (
    <>
      <ConfirmCorner />
      <ExtrudeSuggestion />
      <ContextBox />
      <ContextMenu />
      <SMenu />
      <MatePopup />
    </>
  );
}

/** Sahnenin sağ üst köşesi: açık komutun ✓ / ✕ düğmeleri */
function ConfirmCorner() {
  const a = useCommandActions();
  const kind = useCommandKind();
  if (!a) return null;
  return (
    <div className="confirm-corner" role="group" aria-label="Komutu onayla ya da iptal et">
      <span className="confirm-corner-title">{kind === 'sketch' ? "Sketch'ten çık" : a.title}</span>
      <OkCancel a={a} compact />
    </div>
  );
}

function ExtrudeSuggestion() {
  const sug = useCommandUi((s) => s.suggestion);
  const live = useAssembly((s) => !!sug && s.doc.bodies.some((b) => b.id === sug.bodyId && b.features.some((f) => f.id === sug.sketchId)));
  // Bir süre sonra kendiliğinden kaybolur
  useEffect(() => {
    if (!sug) return;
    const t = window.setTimeout(() => useCommandUi.getState().set({ suggestion: null }), 15000);
    return () => window.clearTimeout(t);
  }, [sug]);
  if (!sug || !live) return null;
  const close = () => useCommandUi.getState().set({ suggestion: null });
  const go = (tool: 'extrude' | 'cut') => {
    close();
    runCommand(`feature-${tool}`, tool === 'cut' ? 'Kesme' : 'Extrude', () => startTool(sug.bodyId, tool, sug.sketchId));
  };
  return (
    <div className="suggest-wrap">
      <div className="suggest" role="status">
        <span className="suggest-text">
          <b>{sug.sketchName}</b> bitti. Sonraki adım:
        </span>
        <button type="button" className="btn btn-primary btn-small" title="Bu sketch'i uzatarak katı oluştur" onClick={() => go('extrude')}>
          <FIcon name="extrude" size={14} /> Extrude
        </button>
        {sug.hasSolid && (
          <button type="button" className="btn btn-small" title="Bu sketch ile gövdeden malzeme kaldır" onClick={() => go('cut')}>
            <FIcon name="cut" size={14} /> Kesme
          </button>
        )}
        <button type="button" className="btn btn-small btn-ghost" title="Revolve" onClick={() => {
          close();
          runFeatureTool('revolve');
        }}>
          <FIcon name="revolve" size={14} /> Revolve
        </button>
        <button type="button" className="suggest-close" aria-label="Kapat" title="Kapat" onClick={close}>
          <CIcon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}

/** Yüzeye sol tıkta imleç yanında küçük simge kutusu */
function ContextBox() {
  const box = useCommandUi((s) => s.contextBox);
  const ref = useRef<HTMLDivElement>(null);
  // İmleç kutudan uzaklaşınca ya da Esc ile kapanır
  useEffect(() => {
    if (!box) return;
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
      if (Math.hypot(dx, dy) > 160) useCommandUi.getState().set({ contextBox: null });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useCommandUi.getState().set({ contextBox: null });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [box]);
  // Kutu sahne alanından (canvas) taşmasın: yan panellerin altında kalmasın
  useLayoutEffect(() => {
    const el = ref.current;
    const cv = document.querySelector('canvas');
    if (!el || !box || !cv) return;
    const c = cv.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = box.x + 14;
    let top = box.y + 10;
    if (left + r.width > c.right - 4) left = Math.max(c.left + 4, box.x - 14 - r.width);
    if (top + r.height > c.bottom - 4) top = Math.max(c.top + 4, box.y - 10 - r.height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [box]);
  if (!box?.hit) return null;
  const items = contextBoxItems(box.hit);
  return (
    <div
      ref={ref}
      className="ctx-box"
      role="toolbar"
      aria-label="Bağlam araçları"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="ctx-btn"
          disabled={it.disabled}
          title={it.title ? `${it.label}: ${it.title}` : it.label}
          aria-label={it.label}
          onClick={() => {
            useCommandUi.getState().set({ contextBox: null });
            it.onClick?.();
          }}
        >
          {typeof it.icon === 'string' ? <CIcon name={it.icon as never} size={18} /> : it.icon}
        </button>
      ))}
    </div>
  );
}

function ContextMenu() {
  const m = useCommandUi((s) => s.contextMenu);
  if (!m) return null;
  const entries = m.hit ? partMenu(m.hit) : emptyMenu();
  if (!entries.length) return null;
  return <PopupMenu x={m.x} y={m.y} entries={entries} onClose={() => useCommandUi.getState().set({ contextMenu: null })} />;
}

function SMenu() {
  const m = useCommandUi((s) => s.sMenu);
  if (!m) return null;
  return (
    <PopupMenu
      x={m.x - 20}
      y={m.y - 20}
      grid
      className="smenu"
      entries={sMenuEntries()}
      onClose={() => useCommandUi.getState().set({ sMenu: null })}
    />
  );
}
