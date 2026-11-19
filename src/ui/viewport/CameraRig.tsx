import { useEffect, useRef } from 'react';
import { useFrame, useThree, type RootState } from '@react-three/fiber';
import {
  Box3,
  Group,
  Sphere,
  Vector3,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { objectRegistry } from '@/ui/viewport/registry';
import { viewerApi } from '@/services/viewerApi';
import { selectedPartIds } from '@/core/assembly/rigid';
import { moveRigid, setTransform } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import type { Quat, Selection } from '@/core/types';
import { sceneRefs } from '@/ui/viewport/sceneRefs';
import { CadControls } from '@/ui/viewport/CadControls';
import { fitDistance, registerViewControls, VIEW_DURATION } from '@/ui/viewport/viewCommands';

/** OrbitControls'tan kullandığımız alanlar */
interface OrbitLike {
  target: Vector3;
  update(): void;
}

const FALLBACK_DIR = new Vector3(1, -1.2, 0.9);
const RADIUS_INTERVAL = 30;

function orbitOf(state: RootState): OrbitLike | null {
  const c = state.controls as unknown as Partial<OrbitLike> | null;
  return c && c.target instanceof Vector3 && typeof c.update === 'function' ? (c as OrbitLike) : null;
}

/** Kamera-hedef uzaklığına göre near/far (logarithmicDepthBuffer yerine) */
function updateClip(cam: PerspectiveCamera, target: Vector3 | null, force = false) {
  const d = Math.max(target ? cam.position.distanceTo(target) : cam.position.length(), 1e-3);
  const r = sceneRefs.radius;
  const near = Math.max(d / 500, 1e-4);
  const far = Math.max(d * 50, r * 10, d + r * 2);
  if (force || Math.abs(cam.near - near) > near * 0.01 || Math.abs(cam.far - far) > far * 0.01) {
    cam.near = near;
    cam.far = far;
    cam.updateProjectionMatrix();
  }
}

/** Yarıçapa göre "güzel" ızgara hücresi: 10'un kuvveti, en az 0.1 mm */
function niceCell(r: number): number {
  const v = Math.pow(10, Math.floor(Math.log10(Math.max(r, 1e-6) / 5)));
  return Math.max(0.1, v);
}

/**
 * Grup ya da çoklu seçimde birlikte ele alınacak parça id'leri; tek parça / instance seçiminde null.
 * Ek seçimler yalnızca sel store'daki birincil seçimse hesaba katılır.
 */
function rigidPartIds(sel: Selection): string[] | null {
  if (!sel) return null;
  const st = useAssembly.getState();
  const cur = st.selection;
  const extra = cur && cur.kind === sel.kind && cur.id === sel.id ? st.extraSel : [];
  if (sel.kind !== 'group' && !extra.length) return null;
  return selectedPartIds(st.doc, sel, extra);
}

/** Nesnelerin birleşik dünya kutusu (precise: dönmüş geometride sıkı kutu) */
function unionBox(objs: Object3D[], precise = false): Box3 {
  const box = new Box3();
  for (const o of objs) {
    o.updateWorldMatrix(true, true);
    box.expandByObject(o, precise);
  }
  return box;
}

const registeredObjects = (ids: string[]): Object3D[] =>
  ids.map((id) => objectRegistry.get(id)).filter((o): o is Object3D => !!o);

function fit(state: RootState, target: 'all' | 'selection') {
  let objs: Object3D[] = sceneRefs.root ? [sceneRefs.root] : [];
  if (target === 'selection') {
    const sel = useAssembly.getState().selection;
    if (sel) {
      const ids = rigidPartIds(sel);
      objs = registeredObjects(ids ?? [sel.id]);
    }
  }
  if (!objs.length) return;
  const box = unionBox(objs);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new Sphere());
  const r = Math.max(sphere.radius, 1e-3);

  const cam = state.camera as PerspectiveCamera;
  const controls = orbitOf(state);
  const dist = fitDistance(cam, r);

  const dir = cam.position.clone().sub(controls ? controls.target : new Vector3());
  if (!(dir.lengthSq() > 1e-12) || !Number.isFinite(dir.x + dir.y + dir.z)) dir.copy(FALLBACK_DIR);
  dir.normalize();

  if (target === 'all') sceneRefs.radius = r;
  if (controls instanceof CadControls) {
    // Yönelim korunur, yumuşak geçişle sığdırılır
    controls.animateTo({ target: sphere.center.clone(), quaternion: cam.quaternion.clone(), distance: dist }, VIEW_DURATION);
  } else {
    cam.position.copy(sphere.center).addScaledVector(dir, dist);
    if (controls) {
      controls.target.copy(sphere.center);
      controls.update();
    } else {
      cam.lookAt(sphere.center);
    }
    updateClip(cam, sphere.center, true);
  }

  if (target === 'all') useAssembly.setState({ gridCell: niceCell(r) });
}

