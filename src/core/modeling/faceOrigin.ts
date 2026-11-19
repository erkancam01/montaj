// Gövde yüzlerinin kökeni (topolojik adlandırma): her mesh yüzünün hangi özellik + sketch eğrisi
// (ya da uzatma kapağı) tarafından üretildiğini geometriden çıkarır. Parametre değişince yüz indeksleri ve
// konumları kayar, köken aynı kalır; mate ve projeksiyon referansları önce kökenle yeniden eşlenir.
//
// computeFaceOrigins saf fonksiyondur (yüz geometrisi listesi + özellikler → kökenler; Node testlerinde
// çalışır). faceOrigins/computeAndCacheOrigins geometryCache'teki üretilmiş gövdeye uygular.
import { getFaceGeom } from '@/core/geometry/faceGeometry';
import { geometryCache, type ParsedFile } from '@/core/geometry/geometryCache';
import { findRegions, selectRegions, type Seg } from '@/core/sketch/profiles';
import type { ExtrudeFeature, FaceGeom, FaceOrigin, Feature, PlaneDef, RevolveFeature, SketchFeature, SkCurve, Vec2, Vec3 } from '@/core/types';

// ---------------------------------------------------------------- vektör yardımcıları

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
/** p noktasının (o, d birim) doğrusuna uzaklığı */
const lineDist = (p: Vec3, o: Vec3, d: Vec3) => {
  const v = sub(p, o);
  return vlen(sub(v, mul(d, dot(v, d))));
};

interface Frame {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  n: Vec3;
}

/** kernel/build.ts frameOf ile aynı (replicad'i ana iş parçacığına çekmemek için kopya) */
function frameOf(p: PlaneDef): Frame {
  const n = unit(p.normal);
  let x = sub(p.xDir, mul(n, dot(p.xDir, n)));
  if (vlen(x) < 1e-9) x = Math.abs(n[0]) < 0.9 ? cross([1, 0, 0], n) : cross([0, 1, 0], n);
  x = unit(x);
  return { o: [...p.origin], x, y: cross(n, x), n };
}
const to3 = (f: Frame, p: Vec2): Vec3 => add(f.o, add(mul(f.x, p[0]), mul(f.y, p[1])));

// ---------------------------------------------------------------- köken eşitliği

export function sameOrigin(a: FaceOrigin | undefined, b: FaceOrigin | undefined): boolean {
  return !!a && !!b && a.featureId === b.featureId && a.entityId === b.entityId && a.cap === b.cap;
}

/** Kökeni o olan yüzler (mesh × yüz indeksleri) */
export function originCandidates(origins: (FaceOrigin | undefined)[][], o: FaceOrigin): { meshIndex: number; faceIndex: number }[] {
  const out: { meshIndex: number; faceIndex: number }[] = [];
  origins.forEach((row, mi) => row.forEach((f, fi) => {
    if (sameOrigin(f, o)) out.push({ meshIndex: mi, faceIndex: fi });
  }));
  return out;
}

// ---------------------------------------------------------------- sketch eğrileri

interface Curve2 {
  id: string;
  kind: 'line' | 'circle' | 'arc';
  a?: Vec2;
  b?: Vec2;
  c?: Vec2;
  r?: number;
}

const near2 = (p: Vec2, q: Vec2, tol: number) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;

/** Yardımcı olmayan eğrilerin 2B geometrisi */
function curvesOf(sk: SketchFeature): Curve2[] {
  const pts = new Map<string, Vec2>();
  for (const e of sk.entities) if (e.kind === 'point') pts.set(e.id, [e.x, e.y]);
  const out: Curve2[] = [];
  for (const e of sk.entities as (SkCurve | { kind: 'point' })[]) {
    if (e.kind === 'point' || e.construction) continue;
    if (e.kind === 'line') {
      const a = pts.get(e.p1);
      const b = pts.get(e.p2);
      if (a && b) out.push({ id: e.id, kind: 'line', a, b });
    } else if (e.kind === 'circle') {
      const c = pts.get(e.c);
      if (c) out.push({ id: e.id, kind: 'circle', c, r: e.r });
    } else {
      const c = pts.get(e.c);
      const s = pts.get(e.start);
      const t = pts.get(e.end);
      if (c && s && t) out.push({ id: e.id, kind: 'arc', c, a: s, b: t, r: Math.hypot(s[0] - c[0], s[1] - c[1]) });
    }
  }
  return out;
}

/**
 * Özelliğin kullandığı bölgelerin sınırındaki eğriler (profilePoints'e göre) ve bölgelerin 2B sınır kutusu.
 * findRegions eğrileri kesişimlerden bölmez: her sınır parçası tek bir eğriye karşılık gelir.
 */
