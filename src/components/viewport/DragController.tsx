// Fareyle doğrudan taşıma/döndürme (SolidWorks "bileşeni sürükle" davranışı):
// - Parçaya sol tuşla basıp sürükle: taşı (tutulan nokta, kamera düzlemine paralel düzlemde imleci izler)
// - Sağ tuşla basıp sürükle: gövde merkezi etrafında serbest döndür (trackball)
// Mate'li gövdeler çözücüde "tutulan" olarak çözülür: hareket kalan serbestlik yönlerine izdüşer
// (eşmerkezlide eksen etrafında dönme + eksen boyunca kayma, tam tanımlıda kıpırdamaz).
// 4 px eşiğinin altı tıklamadır (seçim PartNode'da); hareketsiz sağ tıka dokunulmaz.
// Dokunmatikte parça sürüklemesi yalnız dokunmatik araç çubuğundaki "Taşı" (sol-sürükle eşdeğeri) ya da
// "Döndür" (sağ-sürükle eşdeğeri) kipi açıkken yapılır; kapalıyken tek parmak kameraya aittir.
// Kip açıkken parçaya uzun basmak (hareketsiz ~500 ms) yine sağ tık menüsünü açar.
import { useEffect } from 'react';
import { fireLongPress, hapticTick, LONG_PRESS_MS, TAP_PX } from '../../hooks/useLongPress';
import { touchMode } from './touchState';
import { useThree } from '@react-three/fiber';
import { Plane, Quaternion, Raycaster, Vector2, Vector3, type Camera, type Object3D } from 'three';
import { composeT, invertT, partWorld } from '../../lib/math';
import { applyWorldDelta, groupFrameWorld, groupOfPart } from '../../lib/rigid';
import { lockedPartIds } from '../../modeling/refLocks';
import { solve, toastFixedMove, useAssembly } from '../../store/useAssembly';
import type { Doc, Transform } from '../../types';
import { inViewCube, sceneRefs } from './sceneRefs';

const THRESHOLD_PX = 4;
/** Sağ sürüklemede piksel başına dönme (rad) */
const ROT_PER_PX = 0.01;
/** Sol sürüklemede tek karede izin verilen en büyük düzeltici dönme (rad) */
const MAX_STEP_ROT = 0.35;

/** Taşınan rijit küme: instance (dönüşümü doğrudan) ya da parça / grup (parçaların dünya deltası) */
interface MoveSet {
  kind: 'instance' | 'parts';
  /** instance kind'da instance id'si; parts'ta temsilci parça / grup id'si */
  id: string;
  groupId: string | null;
  partIds: string[];
}

interface DragState {
  button: 0 | 2;
  pointerId: number;
  /** Dokunmatik sürükleme (eşik TAP_PX, uzun basma zamanlayıcısı) */
  touch: boolean;
  lpTimer: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  set: MoveSet;
  /** Tutulan nokta (dünya, basıldığı an) */
  hit: Vector3;
  active: boolean;
  blocked: boolean;
  controlsWas: boolean | null;
  /** Sürükleme başlangıcı: kümenin pozu ve tutulan noktanın küme-yerel koordinatı */
  start?: Transform;
  grabLocal?: Vector3;
  plane?: Plane;
}

let rightDragEndedAt = 0;
/** Az önce sağ tuşla sürükleme bitti mi (sağ tık menüsü açılmamalı) */
export function rightDragJustEnded(): boolean {
  return performance.now() - rightDragEndedAt < 400;
}

const _v = new Vector3();
const _q = new Quaternion();

function toTransform(p: Vector3, q: Quaternion): Transform {
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
}

/** Kümenin dünya pozu (pivot = gövde merkezi) */
function poseOf(doc: Doc, set: MoveSet): Transform | null {
  if (set.kind === 'instance') {
    const i = doc.instances.find((x) => x.id === set.id);
    return i ? { position: i.position, quaternion: i.quaternion } : null;
  }
  if (set.groupId) {
    const g = doc.groups.find((x) => x.id === set.groupId);
    return g ? groupFrameWorld(doc, g) : null;
  }
  const p = doc.parts.find((x) => x.id === set.id);
  const i = p && doc.instances.find((x) => x.id === p.instanceId);
  return p && i ? partWorld(i, p) : null;
}

/** Kümeyi base belgesinde dünya deltasıyla taşır */
function applyDelta(base: Doc, set: MoveSet, delta: Transform): Doc {
  if (set.kind === 'instance') {
    return {
      ...base,
      instances: base.instances.map((i) => (i.id === set.id ? { ...i, ...composeT(delta, i) } : i)),
    };
  }
  return applyWorldDelta(base, set.partIds, delta);
}