function dropToFloor(sel: Selection) {
  if (!sel) return;
  // Grup / çoklu seçim: kümenin birleşik kutusu Z=0'a iner, tüm parçalar rijit taşınır
  const ids = rigidPartIds(sel);
  if (ids) {
    const box = unionBox(registeredObjects(ids), true);
    if (box.isEmpty()) return;
    const dz = -box.min.z;
    if (Math.abs(dz) < 1e-9) return;
    moveRigid(ids, { position: [0, 0, dz], quaternion: [0, 0, 0, 1] });
    return;
  }
  if (sel.kind === 'group') return;
  const obj = objectRegistry.get(sel.id);
  if (!obj) return;
  obj.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(obj, true);
  if (box.isEmpty()) return;
  const dz = -box.min.z;
  if (Math.abs(dz) < 1e-9) return;

  const world = obj.getWorldPosition(new Vector3());
  world.z += dz;
  const local = obj.parent ? obj.parent.worldToLocal(world) : world;

  const doc = useAssembly.getState().doc;
  const item = sel.kind === 'instance' ? doc.instances.find((i) => i.id === sel.id) : doc.parts.find((p) => p.id === sel.id);
  const q = obj.quaternion;
  const quat: Quat = item ? [...item.quaternion] : [q.x, q.y, q.z, q.w];
  setTransform(sel.kind, sel.id, [local.x, local.y, local.z], quat);
}

async function exportGLB(): Promise<Blob | null> {
  const root = sceneRefs.root;
  if (!root) return null;
  root.updateWorldMatrix(true, true);
  const clone = root.clone(true);

  const lines: Object3D[] = [];
  const cloned: Material[] = [];
  const cloneMat = (m: Material): Material => {
    const c = m.clone();
    const std = c as MeshStandardMaterial;
    if (std.isMeshStandardMaterial) {
      std.emissive.setRGB(0, 0, 0);
      std.emissiveIntensity = 0;
    }
    cloned.push(c);
    return c;
  };
  clone.traverse((o) => {
    // Uygulama içi kimlikler (partId vb.) glTF extras'a yazılmasın
    o.userData = o.userData.noExport ? o.userData : {};
    // Kenar çizgileri ve yüzey vurgu örtüleri dışa aktarılmaz
    if ((o as { isLineSegments?: boolean }).isLineSegments || o.userData.noExport) {
      lines.push(o);
    } else if ((o as Mesh).isMesh) {
      const mesh = o as Mesh;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMat) : cloneMat(mesh.material);
    }
  });
  lines.forEach((l) => l.removeFromParent());

  // Z-yukarı mm → Y-yukarı metre
  const wrap = new Group();
  wrap.name = 'Sahne';
  wrap.rotation.x = -Math.PI / 2;
  wrap.scale.setScalar(0.001);
  wrap.add(clone);
  wrap.updateMatrixWorld(true);

  try {
    const result = await new GLTFExporter().parseAsync(wrap, { binary: true, onlyVisible: true });
    if (!(result instanceof ArrayBuffer)) return null;
    return new Blob([result], { type: 'model/gltf-binary' });
  } finally {
    cloned.forEach((m) => m.dispose());
  }
}

function screenshot(state: RootState): Promise<Blob | null> {
  return new Promise((resolve) => {
    const { gl, scene, camera } = state;
    const gizmo = sceneRefs.gizmo;
    const gizmoVisible = gizmo?.visible ?? false;
    const autoClear = gl.autoClear;
    try {
      // Gizmo ve eksen göstergesi olmadan temiz bir kare çiz
      if (gizmo) gizmo.visible = false;
      gl.autoClear = true;
      gl.render(scene, camera);
      gl.domElement.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    } finally {
      gl.autoClear = autoClear;
      if (gizmo) gizmo.visible = gizmoVisible;
    }
  });
}

/**
 * SolidWorks tarzı kamera kontrolcüsünü (CadControls) varsayılan kontrol olarak kurar; viewerApi'yi
 * doldurur, near/far'ı ve sahne yarıçapını günceller
 */
export function CameraRig() {
  const get = useThree((s) => s.get);
  const set = useThree((s) => s.set);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const frame = useRef(0);
  const box = useRef(new Box3());
  const sphere = useRef(new Sphere());

  useEffect(() => {
    viewerApi.fit = (t) => fit(get(), t);
    viewerApi.dropToFloor = dropToFloor;
    viewerApi.exportGLB = exportGLB;
    viewerApi.screenshot = () => screenshot(get());
    return () => {
      viewerApi.fit = () => {};
      viewerApi.dropToFloor = () => {};
      viewerApi.exportGLB = async () => null;
      viewerApi.screenshot = async () => null;
    };
  }, [get]);

  // Kamera kontrolcüsü (sol ve sağ tuş kamerayı oynatmaz; bkz. CadControls)
  useEffect(() => {
    const ctl = new CadControls(camera as PerspectiveCamera);
    ctl.connect(gl.domElement);
    ctl.onFocusMiss = () => fit(get(), 'all');
    const prev = get().controls;
    set({ controls: ctl });
    registerViewControls(ctl);
    return () => {
      registerViewControls(null);
      ctl.dispose();
      if (get().controls === ctl) set({ controls: prev });
    };
  }, [camera, gl, get, set]);

  useFrame((state) => {
    const c = state.controls;
    if (c instanceof CadControls) c.tick();
    if (frame.current++ % RADIUS_INTERVAL === 0 && sceneRefs.root) {
      box.current.setFromObject(sceneRefs.root);
      if (!box.current.isEmpty()) sceneRefs.radius = Math.max(box.current.getBoundingSphere(sphere.current).radius, 1e-3);
    }
    const controls = orbitOf(state);
    updateClip(state.camera as PerspectiveCamera, controls ? controls.target : null);
  });

  return null;
}
