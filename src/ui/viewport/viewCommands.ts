// Görünüm komutları (SolidWorks: Ctrl+1…8, Space menüsü). Kontrolcüyü <CameraRig/> kaydeder;
// o zamana kadar komutlar sessizce hiçbir şey yapmaz.
import { Box3, MathUtils, Matrix4, Quaternion, Sphere, Vector3, type PerspectiveCamera } from 'three';
import type { CadControls } from '@/ui/viewport/CadControls';
import { sceneRefs } from '@/ui/viewport/sceneRefs';
import { view } from '@/ui/sketch/view';
import { useAssembly } from '@/state/useAssembly';
import type { FaceRef, Vec3 } from '@/core/types';
import { worldFaceGeom } from '@/core/geometry/faceGeometry';
import { objectRegistry } from '@/ui/viewport/registry';
import { viewerApi } from '@/services/viewerApi';

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

/** Dünya koordinatlı düzlem: nokta + normal (+ isteğe bağlı ekran-yukarı ipucu) */
export interface ViewPlane {
  origin: Vec3 | Vector3;
  normal: Vec3 | Vector3;
  /** Düzlem içinde ekranın sağına gelecek yön (ör. sketch x'i) */
  xDir?: Vec3 | Vector3;
}

/** Sketch görünüm düzlemi biçimi ({o, x, y, n}) */
interface WorldPlaneLike {
  o: Vector3;
  x: Vector3;
  y: Vector3;
  n: Vector3;
}

export const VIEW_DURATION = 300;

