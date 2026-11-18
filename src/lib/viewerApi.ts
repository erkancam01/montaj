// Canvas dışındaki arayüzün 3D sahneye komut vermesi için köprü.
// Gerçek fonksiyonları Viewport içindeki <CameraRig/> atar (o zamana kadar boş çalışır).
import type { Selection } from '../types';

export interface ViewerApi {
  /** Kamerayı tüm montaja ya da seçime sığdırır */
  fit(target: 'all' | 'selection'): void;
  /** Seçili öğenin dünya bounding box tabanını Z=0'a indirir (geçmişe kaydeder) */
  dropToFloor(sel: Selection): void;
  /** Görünür montajı GLB olarak döndürür (metre, Y-yukarı) */
  exportGLB(): Promise<Blob | null>;
  /** Görünümün PNG ekran görüntüsü */
  screenshot(): Promise<Blob | null>;
}

export const viewerApi: ViewerApi = {
  fit: () => {},
  dropToFloor: () => {},
  exportGLB: async () => null,
  screenshot: async () => null,
};

/** React render'ı bittikten sonra çalıştırır (yeni eklenen nesneler sahnede olsun diye) */
export function afterRender(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}
