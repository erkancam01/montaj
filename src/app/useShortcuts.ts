// Genel klavye kısayolları. Metin alanına yazarken devre dışıdır.
import { useEffect } from 'react';
import { viewerApi } from '@/services/viewerApi';
import { selectedGroupId } from '@/ui/assembly/GroupList';
import { duplicate, groupSelection, removeMate, removeSelection, toggleVisible, ungroup } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'range', 'file']);

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  return false;
}

export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Sketch oturumunda klavye sketch arayüzüne aittir
      if (useAssembly.getState().modeling.sketch) return;
      if (e.defaultPrevented || e.isComposing) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;

      const st = useAssembly.getState();
      const sel = st.selection;
      const mateSel = st.mateSelection;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;

      if (mod) {
        if (e.altKey) return;
        // Ctrl basılıyken bazı düzenlerde e.key değişebildiği için fiziksel tuş da kontrol edilir
        const is = (letter: string) => key === letter || e.code === `Key${letter.toUpperCase()}`;
        if (is('z')) {
          e.preventDefault();
          if (e.shiftKey) st.redo();
          else st.undo();
        } else if (is('y')) {
          e.preventDefault();
          st.redo();
        } else if (is('d')) {
          e.preventDefault();
          // Mate çoğaltılmaz; grup üyeleriyle çoğaltılır (çoklu seçimde birincil öğe)
          if (!mateSel) duplicate(sel);
        } else if (is('g')) {
          e.preventDefault();
          if (e.shiftKey) {
            // Ctrl+Shift+G: seçili grubu çöz
            const gid = selectedGroupId(st);
            if (gid) ungroup(gid);
          } else if (!mateSel) {
            // Ctrl+G: seçili parçaları grupla (en az iki parça yoksa uyarı gösterir)
            groupSelection();
          }
        }
        return;
      }
      if (e.altKey) return;

      switch (key) {
        case 'w':
          st.setUi({ mode: 'translate' });
          break;
        case 'e':
          st.setUi({ mode: 'rotate' });
          break;
        case 'q':
          st.setUi({ space: st.ui.space === 'world' ? 'local' : 'world' });
          break;
        case 'm':
          st.setUi({ tool: st.ui.tool === 'mate' ? 'select' : 'mate' });
          break;
        case 'f':
          // Mate seçiliyken parça seçili değildir; viewerApi yalnız seçimi bildiği için tümüne sığdır
          viewerApi.fit(sel && !mateSel ? 'selection' : 'all');
          break;
        case 'g':
          if (sel) viewerApi.dropToFloor(sel);
          break;
        case 'h':
          // Grup: tüm üyeler; çoklu seçimde birincil öğeye uygulanır
          toggleVisible(sel);
          break;
        case 'delete':
        case 'backspace':
          if (mateSel) {
            e.preventDefault();
            removeMate(mateSel);
            break;
          }
          if (!sel) return;
          e.preventDefault();
          // Birincil + ek seçimlerin tamamı (grup: üye parçalar)
          removeSelection();
          break;
        case 'escape':
          // Önce yarım kalan yüzey seçimi, sonra mate aracı, en son seçimler
          if (st.pendingFace) st.setPendingFace(null);
          else if (st.ui.tool === 'mate') st.setUi({ tool: 'select' });
          else {
            if (mateSel) st.selectMate(null);
            // Ek seçimleri de temizler
            if (sel || st.extraSel.length) st.select(null);
          }
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
