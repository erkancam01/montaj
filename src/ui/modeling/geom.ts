// Modelleme arayüzü için küçük geometri yardımcıları (gövde-yerel koordinat, mm).
import { BufferGeometry, Matrix4, Shape, ShapeGeometry, Vector2, Vector3 } from 'three';
import { geometryCache, type ParsedMesh } from '@/core/geometry/geometryCache';
import { findRegions, regionContains, type Loop, type Region } from '@/core/sketch/profiles';
import type { Body, EdgeSig, Feature, PlaneDef, SketchFeature, SkLine, SkPoint, Vec2, Vec3 } from '@/core/types';
import { bodyFileId } from '@/core/types';

export const v3 = (a: Vec3) => new Vector3(a[0], a[1], a[2]);
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Düzlem-2B → gövde-yerel 3B dönüşüm matrisi (x = xDir, y = normal × xDir, z = normal) */
export function planeMatrix(p: PlaneDef): Matrix4 {
  const y = cross3(p.normal, p.xDir);
  return new Matrix4().makeBasis(v3(p.xDir), v3(y), v3(p.normal)).setPosition(v3(p.origin));
}

export function planeTo3(p: PlaneDef, q: Vec2): Vec3 {
  const y = cross3(p.normal, p.xDir);
  return [
    p.origin[0] + q[0] * p.xDir[0] + q[1] * y[0],
    p.origin[1] + q[0] * p.xDir[1] + q[1] * y[1],
    p.origin[2] + q[0] * p.xDir[2] + q[1] * y[2],
  ];
}

export function planeTo2(p: PlaneDef, v: Vec3): Vec2 {
  const y = cross3(p.normal, p.xDir);
  const d = sub3(v, p.origin);
  return [dot3(d, p.xDir), dot3(d, y)];
}

// ---------------------------------------------------------------- Gövde verisi

/** Gövdenin ilk mesh'i (çekirdek tek mesh üretir); geometri yoksa undefined */
export function bodyMesh(bodyId: string): ParsedMesh | undefined {
  return geometryCache.get(bodyFileId(bodyId))?.nodes[0]?.meshes[0];
}

/** Gövdenin kabaca boyutu (görsel ölçek için), en az 20 mm */
export function bodyScale(bodyId: string): number {
  const s = geometryCache.get(bodyFileId(bodyId))?.size;
  const m = s ? Math.max(s[0], s[1], s[2]) : 0;
  return Math.max(20, m);
}

export function sketchOf(body: Body | undefined, id: string): SketchFeature | undefined {
  const f = body?.features.find((x) => x.id === id);
  return f && f.type === 'sketch' ? f : undefined;
}

export function pointMap(sk: SketchFeature): Map<string, SkPoint> {
  const m = new Map<string, SkPoint>();
  for (const e of sk.entities) if (e.kind === 'point') m.set(e.id, e);
  return m;
}

export function sketchLines(sk: SketchFeature): SkLine[] {
  return sk.entities.filter((e): e is SkLine => e.kind === 'line');
}

// ---------------------------------------------------------------- Profil bölgeleri

const regionCache = new WeakMap<SketchFeature['entities'], Region[]>();

/** Sketch'in kapalı bölgeleri (varlık dizisi başına önbellekli) */
export function sketchRegions(sk: SketchFeature): Region[] {
  let r = regionCache.get(sk.entities);
  if (!r) {
    try {
      r = findRegions(sk.entities);
    } catch (e) {
      console.error('Bölgeler bulunamadı', e);
      r = [];
    }
    regionCache.set(sk.entities, r);
  }
  return r;
}

/** Noktayı içeren en küçük bölgenin indeksi; yoksa -1 */
export function regionAt(regions: Region[], p: Vec2): number {
  let best = -1;
  let bestArea = Infinity;
  regions.forEach((r, i) => {
    let inside = false;
    try {
      inside = regionContains(r, p);
    } catch {
      inside = false;
    }
    const a = Math.abs(r.area);
    if (inside && a < bestArea) {
      best = i;
      bestArea = a;
    }
  });
  return best;
}

