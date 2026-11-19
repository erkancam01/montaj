// Space ile imlecin yanında açılan görünüm menüsü (SolidWorks "Görünüm Yönlendirmesi").
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { fitAll, normalTo, setStandardView, STANDARD_VIEWS, type StandardView } from '../../lib/viewCommands';
import { useAssembly } from '../../store/useAssembly';
import './viewMenu.css';

interface ViewMenuState {
  pos: { x: number; y: number } | null;
}

const useViewMenu = create<ViewMenuState>(() => ({ pos: null }));

export function openViewMenu(x: number, y: number) {
  useViewMenu.setState({ pos: { x, y } });
}

export function closeViewMenu() {
  if (useViewMenu.getState().pos) useViewMenu.setState({ pos: null });
}

export function viewMenuOpen(): boolean {
  return useViewMenu.getState().pos !== null;
}

const ORDER: StandardView[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];

export function ViewMenu() {
  const pos = useViewMenu((s) => s.pos);
  const invertWheel = useAssembly((s) => s.ui.invertWheel);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Pencere kenarlarına taşmasın
  useLayoutEffect(() => {
    const el = ref.current;
    if (!pos || !el) {
      setPlace(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = pos.x + 12;
    let top = pos.y - 12;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, pos.x - 12 - r.width);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pad - r.height);
    setPlace({ left, top: Math.max(pad, top) });
  }, [pos]);

  // Dışarı tıklama / Esc / pencere kaybı kapatır
  useEffect(() => {
    if (!pos) return;
    const down = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      closeViewMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeViewMenu();
      }
    };
    const blur = () => closeViewMenu();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, [pos]);

  if (!pos) return null;

  const run = (fn: () => void) => () => {
    closeViewMenu();
    fn();
  };

  return (
    <div
      ref={ref}
      className="view-menu"
      role="menu"
      aria-label="Görünüm yönlendirmesi"
      style={place ? { left: place.left, top: place.top } : { left: pos.x + 12, top: pos.y - 12, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="view-menu-title">Görünüm</div>
      {ORDER.map((v) => (
        <button key={v} type="button" role="menuitem" className="view-menu-item" onClick={run(() => setStandardView(v))}>
          <span>{STANDARD_VIEWS[v].label}</span>
          <kbd>{STANDARD_VIEWS[v].key}</kbd>
        </button>
      ))}
      <div className="view-menu-sep" />
      <button type="button" role="menuitem" className="view-menu-item" onClick={run(() => normalTo())}>
        <span>Normal'e bak</span>
        <kbd>Ctrl+8</kbd>
      </button>
      <button type="button" role="menuitem" className="view-menu-item" onClick={run(fitAll)}>
        <span>Sığdır</span>
        <kbd>F</kbd>
      </button>
      <div className="view-menu-sep" />
      <label className="view-menu-check">
        <input
          type="checkbox"
          checked={invertWheel}
          onChange={(e) => useAssembly.getState().setUi({ invertWheel: e.target.checked })}
        />
        <span>Tekerlek yakınlaştırma yönünü ters çevir</span>
      </label>
    </div>
  );
}