function usedCurves(sk: SketchFeature, profilePoints: Vec2[], tol: number): { curves: Curve2[]; box: [Vec2, Vec2] | null } {
  const all = curvesOf(sk);
  let regions;
  try {
    regions = selectRegions(findRegions(sk.entities), profilePoints);
  } catch {
    return { curves: all, box: null };
  }
  const segs: Seg[] = [];
  for (const r of regions) {
    segs.push(...r.outer.segs);
    for (const h of r.holes) segs.push(...h.segs);
  }
  if (!segs.length) return { curves: [], box: null };
  const lo: Vec2 = [Infinity, Infinity];
  const hi: Vec2 = [-Infinity, -Infinity];
  const grow = (p: Vec2, r = 0) => {
    lo[0] = Math.min(lo[0], p[0] - r);
    lo[1] = Math.min(lo[1], p[1] - r);
    hi[0] = Math.max(hi[0], p[0] + r);
    hi[1] = Math.max(hi[1], p[1] + r);
  };
  for (const s of segs) {
    if (s.kind === 'line') {
      grow(s.a);
      grow(s.b);
    } else grow(s.c, s.r);
  }
  const onSeg = (c: Curve2) =>
    segs.some((s) => {
      if (c.kind === 'line') {
        return s.kind === 'line' && ((near2(s.a, c.a!, tol) && near2(s.b, c.b!, tol)) || (near2(s.a, c.b!, tol) && near2(s.b, c.a!, tol)));
      }
      if (s.kind === 'line') return false;
      if (!near2(s.c, c.c!, tol) || Math.abs(s.r - c.r!) > tol) return false;
      if (c.kind === 'circle' || s.kind === 'circle') return true;
      return (near2(s.a, c.a!, tol) && near2(s.b, c.b!, tol)) || (near2(s.a, c.b!, tol) && near2(s.b, c.a!, tol));
    });
  return { curves: all.filter(onSeg), box: [lo, hi] };
}

// ---------------------------------------------------------------- uzatma aralığı

/** Extrude'un normal boyunca ofsetleri: kapaklar (adlı) ve yan yüz aralığı. Tüm gövde boyunca: aralık yok. */
function extrudeSpan(ft: ExtrudeFeature): { caps: { cap: 'start' | 'end'; t: number }[]; range: [number, number] | null } {
  const sign = ft.reverse ? -1 : 1;
  const d = ft.distance;
  if (ft.throughAll) return { caps: ft.extent === 'oneSide' ? [{ cap: 'start', t: 0 }] : [], range: null };
  let start: number;
  let end: number;
  if (ft.extent === 'symmetric') {
    start = -d / 2;
    end = d / 2;
  } else if (ft.extent === 'twoSides') {
    start = -sign * ft.distance2;
    end = sign * d;
  } else {
    start = 0;
    end = sign * d;
  }
  return { caps: [{ cap: 'start', t: start }, { cap: 'end', t: end }], range: [Math.min(start, end), Math.max(start, end)] };
}

// ---------------------------------------------------------------- köken hesabı

interface Match {
  featIdx: number;
  origin: FaceOrigin;
}

const PAR = 1e-3; // yön paralelliği (cos sapması)

