// Komut kısayolları: S (imleç yanında kısayol menüsü), Enter (son komutu tekrarla / açık komutu onayla),
// Esc (açık özellik ya da mate komutunu iptal et). Metin alanına yazarken devre dışıdır.
import { useEffect } from 'react';
import { cancelFeature } from '@/state/modelingActions';
import { useAssembly } from '@/state/useAssembly';
import { tryApplyFeature } from '@/ui/modeling/FeatureInspector';
import { acceptMateSession, repeatLast, startCommandWatchers } from '@/ui/commands/commands';
import { pointerState, useCommandUi } from '@/ui/commands/commandStore';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'range', 'file']);

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  return false;
}

/** Klavye odağı bir düğmedeyse Enter düğmeye aittir */
function isButtonFocus(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLButtonElement || (a instanceof HTMLElement && a.getAttribute('role') === 'menuitem');
}

function viewportCenter(): { x: number; y: number } {
  const el = document.querySelector('.viewport-box');
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

export function useCommandKeys() {
  useEffect(() => {
    startCommandWatchers();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
      const st = useAssembly.getState();
      const ui = useCommandUi.getState();
      const key = e.key.toLowerCase();

      if (key === 's' && !e.shiftKey && !e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (ui.sMenu) {
          ui.set({ sMenu: null });
          return;
        }
        const p = pointerState.inside ? { x: pointerState.x, y: pointerState.y } : viewportCenter();
        ui.set({ sMenu: p, contextBox: null, contextMenu: null });
        return;
      }

      if (key === 'enter') {
        // Sketch'te Enter sketch katmanına aittir (çizimi bitir / sketch'ten çık)
        if (st.modeling.sketch || isButtonFocus() || e.repeat) return;
        // Özellik listesinde Enter seçili özelliği düzenler
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.ft-list')) return;
        if (st.modeling.pick) return;
        if (st.modeling.feature) {
          e.preventDefault();
          void tryApplyFeature();
          return;
        }
        if (st.ui.tool === 'mate' && !st.pendingFace) {
          e.preventDefault();
          acceptMateSession();
          return;
        }
        if (repeatLast()) e.preventDefault();
        return;
      }

      if (key === 'escape') {
        if (ui.contextBox || ui.suggestion) {
          ui.set({ contextBox: null, suggestion: null });
        }
        if (st.modeling.sketch || st.modeling.pick) return;
        if (st.modeling.feature) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancelFeature();
        }
      }
    };
    // Yakalama aşaması: sketch ve genel kısayollardan önce S'yi alır
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