function loopPoints(loop: Loop): Vector2[] {
  const out: Vector2[] = [];
  for (const s of loop.segs) {
    if (s.kind === 'line') {
      out.push(new Vector2(s.a[0], s.a[1]));
    } else if (s.kind === 'circle') {
      const n = 72;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        out.push(new Vector2(s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)));
      }
    } else {
      const TAU = Math.PI * 2;
      let sweep = s.ccw ? s.a1 - s.a0 : s.a0 - s.a1;
      sweep = ((sweep % TAU) + TAU) % TAU;
      if (sweep < 1e-9) sweep = TAU;
      const dir = s.ccw ? 1 : -1;
      const n = Math.max(4, Math.ceil((sweep / TAU) * 72));
      for (let i = 0; i < n; i++) {
        const t = s.a0 + dir * sweep * (i / n);
        out.push(new Vector2(s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)));
      }
    }
  }
  return out;
}

/** Bölgenin düzlem-2B dolgu geometrisi (z = 0) */
export function regionGeometry(r: Region): BufferGeometry | null {
  const outer = loopPoints(r.outer);
  if (outer.length < 3) return null;
  const shape = new Shape(outer);
  for (const h of r.holes) {
    const pts = loopPoints(h);
    if (pts.length >= 3) shape.holes.push(new Shape(pts));
  }
  try {
    return new ShapeGeometry(shape);
  } catch {
    return null;
  }
}

/** Bölge sınırları (kapalı çizgi noktaları, z = 0) */
export function regionOutline(r: Region): Vec3[][] {
  return [r.outer, ...r.holes].map((l) => {
    const pts = loopPoints(l).map((p) => [p.x, p.y, 0] as Vec3);
    if (pts.length) pts.push(pts[0]);
    return pts;
  });
}

// ---------------------------------------------------------------- Kenar imzaları

/** İki kenar imzası aynı kenarı mı gösteriyor */
export function sameSig(a: EdgeSig, b: EdgeSig): boolean {
  if (a.kind !== b.kind) return false;
  const d = Math.hypot(a.mid[0] - b.mid[0], a.mid[1] - b.mid[1], a.mid[2] - b.mid[2]);
  const tol = Math.max(0.01, 1e-4 * Math.max(a.length, b.length));
  return d < tol && Math.abs(a.length - b.length) < Math.max(0.02, 1e-3 * a.length);
}

/** Mesh kenarları içinde imzası listeden biriyle eşleşen kenar indeksleri */
export function matchEdgeIndices(mesh: ParsedMesh | undefined, sigs: EdgeSig[]): number[] {
  const be = mesh?.brepEdges;
  if (!be || !sigs.length) return [];
  const out: number[] = [];
  be.sigs.forEach((s, i) => {
    if (sigs.some((x) => sameSig(x, s))) out.push(i);
  });
  return out;
}

export function edgeLabel(s: EdgeSig): string {
  const f = (n: number) => String(Number(n.toFixed(2)));
  if (s.kind === 'line') return `Doğru · ${f(s.length)} mm`;
  if (s.kind === 'circle') return `Daire · R${f(s.radius ?? 0)}`;
  return `Eğri · ${f(s.length)} mm`;
}

// ---------------------------------------------------------------- Özellik yardımcıları

/** Desen/aynada seçilebilen özellikler: taslaktan önce gelen extrude/revolve/hole */
export function patternSources(body: Body | undefined, draftId: string): Feature[] {
  if (!body) return [];
  const out: Feature[] = [];
  for (const f of body.features) {
    if (f.id === draftId) break;
    if (f.type === 'extrude' || f.type === 'revolve' || f.type === 'hole') out.push(f);
  }
  return out;
}

export const AXIS_DIRS: Record<'X' | 'Y' | 'Z', Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** Vektör bir ana eksene (±) paralelse adı */
export function axisName(d: Vec3): string | null {
  const n = norm3(d);
  for (const [k, a] of Object.entries(AXIS_DIRS)) {
    const c = dot3(n, a);
    if (c > 0.99999) return k;
    if (c < -0.99999) return `-${k}`;
  }
  return null;
}

export function fmtVec(d: Vec3): string {
  return `(${d.map((x) => Number(x.toFixed(3))).join(', ')})`;
}

/** Düzlem temel düzlemlerden biri mi (gövde-yerel) */
export function basePlaneName(p: PlaneDef, bases: Record<string, PlaneDef>): string | null {
  for (const [k, b] of Object.entries(bases)) {
    if (Math.abs(Math.abs(dot3(norm3(p.normal), b.normal)) - 1) < 1e-6 && Math.abs(dot3(sub3(p.origin, b.origin), b.normal)) < 1e-6) return k;
  }
  return null;
}