function extrudeMatches(
  ft: ExtrudeFeature,
  sk: SketchFeature,
  faces: (FaceGeom | null)[],
  tol: number,
  push: (fi: number, o: FaceOrigin) => void,
) {
  const f = frameOf(sk.plane);
  const n = f.n;
  const { curves, box } = usedCurves(sk, ft.profilePoints, tol);
  if (!curves.length) return;
  const span = extrudeSpan(ft);
  const inRange = (t: number) => !span.range || (t >= span.range[0] - tol && t <= span.range[1] + tol);
  faces.forEach((g, fi) => {
    if (!g || g.kind === 'other') return;
    if (g.kind === 'plane') {
      const cn = dot(g.normal, n);
      const t = dot(sub(g.point, f.o), n);
      if (Math.abs(Math.abs(cn) - 1) < PAR) {
        // Kapak: sketch düzlemine paralel, ofseti bir kapak ofsetine eşit, merkezi profil kutusunda
        const cap = span.caps.find((c) => Math.abs(c.t - t) <= tol);
        if (!cap) return;
        if (box) {
          const v = sub(g.point, f.o);
          const x = dot(v, f.x);
          const y = dot(v, f.y);
          if (x < box[0][0] - tol || x > box[1][0] + tol || y < box[0][1] - tol || y > box[1][1] + tol) return;
        }
        push(fi, { featureId: ft.id, cap: cap.cap });
        return;
      }
      if (Math.abs(cn) > PAR || !inRange(t)) return;
      // Yan yüz: sketch çizgisini içerir, uzatma yönüne paralel
      for (const c of curves) {
        if (c.kind !== 'line') continue;
        const a = to3(f, c.a!);
        const b = to3(f, c.b!);
        if (Math.abs(dot(sub(a, g.point), g.normal)) > tol || Math.abs(dot(sub(b, g.point), g.normal)) > tol) continue;
        const L = vlen(sub(b, a));
        if (L < tol) continue;
        const u = dot(sub(g.point, a), unit(sub(b, a)));
        if (u < -tol || u > L + tol) continue;
        push(fi, { featureId: ft.id, entityId: c.id });
      }
      return;
    }
    // Silindir: daire/yay, eksen uzatma yönüne paralel ve eğri merkezinden geçer, yarıçap eşit
    if (Math.abs(Math.abs(dot(g.axis, n)) - 1) > PAR) return;
    if (!inRange(dot(sub(g.point, f.o), n))) return;
    for (const c of curves) {
      if (c.kind === 'line') continue;
      const rt = tol + 0.01 * c.r!;
      if (Math.abs(g.radius - c.r!) > rt) continue;
      if (lineDist(to3(f, c.c!), g.point, g.axis) > rt) continue;
      push(fi, { featureId: ft.id, entityId: c.id });
    }
  });
}

function revolveMatches(
  ft: RevolveFeature,
  sk: SketchFeature,
  faces: (FaceGeom | null)[],
  tol: number,
  push: (fi: number, o: FaceOrigin) => void,
) {
  const f = frameOf(sk.plane);
  const ax = sk.entities.find((e) => e.id === ft.axisLineId);
  if (!ax || ax.kind !== 'line') return;
  const pt = (id: string) => {
    const p = sk.entities.find((e) => e.id === id);
    return p && p.kind === 'point' ? to3(f, [p.x, p.y]) : null;
  };
  const a0 = pt(ax.p1);
  const a1 = pt(ax.p2);
  if (!a0 || !a1 || vlen(sub(a1, a0)) < 1e-9) return;
  const dir = unit(sub(a1, a0));
  const { curves } = usedCurves(sk, ft.profilePoints, tol);
  const lines = curves.filter((c) => c.kind === 'line' && c.id !== ft.axisLineId).map((c) => {
    const p = to3(f, c.a!);
    const q = to3(f, c.b!);
    return { id: c.id, p, q, d: unit(sub(q, p)) };
  });
  faces.forEach((g, fi) => {
    if (!g || g.kind === 'other') return;
    for (const l of lines) {
      const tp = dot(sub(l.p, a0), dir);
      const tq = dot(sub(l.q, a0), dir);
      if (Math.abs(Math.abs(dot(l.d, dir)) - 1) < 1e-6) {
        // Eksene paralel çizgi → silindir
        if (g.kind !== 'cylinder') continue;
        const r = lineDist(l.p, a0, dir);
        if (r < tol) continue;
        const rt = tol + 0.01 * r;
        if (Math.abs(Math.abs(dot(g.axis, dir)) - 1) > PAR || Math.abs(g.radius - r) > rt) continue;
        if (lineDist(g.point, a0, dir) > rt) continue;
        const t = dot(sub(g.point, a0), dir);
        if (t < Math.min(tp, tq) - tol || t > Math.max(tp, tq) + tol) continue;
        push(fi, { featureId: ft.id, entityId: l.id });
      } else if (Math.abs(dot(l.d, dir)) < 1e-6) {
        // Eksene dik çizgi → düzlem (normali eksen)
        if (g.kind !== 'plane') continue;
        if (Math.abs(Math.abs(dot(g.normal, dir)) - 1) > PAR) continue;
        if (Math.abs(dot(sub(g.point, a0), dir) - tp) > tol) continue;
        const rMax = Math.max(lineDist(l.p, a0, dir), lineDist(l.q, a0, dir));
        if (lineDist(g.point, a0, dir) > rMax + tol) continue;
        push(fi, { featureId: ft.id, entityId: l.id });
      }
    }
  });
}

