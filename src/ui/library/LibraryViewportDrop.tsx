// Kütüphaneden sahneye sürükle-bırak: bırakılan parça montaja (dosyanın kendi koordinatlarında) eklenir.
// Sahne kutusunun (.viewport-box) sürükleme olaylarını dinler; kütüphane paneli kendi bırakmalarını durdurur.
import { useEffect, useRef, useState } from 'react';
import { DND_ITEM, dragHas, inOwnDropZone } from '@/ui/library/libraryUi';
import { insertItem } from '@/ui/library/LibraryPanel';

export function LibraryViewportDrop() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const box = anchor.current?.parentElement;
    if (!box) return;
    let depth = 0;
    // Kütüphane panelinin üzerindeyken sahne hedefi değildir
    const mine = (e: DragEvent) => dragHas(e, DND_ITEM) && !inOwnDropZone(e.target);
    const onEnter = (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!mine(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const reset = () => {
      depth = 0;
      setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      reset();
      if (!mine(e)) return;
      const id = e.dataTransfer?.getData(DND_ITEM);
      if (!id) return;
      e.preventDefault();
      insertItem(id);
    };
    box.addEventListener('dragenter', onEnter);
    box.addEventListener('dragover', onOver);
    box.addEventListener('dragleave', onLeave);
    box.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    return () => {
      box.removeEventListener('dragenter', onEnter);
      box.removeEventListener('dragover', onOver);
      box.removeEventListener('dragleave', onLeave);
      box.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  return (
    <>
      <span ref={anchor} hidden />
      {over && (
        <div className="lib-scene-drop" aria-hidden="true">
          <div className="lib-scene-drop-card">Montaja eklemek için bırakın</div>
        </div>
      )}
    </>
  );
}
