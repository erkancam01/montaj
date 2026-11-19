// Dokunmatik araç çubuğu (sahnenin sol alt köşesi; yalnız dokunmatik / kaba işaretçili cihazda).
// Taşı / Döndür: açıkken parçaya dokunup sürüklemek DragController'ın sol-sürükle taşı / sağ-sürükle
// döndür davranışını verir (mate'e göre kısıtlı); kapalıyken tek parmak kamerayı döndürür.
// Sığdır: tümüne sığdır. Görünüm: Space görünüm menüsünü düğmenin yanında açar.
import { useEffect, useState, type MouseEvent } from 'react';
import { fitAll } from '../../lib/viewCommands';
import { useAssembly } from '../../store/useAssembly';
import { closeViewMenu, openViewMenu } from './ViewMenu';
import { isTouchDevice, setTouchMode, useTouchMode, type TouchMode } from './touchState';
import './touch.css';

function useIsTouch(): boolean {
  const [touch, setTouch] = useState(isTouchDevice);
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(pointer: coarse)');
    } catch {
      return;
    }
    const on = () => setTouch(isTouchDevice());
    mq.addEventListener?.('change', on);
    // Kaba işaretçi bildirmeyen cihazlarda ilk dokunuşta görünür ol
    const first = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setTouch(true);
    };
    window.addEventListener('pointerdown', first, { passive: true });
    return () => {
      mq?.removeEventListener?.('change', on);
      window.removeEventListener('pointerdown', first);
    };
  }, []);
  return touch;
}

const IconMove = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
  </svg>
);
const IconRotate = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" />
  </svg>
);
const IconFit = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    <rect x="9" y="9" width="6" height="6" />
  </svg>
);
const IconView = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5M12 12v9M12 12L4 7.5" />
  </svg>
);

export function TouchControls() {
  const touch = useIsTouch();
  const mode = useTouchMode((s) => s.mode);
  const sketch = useAssembly((s) => s.modeling.sketch !== null);
  if (!touch) return null;

  const toggle = (m: TouchMode) => () => setTouchMode(mode === m ? 'camera' : m);
  // Açık menü dışarıya basınca (pointerdown) kapanır; tıklama yeniden açar (menü ekrana sığacak şekilde kayar)
  const openView = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    openViewMenu(r.right, r.top);
  };

  return (
    <div className="touch-bar" role="toolbar" aria-label="Dokunmatik kontroller" onContextMenu={(e) => e.preventDefault()}>
      {!sketch && (
        <>
          <button
            type="button"
            className={`touch-btn${mode === 'move' ? ' on' : ''}`}
            aria-pressed={mode === 'move'}
            title="Taşı: parçaya dokunup sürükle"
            onClick={toggle('move')}
          >
            <IconMove />
            <span>Taşı</span>
          </button>
          <button
            type="button"
            className={`touch-btn${mode === 'rotate' ? ' on' : ''}`}
            aria-pressed={mode === 'rotate'}
            title="Döndür: parçaya dokunup sürükle"
            onClick={toggle('rotate')}
          >
            <IconRotate />
            <span>Döndür</span>
          </button>
          <span className="touch-sep" />
        </>
      )}
      <button
        type="button"
        className="touch-btn"
        title="Tümüne sığdır"
        onClick={() => {
          closeViewMenu();
          fitAll();
        }}
      >
        <IconFit />
        <span>Sığdır</span>
      </button>
      <button type="button" className="touch-btn" title="Görünüm menüsü" onClick={openView}>
        <IconView />
        <span>Görünüm</span>
      </button>
    </div>
  );
}
