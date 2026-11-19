// Modelleme arayüzünün kendi (belgeye yazılmayan) geçici durumu: özellik paneli ile sahne katmanı
// (PickLayer) arasında paylaşılır. Özellik oturumu değişince sıfırlanır.
import { create } from 'zustand';
import type { EdgeSig } from '@/core/types';

export interface ModelingUiState {
  /** Delik taslağında yüzeye tıklayarak merkez ekleme modu */
  holePlace: boolean;
  /** Delik taslağında yüzey seçildi mi (yeni delikte Uygula için gerekli) */
  holeFaceChosen: boolean;
  /** Extrude/Revolve profil modu: tüm kapalı bölgeler ya da sahneden seçilenler */
  profileMode: 'all' | 'pick';
  /**
   * Radyus/pah kenar seçimi sırasında taslak önizlemesi gizlenir (özgün kenarlar seçilebilsin);
   * seçim bitince taslağın bastırma değeri buna geri döner. null = seçim yok.
   */
  edgeRestore: boolean | null;
  /** Kenar seçimi başladığındaki kenar listesi (İptal geri yükler) */
  edgeSnapshot: EdgeSig[] | null;
  set(p: Partial<Omit<ModelingUiState, 'set' | 'reset'>>): void;
  reset(): void;
}

const initial = { holePlace: false, holeFaceChosen: false, profileMode: 'all' as const, edgeRestore: null, edgeSnapshot: null };

export const useModelingUi = create<ModelingUiState>()((set) => ({
  ...initial,
  set: (p) => set(p),
  reset: () => set(initial),
}));