/**
 * Yüz geometrisi listesi (gövde-yerel; null/other = tanınmayan) + özellik geçmişi → yüz başına köken.
 * Bir yan yüze birden çok özellik uyarsa en sonuncusu (yüzü son şekillendiren), kapağa birden çok özellik
 * uyarsa en eskisi seçilir; aynı özellikte birden çok eğri uyarsa belirsizdir, köken verilmez. Delik/radyus/pah/desen/ayna yüzleri köken almaz.
 * scale: gövde boyutu (mm, köşegen) — tolerans 1e-4·ölçek. failed: üretilemeyen özellik id'leri.
 */
export function computeFaceOrigins(
  features: Feature[],
  faces: (FaceGeom | null)[],
  scale: number,
  failed?: ReadonlySet<string> | Record<string, unknown>,
): (FaceOrigin | undefined)[] {
  const tol = 1e-4 * Math.max(scale, 1) + 1e-4;
  const isFailed = (id: string) =>
    !!failed && (failed instanceof Set ? failed.has(id) : Object.prototype.hasOwnProperty.call(failed, id));
  const matches: Match[][] = faces.map(() => []);
  const sketches = new Map<string, SketchFeature>();
  features.forEach((ft, featIdx) => {
    if (ft.suppressed) return;
    if (ft.type === 'sketch') {
      sketches.set(ft.id, ft);
      return;
    }
    if (isFailed(ft.id)) return;
    const push = (fi: number, origin: FaceOrigin) => matches[fi].push({ featIdx, origin });
    if (ft.type === 'extrude') {
      const sk = sketches.get(ft.sketchId);
      if (sk) extrudeMatches(ft, sk, faces, tol, push);
    } else if (ft.type === 'revolve') {
      const sk = sketches.get(ft.sketchId);
      if (sk) revolveMatches(ft, sk, faces, tol, push);
    }
  });
  return matches.map((all) => {
    if (!all.length) return undefined;
    // Yan yüzler: en son özellik (yüzü son şekillendiren). Kapaklar: en eski özellik — sonraki özelliğin
    // var olan bir yüzle çakışan kapağı (üstüne eklenen çıkıntının tabanı, cebin ağzı) gerçek yüz değildir.
    const sides = all.filter((m) => !m.origin.cap);
    const ms = sides.length ? sides : all;
    const pick = sides.length ? Math.max(...ms.map((m) => m.featIdx)) : Math.min(...ms.map((m) => m.featIdx));
    const top = ms.filter((m) => m.featIdx === pick);
    const first = top[0].origin;
    return top.every((m) => sameOrigin(m.origin, first)) ? first : undefined;
  });
}

// ---------------------------------------------------------------- önbellek (üretilmiş gövdeler)

type Origins = (FaceOrigin | undefined)[][];
const cache = new Map<string, { file: ParsedFile; origins: Origins[] }>();

/** geometryCache'teki gövde dosyasının (fileId) yüz kökenleri: düğüm (ayrı katı) × mesh × yüz */
export function faceOrigins(features: Feature[], fileId: string, failed?: Record<string, unknown>): Origins[] {
  const file = geometryCache.get(fileId);
  if (!file) return [];
  // Ölçek tüm gövdeden (katılar aynı gövde-yerel koordinatta)
  const scale = Math.hypot(...file.size);
  return file.nodes.map((node, nodeKey) => {
    const part = { fileId, nodeKey };
    return node.meshes.map((m, mi) => {
      const geoms = m.faces.map((_, fi) => getFaceGeom(part, mi, fi));
      return computeFaceOrigins(features, geoms, scale, failed);
    });
  });
}

/** Üretimden sonra çağrılır: kökenleri hesaplayıp dosyayla birlikte önbellekler */
export function computeAndCacheOrigins(fileId: string, features: Feature[], failed?: Record<string, unknown>) {
  const file = geometryCache.get(fileId);
  if (!file) {
    cache.delete(fileId);
    return;
  }
  try {
    cache.set(fileId, { file, origins: faceOrigins(features, fileId, failed) });
  } catch (e) {
    console.error('Yüz kökenleri hesaplanamadı', e);
    cache.delete(fileId);
  }
}

export function dropOrigins(fileId: string) {
  cache.delete(fileId);
}

/** Güncel geometride bir düğümün (katının) köken tablosu (dosya değiştiyse / hesaplanmadıysa null) */
export function originsOf(fileId: string, nodeKey = 0): Origins | null {
  const hit = cache.get(fileId);
  return hit && hit.file === geometryCache.get(fileId) ? (hit.origins[nodeKey] ?? null) : null;
}

/** Tek yüzün kökeni */
export function originOf(fileId: string, meshIndex: number, faceIndex: number, nodeKey = 0): FaceOrigin | undefined {
  return originsOf(fileId, nodeKey)?.[meshIndex]?.[faceIndex];
}