export const STANDARD_VIEWS: Record<StandardView, { label: string; key: string; dir: Vec3; up: Vec3 }> = {
  // Sahne Z-yukarı: Ön = −Y'den bakış, Üst = +Z'den (ekran-yukarı +Y)
  front: { label: 'Ön', key: 'Ctrl+1', dir: [0, -1, 0], up: [0, 0, 1] },
  back: { label: 'Arka', key: 'Ctrl+2', dir: [0, 1, 0], up: [0, 0, 1] },
  left: { label: 'Sol', key: 'Ctrl+3', dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { label: 'Sağ', key: 'Ctrl+4', dir: [1, 0, 0], up: [0, 0, 1] },
  top: { label: 'Üst', key: 'Ctrl+5', dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { label: 'Alt', key: 'Ctrl+6', dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { label: 'İzometrik', key: 'Ctrl+7', dir: [1, -1, 1], up: [0, 0, 1] },
};

let controls: CadControls | null = null;

/** <CameraRig/> tarafından çağrılır */
export function registerViewControls(c: CadControls | null) {
  controls = c;
}

export function viewControls(): CadControls | null {
  return controls;
}

const vec = (v: Vec3 | Vector3): Vector3 => (v instanceof Vector3 ? v.clone() : new Vector3(v[0], v[1], v[2]));

/** "Kameranın arkası" yönü (hedeften kameraya) ve ekran-yukarısından yönelim */
export function orientation(back: Vector3, up: Vector3): Quaternion {
  const m = new Matrix4().lookAt(back, new Vector3(), up);
  return new Quaternion().setFromRotationMatrix(m);
}

/** Görünür montajın sınır küresi (boşsa null) */
export function sceneSphere(): Sphere | null {
  const root = sceneRefs.root;
  if (!root) return null;
  root.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(root);
  if (box.isEmpty()) return null;
  return box.getBoundingSphere(new Sphere());
}

/** Küreyi görüş alanına sığdıran kamera uzaklığı */
export function fitDistance(cam: PerspectiveCamera, radius: number): number {
  const vfov = MathUtils.degToRad(cam.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (cam.aspect || 1));
  return (Math.max(radius, 1e-3) / Math.sin(Math.min(vfov, hfov) / 2)) * 1.1;
}

/** Standart görünüm (yumuşak geçiş, montaja sığdırarak) */
export function setStandardView(name: StandardView) {
  const c = controls;
  const def = STANDARD_VIEWS[name];
  if (!c || !def) return;
  const q = orientation(vec(def.dir).normalize(), vec(def.up));
  const s = sceneSphere();
  const target = s ? s.center.clone() : c.target.clone();
  const distance = s ? fitDistance(c.camera, s.radius) : c.camera.position.distanceTo(c.target);
  c.animateTo({ target, quaternion: q, distance }, VIEW_DURATION);
}

/**
 * Verilen yönden bakış (görünüm küpü: yüz, kenar ya da köşe). dir = hedeften kameraya (dünya, Z-yukarı).
 * Ekran-yukarısı +Z; tam üstten/alttan bakışta Üst/Alt standart görünümlerindeki gibi ±Y.
 */
export function viewFromDirection(dir: Vector3) {
  const c = controls;
  if (!c) return;
  const d = dir.clone().normalize();
  if (!(d.lengthSq() > 0.5)) return;
  let up = new Vector3(0, 0, 1);
  if (Math.abs(d.z) > 0.999) up = new Vector3(0, d.z > 0 ? 1 : -1, 0);
  const s = sceneSphere();
  const target = s ? s.center.clone() : c.target.clone();
  const distance = s ? fitDistance(c.camera, s.radius) : c.camera.position.distanceTo(c.target);
  c.animateTo({ target, quaternion: orientation(d, up), distance }, VIEW_DURATION);
}

/** Tümüne sığdır (F) */
export function fitAll() {
  viewerApi.fit('all');
}

function isFaceRef(x: unknown): x is FaceRef {
  return !!x && typeof x === 'object' && 'partId' in x && 'faceIndex' in x;
}

function isWorldPlane(x: unknown): x is WorldPlaneLike {
  return !!x && typeof x === 'object' && 'n' in x && 'o' in x && (x as WorldPlaneLike).n instanceof Vector3;
}

/**
 * Düzleme dik bakış. Kamera düzlemin normal tarafına geçer; zaten o yönden bakılıyorsa (ikinci basış)
 * arka tarafa döner. up verilmezse mevcut ekran-yukarısına en yakın yön korunur.
 */
export function lookAtPlane(
  origin: Vector3,
  normal: Vector3,
  opts: { up?: Vector3; target?: Vector3; distance?: number; duration?: number; flip?: boolean } = {},
): boolean {
  const c = controls;
  if (!c) return false;
  const n = normal.clone().normalize();
  if (!(n.lengthSq() > 0.5)) return false;
  const cam = c.camera;
  const curBack = cam.position.clone().sub(c.target).normalize();
  if (opts.flip !== false && curBack.dot(n) > 0.9999) n.negate();

  let up = opts.up?.clone() ?? cam.up.clone();
  up.addScaledVector(n, -up.dot(n));
  if (up.lengthSq() < 1e-8) {
    up = new Vector3(0, 0, 1).addScaledVector(n, -n.z);
    if (up.lengthSq() < 1e-8) up = new Vector3(0, 1, 0).addScaledVector(n, -n.y);
  }
  up.normalize();

  // Hedef: verilmediyse mevcut hedefin düzleme izdüşümü
  const target = opts.target?.clone() ?? c.target.clone().addScaledVector(n, -c.target.clone().sub(origin).dot(n));
  const distance = opts.distance ?? cam.position.distanceTo(c.target);
  c.animateTo({ target, quaternion: orientation(n, up), distance }, opts.duration ?? VIEW_DURATION);
  return true;
}

/**
 * Normal'e bak (Ctrl+8). Argüman: düz yüz (FaceRef), dünya düzlemi ya da sketch düzlemi.
 * Verilmezse sırayla açık sketch düzlemi ve mate için seçilmiş (bekleyen) yüz denenir.
 * Başarılıysa true.
 */
export function normalTo(faceRefOrPlane?: FaceRef | ViewPlane | WorldPlaneLike | null): boolean {
  let arg: FaceRef | ViewPlane | WorldPlaneLike | null | undefined = faceRefOrPlane;
  if (arg == null) arg = view.plane ?? useAssembly.getState().pendingFace;
  if (!arg) {
    useAssembly.getState().showToast("Normal'e bak için düz bir yüz seçin ya da bir sketch açın");
    return false;
  }

  if (isWorldPlane(arg)) {
    // Sketch: x sağa, y yukarı
    return lookAtPlane(arg.o, arg.n, { up: arg.y });
  }

  if (isFaceRef(arg)) {
    const g = worldFaceGeom(arg, useAssembly.getState().doc);
    if (!g || g.kind !== 'plane') {
      useAssembly.getState().showToast("Normal'e bak yalnız düz yüzlerde çalışır");
      return false;
    }
    const origin = vec(g.point);
    const n = vec(g.normal).normalize();
    // Hedef: parçanın merkezinin yüz düzlemine izdüşümü
    let target: Vector3 | undefined;
    const obj = objectRegistry.get(arg.partId);
    if (obj) {
      obj.updateWorldMatrix(true, true);
      const box = new Box3().setFromObject(obj);
      if (!box.isEmpty()) {
        const ctr = box.getCenter(new Vector3());
        target = ctr.addScaledVector(n, -ctr.clone().sub(origin).dot(n));
      }
    }
    return lookAtPlane(origin, n, { target });
  }

  const p = arg as ViewPlane;
  const n = vec(p.normal).normalize();
  const up = p.xDir ? n.clone().cross(vec(p.xDir)).normalize() : undefined;
  return lookAtPlane(vec(p.origin), n, { up });
}