/** Tıklanan parçadan taşınacak küme: selectMode 'instance' → instance; gruptaki parça → grup; yoksa parça */
function moveSetOf(doc: Doc, partId: string, selectMode: string): MoveSet | null {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) return null;
  if (selectMode === 'instance') {
    return { kind: 'instance', id: part.instanceId, groupId: null, partIds: doc.parts.filter((p) => p.instanceId === part.instanceId).map((p) => p.id) };
  }
  const g = groupOfPart(doc, partId);
  return g ? { kind: 'parts', id: partId, groupId: g.id, partIds: [...g.partIds] } : { kind: 'parts', id: partId, groupId: null, partIds: [partId] };
}

/** Fare sürüklemesi şu an parçalara verilebilir mi */
function eligible(): boolean {
  const st = useAssembly.getState();
  const m = st.modeling;
  if (m.sketch || m.feature || m.pick || m.activeBodyId) return false;
  if (st.ui.tool === 'mate') return false;
  // Gizmo tutamağı üzerinde ya da gizmo sürükleniyor
  const tc = sceneRefs.gizmo as (Object3D & { axis?: string | null; dragging?: boolean }) | null;
  if (tc && (tc.axis || tc.dragging)) return false;
  return true;
}

export function DragController() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;

  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    let drag: DragState | null = null;

    const setRay = (cam: Camera, x: number, y: number) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, cam);
    };

    const pickPart = (x: number, y: number): { partId: string; point: Vector3 } | null => {
      const root = sceneRefs.root;
      if (!root) return null;
      setRay(camera, x, y);
      for (const h of raycaster.intersectObject(root, true)) {
        const id = (h.object.userData as { partId?: unknown }).partId;
        if (typeof id === 'string' && (h.object as { isMesh?: boolean }).isMesh) return { partId: id, point: h.point.clone() };
      }
      return null;
    };

    const restoreControls = () => {
      if (drag && controls && drag.controlsWas !== null) controls.enabled = drag.controlsWas;
    };

    /** Belgeyi deneme amaçlı çözer: hedef poz → çözülmüş poz */
    const trial = (d: DragState, base: Doc, target: Transform): Transform | null => {
      const delta = composeT(target, invertT(d.start!));
      const r = solve(base, applyDelta(base, d.set, delta), d.set.partIds);
      return poseOf(r.doc, d.set);
    };

    const commitTarget = (d: DragState, target: Transform) => {
      const delta = composeT(target, invertT(d.start!));
      useAssembly.getState().updateLive((base) => applyDelta(base, d.set, delta), d.set.partIds);
    };

    const beginActive = (d: DragState): void => {
      d.active = true;
      const st = useAssembly.getState();
      const doc = st.doc;
      if (d.set.partIds.some((id) => doc.parts.find((p) => p.id === id)?.fixed === true)) {
        d.blocked = true;
        toastFixedMove();
        return;
      }
      const locked = doc.bodies.length ? lockedPartIds(doc) : null;
      if (locked && d.set.partIds.some((id) => locked.has(id))) {
        d.blocked = true;
        st.showToast('Bu parça başka bir parçaya bağlı; konumunu ondan alır. Taşımak için özellik ağacında "Bağlantıyı kopar".');
        return;
      }
      const start = poseOf(doc, d.set);
      if (!start) {
        d.blocked = true;
        return;
      }
      d.start = start;
      const sp = new Vector3(...start.position);
      const sq = new Quaternion(...start.quaternion);
      d.grabLocal = d.hit.clone().sub(sp).applyQuaternion(sq.clone().invert());
      const n = camera.getWorldDirection(new Vector3());
      d.plane = new Plane().setFromNormalAndCoplanarPoint(n, d.hit);
      st.beginDrag();
    };

    const moveTranslate = (d: DragState, x: number, y: number) => {
      const st = useAssembly.getState();
      const base = st.dragBase() ?? st.doc;
      const cur = poseOf(st.doc, d.set);
      if (!cur) return;
      setRay(camera, x, y);
      const P = raycaster.ray.intersectPlane(d.plane!, new Vector3());
      if (!P) return;
      const cp = new Vector3(...cur.position);
      const cq = new Quaternion(...cur.quaternion);
      const grab = (p: Vector3, q: Quaternion) => d.grabLocal!.clone().applyQuaternion(q).add(p);
      const g = grab(cp, cq);
      const e = P.clone().sub(g);
      if (e.lengthSq() < 1e-12) return;
      // 1) Öteleme denemesi
      const t1 = toTransform(cp.clone().add(e), cq);
      const r1 = trial(d, base, t1);
      if (!r1) return;
      const p1 = new Vector3(...r1.position);
      const q1 = new Quaternion(...r1.quaternion);
      const g1 = grab(p1, q1);
      const e1 = P.clone().sub(g1);
      let target = t1;
      // 2) Öteleme kısıtlarla emildiyse (ör. yalnız dönme serbest) tutulan noktayı imlece doğru döndür
      if (e1.length() > Math.max(0.05 * e.length(), 1e-4)) {
        const r = g1.clone().sub(p1);
        const rr = r.lengthSq();
        if (rr > 1e-9) {
          const w = new Vector3().crossVectors(r, e1).divideScalar(rr);
          const ang = Math.min(w.length(), MAX_STEP_ROT);
          if (ang > 1e-9) {
            const dq = _q.setFromAxisAngle(w.normalize(), ang);
            const q2 = dq.clone().multiply(q1);
            const t2 = toTransform(p1.clone(), q2);
            const r2 = trial(d, base, t2);
            if (r2) {
              const g2 = grab(new Vector3(...r2.position), new Quaternion(...r2.quaternion));
              if (P.distanceTo(g2) < e1.length() - 1e-6) target = t2;
            }
          }
        }
      }
      commitTarget(d, target);
    };

    const moveRotate = (d: DragState, dx: number, dy: number) => {
      const st = useAssembly.getState();
      const cur = poseOf(st.doc, d.set);
      if (!cur) return;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return;
      // Ekranda sağa sürükleme kameranın yukarı ekseni etrafında, aşağı sürükleme sağ ekseni etrafında döndürür
      const up = _v.set(0, 1, 0).applyQuaternion(camera.quaternion).clone();
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const axis = up.multiplyScalar(dx).addScaledVector(right, dy).normalize();
      const dq = new Quaternion().setFromAxisAngle(axis, len * ROT_PER_PX);
      const q = dq.multiply(new Quaternion(...cur.quaternion)).normalize();
      commitTarget(d, toTransform(new Vector3(...cur.position), q));
    };

    const finish = (cancel: boolean) => {
      const d = drag;
      if (!d) return;
      if (d.active && !d.blocked) {
        const st = useAssembly.getState();
        if (cancel) st.updateLive((base) => base);
        st.endDrag();
      }
      if (d.button === 2 && d.active && !d.touch) rightDragEndedAt = performance.now();
      window.clearTimeout(d.lpTimer);
      restoreControls();
      drag = null;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
    };

    const onMove = (e: PointerEvent) => {
      const d = drag;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < (d.touch ? TAP_PX : THRESHOLD_PX)) return;
        window.clearTimeout(d.lpTimer);
        beginActive(d);
      }
      if (d.blocked) return;
      if (d.button === 0) moveTranslate(d, e.clientX, e.clientY);
      else moveRotate(d, e.clientX - d.lastX, e.clientY - d.lastY);
      d.lastX = e.clientX;
      d.lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointerId) finish(false);
    };
    const onCancel = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointerId) finish(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag?.active) {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };

    const onDown = (e: PointerEvent) => {
      if (e.target !== canvas || drag || inViewCube(e.clientX, e.clientY)) return;
      const touch = e.pointerType === 'touch';
      let button = e.button;
      if (touch) {
        // Dokunmatik: yalnız Taşı / Döndür kipinde ve ilk parmakla
        const mode = touchMode();
        if (mode === 'camera' || !e.isPrimary || e.button !== 0) return;
        button = mode === 'move' ? 0 : 2;
      }
      if (button !== 0 && button !== 2) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!eligible()) return;
      const hit = pickPart(e.clientX, e.clientY);
      if (!hit) return;
      const st = useAssembly.getState();
      const set = moveSetOf(st.doc, hit.partId, st.ui.selectMode);
      if (!set) return;
      drag = {
        button: button as 0 | 2,
        pointerId: e.pointerId,
        touch,
        lpTimer: 0,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        set,
        hit: hit.point,
        active: false,
        blocked: false,
        controlsWas: null,
      };
      if (touch) {
        // Kıpırdamadan uzun basma: sürükleme yerine sağ tık menüsü
        const d0 = drag;
        const { clientX: x, clientY: y, pointerId: pid } = e;
        d0.lpTimer = window.setTimeout(() => {
          if (drag !== d0 || d0.active) return;
          finish(true);
          hapticTick();
          fireLongPress(canvas, x, y, pid);
        }, LONG_PRESS_MS);
      }
      // Parçanın üstünde basıldı: kamera kontrolü bu sürüklemeyi almasın (bırakınca geri açılır)
      if (controls) {
        drag.controlsWas = controls.enabled;
        controls.enabled = false;
      }
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('keydown', onKey, true);
    };

    // Sağ tuşla sürükleme sonrası (Windows'ta tuş bırakılınca gelir) bağlam menüsü açılmasın
    const onContextMenu = (e: MouseEvent) => {
      if ((drag?.button === 2 && drag.active) || rightDragJustEnded()) {
        e.preventDefault();
        e.stopPropagation();
        rightDragEndedAt = 0;
      }
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      finish(true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [gl, camera, controls]);

  return null;
}
