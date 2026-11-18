// Sketch katmanı (Canvas içi) ile DOM katmanları (araç çubuğu, etiketler) arasında paylaşılan görünüm referansları.
import { PerspectiveCamera, Plane, Ray, Vector3, type Camera, type OrthographicCamera } from 'three';
import type { Vec2 } from '../../modeling/types';

export interface WorldPlane {
  o: Vector3;
  x: Vector3;
  y: Vector3;
  n: Vector3;
}

export const view: {
  camera: Camera | null;
  dom: HTMLCanvasElement | null;
  plane: WorldPlane | null;
  /** Etiket kabı (overlay); konumlar buna göre */
  overlay: HTMLElement | null;
} = { camera: null, dom: null, plane: null, overlay: null };

const _v = new Vector3();
const _w = new Vector3();
const _ray = new Ray();
const _pl = new Plane();

export function sketchToWorld(p: Vec2, out = new Vector3()): Vector3 {
  const pl = view.plane;
  if (!pl) return out.set(p[0], p[1], 0);
  return out.copy(pl.o).addScaledVector(pl.x, p[0]).addScaledVector(pl.y, p[1]);
}

export function worldToSketch(w: Vector3): Vec2 {
  const pl = view.plane;
  if (!pl) return [w.x, w.y];
  _w.copy(w).sub(pl.o);
  return [_w.dot(pl.x), _w.dot(pl.y)];
}

/** İstemci (clientX/Y) koordinatından sketch düzlemine ışın kesişimi */
export function clientToSketch(cx: number, cy: number): Vec2 | null {
  const cam = view.camera;
  const dom = view.dom;
  const pl = view.plane;
  if (!cam || !dom || !pl) return null;
  const r = dom.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const nx = ((cx - r.left) / r.width) * 2 - 1;
  const ny = -((cy - r.top) / r.height) * 2 + 1;
  cam.updateMatrixWorld();
  if ((cam as PerspectiveCamera).isPerspectiveCamera) {
    _ray.origin.setFromMatrixPosition(cam.matrixWorld);
    _ray.direction.set(nx, ny, 0.5).unproject(cam).sub(_ray.origin).normalize();
  } else {
    _ray.origin.set(nx, ny, -1).unproject(cam);
    _ray.direction.set(0, 0, -1).transformDirection(cam.matrixWorld);
  }
  _pl.setFromNormalAndCoplanarPoint(pl.n, pl.o);
  const hit = _ray.intersectPlane(_pl, _v);
  if (!hit) {
    // Düzleme paralel bakış: ışının düzleme izdüşümü
    _ray.closestPointToPoint(pl.o, _v);
    _pl.projectPoint(_v, _w);
    return worldToSketch(_w);
  }
  return worldToSketch(hit);
}

interface FrameRect {
  w: number;
  h: number;
  ox: number;
  oy: number;
}

function frameRect(): FrameRect | null {
  const dom = view.dom;
  if (!dom) return null;
  const r = dom.getBoundingClientRect();
  const o = view.overlay?.getBoundingClientRect();
  return { w: r.width, h: r.height, ox: o ? r.left - o.left : 0, oy: o ? r.top - o.top : 0 };
}

/** Sketch noktasının overlay pikselleri (görünür değilse null) */
export function sketchToOverlay(p: Vec2, fr: FrameRect | null = frameRect()): { x: number; y: number } | null {
  const cam = view.camera;
  if (!cam || !fr) return null;
  sketchToWorld(p, _v).project(cam);
  if (_v.z > 1 || _v.z < -1) return null;
  return { x: fr.ox + ((_v.x + 1) / 2) * fr.w, y: fr.oy + ((1 - _v.y) / 2) * fr.h };
}

/** İstemci koordinatını overlay koordinatına çevirir */
export function clientToOverlay(cx: number, cy: number): { x: number; y: number } {
  const o = view.overlay?.getBoundingClientRect() ?? view.dom?.getBoundingClientRect();
  return o ? { x: cx - o.left, y: cy - o.top } : { x: cx, y: cy };
}

/** Bir sketch noktasında 1 pikselin sketch birimi (mm) karşılığı */
export function pxSize(at?: Vec2): number {
  const cam = view.camera;
  const dom = view.dom;
  if (!cam || !dom) return 1;
  const h = dom.clientHeight || 1;
  if ((cam as PerspectiveCamera).isPerspectiveCamera) {
    const pc = cam as PerspectiveCamera;
    const wp = at ? sketchToWorld(at, _w) : view.plane ? _w.copy(view.plane.o) : _w.set(0, 0, 0);
    _v.setFromMatrixPosition(pc.matrixWorld);
    // görüş yönü boyunca derinlik
    const dir = new Vector3(0, 0, -1).transformDirection(pc.matrixWorld);
    const depth = Math.max(Math.abs(wp.sub(_v).dot(dir)), 1e-6);
    return (2 * depth * Math.tan((pc.fov * Math.PI) / 360)) / (pc.zoom * h);
  }
  const oc = cam as OrthographicCamera;
  return (oc.top - oc.bottom) / (oc.zoom * h);
}

// ---------------------------------------------------------------- DOM etiket kaydı
// Etiket elemanları (ölçü değerleri, kısıt rozetleri) sketch noktasına bağlı kaydedilir; Canvas'taki
// useFrame her karede konumlarını günceller (React yeniden çizimi olmadan).

interface LabelEntry {
  el: HTMLElement;
  p: Vec2;
  /** piksel kaydırma */
  dx: number;
  dy: number;
}

export const labelRegistry = new Map<string, LabelEntry>();

export function registerLabel(key: string, el: HTMLElement | null, p: Vec2, dx = 0, dy = 0) {
  if (!el) {
    labelRegistry.delete(key);
    return;
  }
  labelRegistry.set(key, { el, p, dx, dy });
  placeLabel(labelRegistry.get(key)!, frameRect());
}

function placeLabel(l: LabelEntry, fr: FrameRect | null) {
  const s = sketchToOverlay(l.p, fr);
  if (!s) {
    l.el.style.visibility = 'hidden';
    return;
  }
  l.el.style.visibility = '';
  l.el.style.transform = `translate(${(s.x + l.dx).toFixed(1)}px, ${(s.y + l.dy).toFixed(1)}px) translate(-50%, -50%)`;
}

export function updateLabels() {
  if (!labelRegistry.size) return;
  const fr = frameRect();
  for (const l of labelRegistry.values()) placeLabel(l, fr);
}
