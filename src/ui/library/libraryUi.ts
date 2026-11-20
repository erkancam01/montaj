// Kütüphane panelinin arayüz durumu: açık mı, hangi klasörde. Açık/kapalı tercihi tarayıcıda hatırlanır.
import { create } from 'zustand';

const KEY = 'montaj.libraryOpen';

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

interface LibraryUiState {
  open: boolean;
  /** Gezilen klasör; kökte null */
  folderId: string | null;
  setOpen(open: boolean): void;
  setFolder(id: string | null): void;
}

export const useLibraryUi = create<LibraryUiState>((set) => ({
  open: readOpen(),
  folderId: null,
  setOpen: (open) => {
    try {
      localStorage.setItem(KEY, open ? '1' : '0');
    } catch {
      /* yok say */
    }
    set({ open });
  },
  setFolder: (folderId) => set({ folderId }),
}));

export function toggleLibrary() {
  const s = useLibraryUi.getState();
  s.setOpen(!s.open);
}

/** Kütüphane öğesi sürüklenirken dataTransfer türleri */
export const DND_ITEM = 'application/x-montaj-lib-item';
export const DND_FOLDER = 'application/x-montaj-lib-folder';

export function dragHas(e: { dataTransfer: DataTransfer | null }, type: string): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(type);
}

/** Olay hedefi kendi bırakma işini yapan bir alanda mı (kütüphane paneli): genel bırakma katmanı karışmasın */
export function inOwnDropZone(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-own-drop]');
}
