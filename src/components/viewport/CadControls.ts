// SolidWorks 2022 tarzı kamera kontrolcüsü (OrbitControls yerine).
// Orta tuş: döndür · Ctrl+orta: kaydır · Shift+orta: yakınlaştır · tekerlek: imlecin altına yakınlaştır ·
// orta çift tık: o noktaya odakla. Sol ve sağ tuş kamerayı hiç oynatmaz.
// Dokunmatik (pointerType 'touch'): tek parmak döndür (parmağın altındaki nokta etrafında), iki parmak
// kaydır + çimdik yakınlaştır (iki parmağın ortası etrafında), çift dokunma (tek ya da iki parmak) =
// o noktaya odakla / boşlukta tümüne sığdır, uzun basma = sağ tık (sentetik contextmenu).
// Sketch oturumunda tek parmak sketch aracına aittir (yalnız iki parmak kamerayı oynatır).
// Döndürme serbesttir (ekran eksenleri etrafında); kameranın "yukarı"sı dönüşle birlikte değişir.
import {
  EventDispatcher,
  MathUtils,
  Matrix4,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import { useAssembly } from '../../store/useAssembly';
import { gizmoBusy, sceneRefs } from './sceneRefs';
import { fireLongPress, hapticTick, LONG_PRESS_MS, TAP_PX } from '../../hooks/useLongPress';
import { markMultiTouch } from './touchState';

/** Kamera duruşu: hedef + yönelim + hedefe uzaklık (kamera hedefe −Z yönünde bakar) */
export interface ViewPose {
  target: Vector3;
  quaternion: Quaternion;
  distance: number;
}

interface CamAnim {
  t0: number;
  dur: number;
  from: ViewPose;
  to: ViewPose;
}

interface MiddleDrag {
  pointerId: number;
  lastX: number;
  lastY: number;
  startX: number;
  startY: number;
  moved: boolean;
  /** Döndürme merkezi / kaydırma-yakınlaştırma referans noktası (imlecin altındaki model noktası) */
  pivot: Vector3 | null;
}

interface TouchPt {
  x: number;
  y: number;
}

/** Tek parmak hareketi */
interface OneTouch {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  t0: number;
  moved: boolean;
  /** Sketch oturumu: tek parmak kameraya ait değil */
  passive: boolean;
  pivot: Vector3 | null;
  timer: number;
  longFired: boolean;
}

/** İki parmak hareketi */
interface TwoTouch {
  a: number;
  b: number;
  lastMid: TouchPt;
  lastDist: number;
  startMid: TouchPt;
  startDist: number;
  t0: number;
  moved: boolean;
  ref: Vector3 | null;
}

const TOUCH_DBL_MS = 350;
const TOUCH_DBL_PX = 30;

const ROTATE_SPEED = 1.1 * Math.PI; // görünüm yüksekliği başına radyan
const DRAG_ZOOM_SPEED = 0.006; // piksel başına
const WHEEL_ZOOM_SPEED = 0.0018; // deltaY (piksel) başına
const DBL_MS = 350;
const DBL_PX = 6;
const MOVE_PX = 3;

const _v = new Vector3();
const _w = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const _ndc = new Vector2();
const Z = new Vector3(0, 0, 1);

const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);

