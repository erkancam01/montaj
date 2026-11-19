// Pencereye dosya sürüklenmesini izler; bırakılan dosyaları onFiles'a iletir.
import { useEffect, useRef, useState } from 'react';

function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

/** Sürükleme pencerenin üzerindeyken true döner */
export function useDropZone(onFiles: (files: File[]) => void): boolean {
  const [active, setActive] = useState(false);
  const cb = useRef(onFiles);

  useEffect(() => {
    cb.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    let depth = 0;
    const reset = () => {
      depth = 0;
      setActive(false);
    };
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      reset();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) cb.current(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('blur', reset);
    };
  }, []);

  return active;
}
