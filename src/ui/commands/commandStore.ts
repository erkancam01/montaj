// Komut arayüzünün (sekmeli komut çubuğu, bağlam kutusu, sağ tık ve S menüsü, Extrude önerisi) geçici durumu.
// Belgeye yazılmaz.
import { create } from 'zustand';
import type { FaceRef } from '@/core/types';

export type BasePlaneKey = 'XY' | 'XZ' | 'YZ';

export type CommandTab = 'features' | 'sketch' | 'assembly' | 'evaluate';

/** Sahnede imlecin altındaki hedef (bağlam kutusu / sağ tık menüsü için) */
export interface SceneHit {
  partId: string;
  /** Düz/silindirik vb. B-rep yüzeyi; tanınmazsa null */
  face: FaceRef | null;
  /** Yüzey düzlemsel mi (sketch açılabilir mi) */
  planar: boolean;
}

export interface Popup {
  x: number;
  y: number;
  hit: SceneHit | null;
}

export interface LastCommand {
  id: string;
  label: string;
  run(): void;
}

export interface ExtrudeSuggestion {
  bodyId: string;
  sketchId: string;
  sketchName: string;
  /** Gövdede katı var mı (Kesme de önerilir) */
  hasSolid: boolean;
}

interface CommandUiState {
  tab: CommandTab;
  /** Sol tıkla açılan küçük bağlam araç kutusu */
  contextBox: Popup | null;
  /** Sağ tık menüsü (sahne); hit null → boş alan */
  contextMenu: Popup | null;
  /** S kısayol menüsü */
  sMenu: { x: number; y: number } | null;
  /** Son komut (Enter tekrarlar) */
  last: LastCommand | null;
  suggestion: ExtrudeSuggestion | null;
  /** Ağaçta / sahnede seçili temel düzlem (Sketch bu düzlemde açılır) */
  plane: BasePlaneKey | null;
  /** Son tıklanan düz yüzey (Sketch bu yüzeyde açılır) */
  face: FaceRef | null;
  /** Ağaçta seçili sketch (Ekstrüzyon vb. bu sketch'i kullanır) */
  sketchSel: { bodyId: string; featureId: string } | null;
  /** Sketch düzlemi bekleniyor: üç temel düzlem sahnede tıklanabilir gösterilir */
  planePick: boolean;
  /** Temel düzlemler sürekli görünsün (Görünüm menüsü) */
  showPlanes: boolean;
  /** Az önce kurulan mate'in imleç yanındaki araç kutusu */
  matePopup: { mateId: string; x: number; y: number } | null;
  set(p: Partial<Omit<CommandUiState, 'set' | 'closePopups'>>): void;
  closePopups(): void;
}

export const useCommandUi = create<CommandUiState>()((set) => ({
  tab: 'assembly',
  contextBox: null,
  contextMenu: null,
  sMenu: null,
  last: null,
  suggestion: null,
  plane: null,
  face: null,
  sketchSel: null,
  planePick: false,
  showPlanes: false,
  matePopup: null,
  set: (p) => set(p),
  closePopups: () => set({ contextBox: null, contextMenu: null, sMenu: null }),
}));

/** Viewport üzerindeki son imleç konumu (S menüsü imleç yanında açılır); viewport dışındaysa null */
export const pointerState: { x: number; y: number; inside: boolean } = { x: 0, y: 0, inside: false };