/** Nesne ve tüm ataları görünür mü */
function shown(o: Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

export class CadControls extends EventDispatcher<{ change: object }> {
  /** false iken (ör. TransformControls sürüklemesi) hiçbir fare girdisi kamerayı oynatmaz */
  enabled = true;
  /** Görünüm hedefi (yakınlaştırma referansı, ışık, near/far); her zaman bakış ekseni üzerinde tutulur */
  readonly target = new Vector3();
  readonly camera: PerspectiveCamera;

  private dom: HTMLElement | null = null;
  private anim: CamAnim | null = null;
  private drag: MiddleDrag | null = null;
  private lastMiddleUp = { t: 0, x: 0, y: 0 };
  private wheelHit: { t: number; x: number; y: number; p: Vector3 | null } | null = null;
  private readonly raycaster = new Raycaster();
  // Dokunmatik
  private readonly touches = new Map<number, TouchPt>();
  private one: OneTouch | null = null;
  private two: TwoTouch | null = null;
  /** İki parmaklı hareketten sonra kalan parmak, tüm parmaklar kalkana kadar yok sayılır */
  private touchIgnore = false;
  private lastTap = { t: 0, x: 0, y: 0 };
  private lastTwoTap = { t: 0, x: 0, y: 0 };
  /** Tek parmak kameraya ait değil mi (sketch oturumu); dışarıdan değiştirilebilir */
  oneFingerPassive: () => boolean = () => useAssembly.getState().modeling.sketch !== null;

  constructor(camera: PerspectiveCamera) {
    super();
    this.camera = camera;
    // Başlangıç hedefi: kameranın bakış ekseni üzerinde, dünya orijininin derinliğinde
    camera.updateMatrixWorld();
    const fwd = camera.getWorldDirection(new Vector3());
    const d = Math.max(camera.position.clone().negate().dot(fwd), 1);
    this.target.copy(camera.position).addScaledVector(fwd, d);
    this.update();
  }

  // ------------------------------------------------------------ DOM

  connect(dom: HTMLElement) {
    this.disconnect();
    this.dom = dom;
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('mousedown', this.onMouseDown);
    dom.addEventListener('auxclick', this.onAuxClick);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    // Dokunmatik: tarayıcı kaydırma/yakınlaştırma yapmasın, iOS uzun basma balonu çıkmasın
    dom.style.touchAction = 'none';
    dom.style.setProperty('-webkit-touch-callout', 'none');
    dom.style.setProperty('-webkit-user-select', 'none');
    dom.style.userSelect = 'none';
  }

  disconnect() {
    const dom = this.dom;
    if (!dom) return;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('pointermove', this.onPointerMove);
    dom.removeEventListener('pointerup', this.onPointerUp);
    dom.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('mousedown', this.onMouseDown);
    dom.removeEventListener('auxclick', this.onAuxClick);
    dom.removeEventListener('wheel', this.onWheel);
    this.dom = null;
    this.drag = null;
    this.resetTouch();
  }

  dispose() {
    this.disconnect();
    this.anim = null;
  }

  // ------------------------------------------------------------ Durum

  /**
   * Kamerayı hedefe çevirir (konum değişmez). Dış kod (sığdırma, eksen göstergesi) kamerayı taşıyıp
   * bunu çağırabilir. Yukarı yön, önceki yukarıya en yakın dik yön olarak korunur.
   */
  update() {
    const cam = this.camera;
    _fwd.subVectors(this.target, cam.position);
    if (_fwd.lengthSq() < 1e-18) return;
    _fwd.normalize();
    _up.copy(cam.up);
    if (_up.lengthSq() < 1e-12 || Math.abs(_up.normalize().dot(_fwd)) > 0.9995) {
      // Bakış yukarıyla çakıştı: mevcut yönelimin ekran-yukarısı, o da olmazsa dünya Z / Y
      _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      if (Math.abs(_up.dot(_fwd)) > 0.9995) _up.copy(Z);
      if (Math.abs(_up.dot(_fwd)) > 0.9995) _up.set(0, 1, 0);
    }
    _m.lookAt(cam.position, this.target, _up);
    cam.quaternion.setFromRotationMatrix(_m);
    this.syncUp();
    this.dispatchEvent({ type: 'change' });
  }

  /** camera.up = ekran-yukarı (lookAt kullanan diğer kodlar yönelimi bozmasın) */
  private syncUp() {
    this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
  }

  getPose(): ViewPose {
    return {
      target: this.target.clone(),
      quaternion: this.camera.quaternion.clone(),
      distance: this.camera.position.distanceTo(this.target),
    };
  }

  private applyPose(p: ViewPose) {
    const cam = this.camera;
    this.target.copy(p.target);
    cam.quaternion.copy(p.quaternion);
    cam.position.copy(p.target).add(_v.set(0, 0, 1).applyQuaternion(p.quaternion).multiplyScalar(p.distance));
    this.syncUp();
    cam.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  /** Yumuşak geçiş (dur ≤ 0: anında) */
  animateTo(to: ViewPose, dur = 300) {
    const pose: ViewPose = {
      target: to.target.clone(),
      quaternion: to.quaternion.clone().normalize(),
      distance: Math.max(to.distance, 1e-4),
    };
    if (dur <= 0) {
      this.anim = null;
      this.applyPose(pose);
      return;
    }
    this.anim = { t0: performance.now(), dur, from: this.getPose(), to: pose };
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  stopAnimation() {
    this.anim = null;
  }

  /** Her karede çağrılır (animasyon ilerletme) */
  tick() {
    const a = this.anim;
    if (!a) return;
    const k0 = Math.min(1, (performance.now() - a.t0) / a.dur);
    const k = easeOutCubic(k0);
    const from = a.from;
    const to = a.to;
    // Uzaklık logaritmik ara değer: çok farklı ölçeklerde düzgün yakınlaşma
    const dist = Math.exp(MathUtils.lerp(Math.log(from.distance), Math.log(to.distance), k));
    this.applyPose({
      target: _w.lerpVectors(from.target, to.target, k).clone(),
      quaternion: _q2.slerpQuaternions(from.quaternion, to.quaternion, k).clone(),
      distance: dist,
    });
    if (k0 >= 1) this.anim = null;
  }

  // ------------------------------------------------------------ Yardımcılar

  private rect(): DOMRect | null {
    const r = this.dom?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? r : null;
  }

  private setRay(cx: number, cy: number): boolean {
    const r = this.rect();
    if (!r) return false;
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(_ndc, this.camera);
    return true;
  }

  /** İmlecin altındaki görünür model noktası (yoksa null) */
  pick(cx: number, cy: number): Vector3 | null {
    const root = sceneRefs.root;
    if (!root || !this.setRay(cx, cy)) return null;
    const hits = this.raycaster.intersectObject(root, true);
    for (const h of hits) {
      if (!(h.object as Mesh).isMesh || h.object.userData.noExport) continue;
      if (!shown(h.object)) continue;
      return h.point.clone();
    }
    return null;
  }

  /** İmleç ışınının hedef derinliğindeki (bakışa dik) düzlemle kesişimi */
  private cursorOnTargetPlane(cx: number, cy: number): Vector3 | null {
    if (!this.setRay(cx, cy)) return null;
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    const ray = this.raycaster.ray;
    const den = ray.direction.dot(_fwd);
    if (den < 1e-6) return null;
    const t = _v.subVectors(this.target, cam.position).dot(_fwd) / den;
    return ray.at(t, new Vector3());
  }

  /** Hedefi, verilen noktanın derinliğine (bakış ekseni üzerinde) taşır; görüntü değişmez */
  private retarget(p: Vector3) {
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    const depth = _v.subVectors(p, cam.position).dot(_fwd);
    if (depth > 1e-4) this.target.copy(cam.position).addScaledVector(_fwd, depth);
  }

  private distanceLimits(): [number, number] {
    const r = Math.max(sceneRefs.radius, 1);
    return [Math.max(r * 1e-5, 1e-3), Math.max(r * 200, 1e5)];
  }

  /** Q noktası ekranda sabit kalacak şekilde f oranında yakınlaştırır (f < 1: yaklaş) */
  zoomAt(q: Vector3, f: number) {
    const cam = this.camera;
    const d = cam.position.distanceTo(this.target);
    if (!(d > 0) || !Number.isFinite(f) || f <= 0) return;
    const [lo, hi] = this.distanceLimits();
    const nd = MathUtils.clamp(d * f, lo, hi);
    f = nd / d;
    if (Math.abs(f - 1) < 1e-9) return;
    cam.position.sub(q).multiplyScalar(f).add(q);
    this.target.sub(q).multiplyScalar(f).add(q);
    cam.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  /** Ekran-dikey ve ekran-yatay eksenler etrafında, pivot çevresinde döndürür */
  private rotate(dx: number, dy: number, pivot: Vector3) {
    const r = this.rect();
    if (!r) return;
    const cam = this.camera;
    const s = ROTATE_SPEED / r.height;
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    _q.setFromAxisAngle(_up, -dx * s);
    _q2.setFromAxisAngle(_right, -dy * s);
    _q.multiply(_q2);
    cam.position.sub(pivot).applyQuaternion(_q).add(pivot);
    this.target.sub(pivot).applyQuaternion(_q).add(pivot);
    cam.quaternion.premultiply(_q).normalize();
    this.syncUp();
    cam.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  /** İmleç altındaki nokta imleçle birlikte gidecek şekilde kaydırır */
  private pan(dx: number, dy: number, ref: Vector3 | null) {
    const r = this.rect();
    if (!r) return;
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    const depth = Math.max(_v.subVectors(ref ?? this.target, cam.position).dot(_fwd), 1e-4);
    const wpp = (2 * depth * Math.tan(MathUtils.degToRad(cam.fov) / 2)) / r.height;
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    _v.copy(_right).multiplyScalar(-dx * wpp).addScaledVector(_up, dy * wpp);
    cam.position.add(_v);
    this.target.add(_v);
    cam.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  /** Noktayı ekran ortasına alır (yönelim ve derinlik korunur) */
  focusOn(p: Vector3, dur = 300) {
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    const depth = _v.subVectors(p, cam.position).dot(_fwd);
    const dist = depth > 1e-4 ? depth : cam.position.distanceTo(this.target);
    this.animateTo({ target: p.clone(), quaternion: cam.quaternion.clone(), distance: dist }, dur);
  }

  /** Orta tuşla boşluğa çift tık (pick yok) için dışarıdan atanır: tümüne sığdır */
  onFocusMiss: (() => void) | null = null;

  // ------------------------------------------------------------ Olaylar

  private readonly onMouseDown = (e: MouseEvent) => {
    // Orta tuş otomatik kaydırmasını engelle
    if (e.button === 1) e.preventDefault();
  };

  private readonly onAuxClick = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touchDown(e);
      return;
    }
    if (e.button !== 1) return;
    e.preventDefault();
    if (!this.enabled || gizmoBusy()) return;
    this.anim = null;
    const pivot = this.pick(e.clientX, e.clientY);
    if (pivot) this.retarget(pivot);
    this.drag = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pivot,
    };
    try {
      (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      /* yakalama desteklenmiyor */
    }
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touchMove(e);
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    // Orta tuş bırakılmış ama pointerup kaçmışsa
    if (!(e.buttons & 4)) {
      this.endDrag(e);
      return;
    }
    if (!this.enabled) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < MOVE_PX) return;
    d.moved = true;
    if (!dx && !dy) return;
    if (e.ctrlKey || e.metaKey) {
      this.pan(dx, dy, d.pivot);
    } else if (e.shiftKey) {
      // Yukarı sürükle: yaklaş
      this.zoomAt(d.pivot ?? this.target.clone(), Math.exp(dy * DRAG_ZOOM_SPEED));
    } else {
      this.rotate(dx, dy, d.pivot ?? this.target.clone());
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touchUp(e);
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (e.type === 'pointerup' && e.button !== 1 && e.buttons & 4) return; // başka tuş bırakıldı
    this.endDrag(e);
  };

  private endDrag(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      (e.target as Element | null)?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* yok say */
    }
    if (d.moved || e.type !== 'pointerup') {
      this.lastMiddleUp.t = 0;
      return;
    }
    // Orta tuşla çift tık: o noktaya odakla
    const now = performance.now();
    const prev = this.lastMiddleUp;
    if (now - prev.t < DBL_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DBL_PX) {
      prev.t = 0;
      if (!this.enabled) return;
      const p = this.pick(e.clientX, e.clientY);
      if (p) this.focusOn(p);
      else this.onFocusMiss?.();
      return;
    }
    this.lastMiddleUp = { t: now, x: e.clientX, y: e.clientY };
  }

  // ------------------------------------------------------------ Dokunmatik

  private resetTouch() {
    if (this.one) window.clearTimeout(this.one.timer);
    this.touches.clear();
    this.one = null;
    this.two = null;
    this.touchIgnore = false;
    markMultiTouch(false);
  }

  private cancelOne() {
    const o = this.one;
    if (!o) return;
    window.clearTimeout(o.timer);
    this.one = null;
  }

  /** Gizmo ile etkileşim sürüyor */
  private gizmoActive(): boolean {
    if (gizmoBusy()) return true;
    const tc = sceneRefs.gizmo as (Object3D & { dragging?: boolean }) | null;
    return !!tc?.dragging;
  }

  /** Çift dokunma: noktaya odakla / boşlukta tümüne sığdır */
  private focusAtScreen(x: number, y: number) {
    if (!this.enabled) return;
    const p = this.pick(x, y);
    if (p) this.focusOn(p);
    else this.onFocusMiss?.();
  }

  private startTwo(a: number, b: number): TwoTouch | null {
    const pa = this.touches.get(a);
    const pb = this.touches.get(b);
    if (!pa || !pb) return null;
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const dist = Math.max(Math.hypot(pa.x - pb.x, pa.y - pb.y), 1);
    const ref = this.pick(mid.x, mid.y);
    if (ref) this.retarget(ref);
    return { a, b, lastMid: mid, lastDist: dist, startMid: { ...mid }, startDist: dist, t0: performance.now(), moved: false, ref };
  }

  private touchDown(e: PointerEvent) {
    // Parça sürüklemesi (DragController) ya da gizmo kamerayı devre dışı bıraktıysa bu parmak bizim değil
    if (!this.enabled || this.gizmoActive()) return;
    if (this.touches.size >= 2) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      /* yakalama desteklenmiyor */
    }
    this.anim = null;
    if (this.touches.size === 1) {
      if (this.touchIgnore) return;
      const passive = this.oneFingerPassive();
      const o: OneTouch = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        t0: performance.now(),
        moved: false,
        passive,
        pivot: null,
        timer: 0,
        longFired: false,
      };
      if (!passive) {
        o.pivot = this.pick(e.clientX, e.clientY);
        const target = e.target ?? this.dom;
        o.timer = window.setTimeout(() => {
          if (this.one !== o || o.moved || !target || this.gizmoActive()) return;
          o.longFired = true;
          hapticTick();
          fireLongPress(target, o.startX, o.startY, o.id);
        }, LONG_PRESS_MS);
      }
      this.one = o;
      return;
    }
    // İkinci parmak: tek parmak hareketi biter, kaydır / çimdik başlar
    this.cancelOne();
    markMultiTouch(true);
    this.touchIgnore = true;
    const [a, b] = [...this.touches.keys()];
    this.two = this.startTwo(a, b);
  }

  private touchMove(e: PointerEvent) {
    const pt = this.touches.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX;
    pt.y = e.clientY;
    const t = this.two;
    if (t && (e.pointerId === t.a || e.pointerId === t.b)) {
      const pa = this.touches.get(t.a)!;
      const pb = this.touches.get(t.b)!;
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      const dist = Math.max(Math.hypot(pa.x - pb.x, pa.y - pb.y), 1);
      if (!t.moved) {
        const dm = Math.hypot(mid.x - t.startMid.x, mid.y - t.startMid.y);
        if (dm < TAP_PX && Math.abs(dist - t.startDist) < TAP_PX) return;
        t.moved = true;
      }
      const dx = mid.x - t.lastMid.x;
      const dy = mid.y - t.lastMid.y;
      const f = t.lastDist / dist;
      t.lastMid = mid;
      t.lastDist = dist;
      if (!this.enabled || this.gizmoActive()) return;
      if (dx || dy) this.pan(dx, dy, t.ref);
      if (Math.abs(f - 1) > 1e-6) {
        // Referans nokta (parmakların ortasının altındaki model noktası) kaydırmayla ortada kalır
        const q = t.ref ?? this.cursorOnTargetPlane(mid.x, mid.y) ?? this.target.clone();
        this.zoomAt(q, f);
      }
      return;
    }
    const o = this.one;
    if (!o || e.pointerId !== o.id || o.passive || o.longFired) return;
    const dx = e.clientX - o.lastX;
    const dy = e.clientY - o.lastY;
    o.lastX = e.clientX;
    o.lastY = e.clientY;
    if (!o.moved) {
      if (Math.hypot(e.clientX - o.startX, e.clientY - o.startY) < TAP_PX) return;
      o.moved = true;
      window.clearTimeout(o.timer);
      // Parmak gizmo tutamağına bastıysa (gizmo sürüklemesi başladı) kamera oynamaz
      if (this.gizmoActive()) {
        this.cancelOne();
        this.touchIgnore = true;
        return;
      }
      if (o.pivot) this.retarget(o.pivot);
    }
    if (!this.enabled || this.gizmoActive()) return;
    if (dx || dy) this.rotate(dx, dy, o.pivot ?? this.target.clone());
  }

  private touchUp(e: PointerEvent) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    try {
      (e.target as Element | null)?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* yok say */
    }
    const now = performance.now();
    const t = this.two;
    if (t && (e.pointerId === t.a || e.pointerId === t.b)) {
      this.two = null;
      // İki parmakla çift dokunma: parmakların ortasına odakla
      if (e.type === 'pointerup' && !t.moved && now - t.t0 < 300) {
        const prev = this.lastTwoTap;
        const m = t.lastMid;
        if (now - prev.t < TOUCH_DBL_MS + 150 && Math.hypot(m.x - prev.x, m.y - prev.y) < TOUCH_DBL_PX * 2) {
          this.lastTwoTap.t = 0;
          this.focusAtScreen(m.x, m.y);
        } else this.lastTwoTap = { t: now, x: m.x, y: m.y };
      } else this.lastTwoTap.t = 0;
    }
    const o = this.one;
    if (o && e.pointerId === o.id) {
      window.clearTimeout(o.timer);
      this.one = null;
      if (e.type === 'pointerup' && !o.passive && !o.moved && !o.longFired && now - o.t0 < LONG_PRESS_MS) {
        // Tek parmak çift dokunma: noktaya odakla / boşlukta sığdır (ilk dokunma yine seçim tıklamasıdır)
        const prev = this.lastTap;
        if (now - prev.t < TOUCH_DBL_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < TOUCH_DBL_PX) {
          this.lastTap.t = 0;
          this.focusAtScreen(e.clientX, e.clientY);
        } else this.lastTap = { t: now, x: e.clientX, y: e.clientY };
      } else this.lastTap.t = 0;
    }
    if (this.touches.size === 0) {
      this.touchIgnore = false;
      markMultiTouch(false);
    }
  }

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.enabled || gizmoBusy() || this.drag) return;
    this.anim = null;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 800;
    if (!dy) return;
    dy = MathUtils.clamp(dy, -300, 300);
    // SolidWorks varsayılanı: tekerleği ileri (yukarı) çevirmek uzaklaştırır, geri çevirmek yaklaştırır
    const sign = useAssembly.getState().ui.invertWheel ? 1 : -1;
    const f = Math.exp(sign * dy * WHEEL_ZOOM_SPEED);
    // İmleç altındaki nokta; aynı yerde art arda tekerlek olaylarında yeniden raycast yapılmaz
    const now = performance.now();
    const wh = this.wheelHit;
    let p: Vector3 | null;
    if (wh && now - wh.t < 200 && Math.hypot(e.clientX - wh.x, e.clientY - wh.y) < 3) {
      p = wh.p;
      wh.t = now;
    } else {
      p = this.pick(e.clientX, e.clientY);
      this.wheelHit = { t: now, x: e.clientX, y: e.clientY, p };
    }
    if (p) {
      this.retarget(p);
      this.zoomAt(p, f);
      return;
    }
    const q = this.cursorOnTargetPlane(e.clientX, e.clientY);
    this.zoomAt(q ?? this.target.clone(), f);
  };
}
