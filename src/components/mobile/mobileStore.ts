// Dar ekran (< 900 px) düzeninin geçici durumu: açık çekmece ve komut sayfasının (bottom sheet) daraltılması.
// Masaüstünde bu durum CSS tarafından yok sayılır.
import { create } from 'zustand';

export type MobileDrawer = 'tree' | 'props' | null;

interface MobileUiState {
  drawer: MobileDrawer;
  /** Komut sayfası yalnız başlık satırına daraltıldı (sahne tam görünsün) */
  sheetMin: boolean;
  set(p: Partial<Omit<MobileUiState, 'set'>>): void;
}

export const useMobileUi = create<MobileUiState>((set) => ({
  drawer: null,
  sheetMin: false,
  set: (p) => set(p),
}));

