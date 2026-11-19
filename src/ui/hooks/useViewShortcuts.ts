// Görünüm kısayolları (SolidWorks 2022): Ctrl+1…7 standart görünümler, Ctrl+8 Normal'e bak,
// Space imleç yanında görünüm menüsü, sketch içinde F = sığdır (montajda F, useShortcuts'tadır).
// Metin alanına yazarken devre dışıdır.
import { useEffect } from 'react';
import { closeViewMenu, openViewMenu, viewMenuOpen } from '@/ui/viewport/ViewMenu';
import { fitAll, normalTo, setStandardView, type StandardView } from '@/ui/viewport/viewCommands';
import { useAssembly } from '@/state/useAssembly';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'range', 'file']);

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  return false;
}

const DIGIT_VIEWS: Record<number, StandardView> = {
  1: 'front',
  2: 'back',
  3: 'left',
  4: 'right',
  5: 'top',
  6: 'bottom',
  7: 'iso',
};

/** Digit1…Digit9 / Numpad1…9 → rakam (yoksa 0) */
function digitOf(e: KeyboardEvent): number {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (m) return Number(m[1]);
  return /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
}

export function useViewShortcuts() {
  useEffect(() => {
    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl+1…8: tarayıcının sekme kısayolları yerine görünümler (metin alanında da yakalanır,
      // çünkü orada rakamla birlikte Ctrl'nin anlamı yoktur)
      if (mod && !e.altKey && !e.shiftKey) {
        const d = digitOf(e);
        if (d >= 1 && d <= 8) {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          closeViewMenu();
          if (d === 8) normalTo();
          else setStandardView(DIGIT_VIEWS[d]);
        }
        return;
      }

      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      if (e.altKey || mod) return;

      if (e.code === 'Space' || e.key === ' ') {
        // Menü içindeki onay kutusunda Space kendi işini yapsın
        if (e.target instanceof Element && e.target.closest('.view-menu')) return;
        e.preventDefault();
        if (e.repeat) return;
        if (viewMenuOpen()) closeViewMenu();
        else openViewMenu(pointer.x, pointer.y);
        return;
      }

      // Sketch'te F: sığdır (montajda useShortcuts seçime/tümüne sığdırır)
      if (e.key.toLowerCase() === 'f' && !e.shiftKey && useAssembly.getState().modeling.sketch) {
        e.preventDefault();
        fitAll();
      }
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    // Dokunmatikte hover yok: Space menüsü (harici klavyeyle) son dokunulan yerde açılsın
    window.addEventListener('pointerdown', onMove, { passive: true });
    // Yakalama aşaması: tarayıcı kısayollarından ve diğer dinleyicilerden önce
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
}
