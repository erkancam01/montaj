// Viewport bileşenleri arasında paylaşılan, React dışı sahne referansları.
import type { Group, Object3D } from 'three';

export const sceneRefs: {
  /** Tüm instance'ları içeren kök grup (sığdırma, GLB çıktısı) */
  root: Group | null;
  /** TransformControls nesnesi (ekran görüntüsünde gizlemek için) */
  gizmo: Object3D | null;
  /** Son ölçülen sahne bounding sphere yarıçapı (mm) */
  radius: number;
} = { root: null, gizmo: null, radius: 500 };

// Gizmo bayrakları durum katmanındadır (servisler de okur); arayüz buradan da erişebilsin diye yeniden dışa açılır
export { gizmoBusy, markGizmoDown, markGizmoUp } from '@/state/interaction';

/** Raycast'ten muaf tutulacak nesneler için */
export function noRaycast() {}

/** Görünüm küpünün sağ alt köşeden merkez uzaklığı (px); ViewCube yazar */
let viewCubeMargin = 0;
export function setViewCubeMargin(m: number) {
  viewCubeMargin = m;
}

/**
 * İmleç görünüm küpü alanında mı: oradaki tıklamalar küpe aittir, sahne seçimi / sürükleme / sketch
 * araçları yok saymalıdır.
 */
export function inViewCube(clientX: number, clientY: number): boolean {
  if (!viewCubeMargin) return false;
  const cv = document.querySelector('.viewport-box canvas') ?? document.querySelector('canvas');
  if (!cv) return false;
  const r = cv.getBoundingClientRect();
  const half = viewCubeMargin * 0.95;
  return Math.abs(clientX - (r.right - viewCubeMargin)) < half && Math.abs(clientY - (r.bottom - viewCubeMargin)) < half;
}
