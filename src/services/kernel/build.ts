// Gövde üretimi: özellik geçmişini replicad (OpenCascade) ile katıya çevirir.
// Worker'dan bağımsızdır (Node testlerinde de çalışır); setOC() önceden çağrılmış olmalıdır.
import {
  addHolesInFace,
  assembleWire,
  basicFaceExtrusion,
  genericSweep,
  makeCircle,
  makeCompound,
  makeFace,
  makeLine,
  makePolygon,
  makeThreePointArc,
  measureVolume,
  revolution,
  Vector,
  type AnyShape,
  type Edge,
  type Face,
  type Shape3D,
  type Wire,
} from 'replicad';
import { arcMid, findRegions, reverseLoop, selectRegions, type Loop, type Region, type Seg } from '@/core/sketch/profiles';
import type {
  Body,
  BoolOp,
  ChamferFeature,
  CircularPatternFeature,
  EdgeSig,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  HoleFeature,
  LinearPatternFeature,
  MirrorFeature,
  PlaneDef,
  RevolveFeature,
  SketchFeature,
  SweepFeature,
  Vec2,
  Vec3,
} from '@/core/types';

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

/** Düzlem çerçevesi: x, y = n × x, n (birim, dik) */
export interface Frame {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  n: Vec3;
}

export function frameOf(p: PlaneDef): Frame {
  const n = unit(p.normal);
  // xDir'i normale dik hâle getir (sayısal kayma)
  let x = sub(p.xDir, mul(n, dot(p.xDir, n)));
  if (vlen(x) < 1e-9) x = Math.abs(n[0]) < 0.9 ? cross([1, 0, 0], n) : cross([0, 1, 0], n);
  x = unit(x);
  return { o: [...p.origin], x, y: cross(n, x), n };
}

export const to3 = (f: Frame, p: Vec2): Vec3 => add(f.o, add(mul(f.x, p[0]), mul(f.y, p[1])));

// ---------------------------------------------------------------- hata

/** Özelliğe özgü Türkçe hata */
export class FeatureError extends Error {}

/** OCC/replicad istisnalarını kısa Türkçe mesaja çevirir */
export function errText(e: unknown, fallback: string): string {
  if (e instanceof FeatureError) return e.message;
  if (typeof e === 'number') return `${fallback} (geometri çekirdeği hatası)`;
  const m = e instanceof Error ? e.message : String(e);
  if (/[çğışöüÇĞİŞÖÜ]/.test(m)) return m;
  return m ? `${fallback} (${m})` : fallback;
}

// ---------------------------------------------------------------- profil → yüz

function segEdge(f: Frame, s: Seg): Edge {
  if (s.kind === 'line') return makeLine(to3(f, s.a), to3(f, s.b));
  if (s.kind === 'circle') return makeCircle(s.r, to3(f, s.c), f.n);
  return makeThreePointArc(to3(f, s.a), to3(f, arcMid(s)), to3(f, s.b));
}

function loopWire(f: Frame, loop: Loop): Wire {
  return assembleWire(loop.segs.map((s) => segEdge(f, s)));
}

/** Bölgeden düzlemsel yüz (deliklerle); yüz normali = düzlem normali */
export function regionFace(f: Frame, r: Region): Face {
  let face = makeFace(loopWire(f, r.outer));
  if (r.holes.length) face = addHolesInFace(face, r.holes.map((h) => loopWire(f, h)));
  const nrm = face.normalAt().toTuple();
  if (dot(nrm, f.n) < 0) face = face.flipOrientation();
  return face;
}

// ---------------------------------------------------------------- katı yardımcıları

const solidCount = (s: AnyShape | null) => (s ? s.solids.length : 0);

/** Kutunun köşegeni ve merkezi */
export function bboxInfo(s: AnyShape): { diag: number; center: Vec3; min: Vec3; max: Vec3 } {
  const [min, max] = s.boundingBox.bounds as [Vec3, Vec3];
  return { diag: vlen(sub(max, min)), center: mul(add(min, max), 0.5), min, max };
}

function fuseAll(shapes: Shape3D[]): Shape3D {
  let acc = shapes[0];
  for (let i = 1; i < shapes.length; i++) acc = acc.fuse(shapes[i]);
  return acc;
}

/**
 * Katıları tek şekle toplar (bileşik). replicad makeCompound verilen şekilleri siler; girdiler sonra da
 * kullanıldığı için (katı listesi) hafif kopyaları verilir.
 */
function compoundOf(shapes: Shape3D[]): Shape3D {
  return shapes.length === 1 ? shapes[0] : (makeCompound(shapes.map((s) => s.clone())) as Shape3D);
}

// ---------------------------------------------------------------- kenar imzaları

/** B-rep kenarının geometrik imzası (gövde-yerel) */
export function edgeSig(e: Edge): EdgeSig {
  const mid = e.pointAt(0.5).toTuple() as Vec3;
  const length = e.length;
  const t = e.geomType;
  if (t === 'LINE') {
    const a = e.startPoint.toTuple() as Vec3;
    const b = e.endPoint.toTuple() as Vec3;
    return { kind: 'line', mid, length, dir: unit(sub(b, a)) };
  }
  if (t === 'CIRCLE') {
    try {
      // BRepAdaptor_Curve.Circle() → gp_Circ
      const ad = (e as unknown as { curve: { wrapped: { Circle(): GpCirc } } }).curve.wrapped;
      const c = ad.Circle();
      const loc = c.Location();
      const ax = c.Axis().Direction();
      return {
        kind: 'circle',
        mid,
        length,
        center: [loc.X(), loc.Y(), loc.Z()],
        axis: unit([ax.X(), ax.Y(), ax.Z()]),
        radius: c.Radius(),
      };
    } catch {
      return { kind: 'other', mid, length };
    }
  }
  return { kind: 'other', mid, length };
}

interface GpXYZ {
  X(): number;
  Y(): number;
  Z(): number;
}
interface GpCirc {
  Location(): GpXYZ;
  Axis(): { Direction(): GpXYZ };
  Radius(): number;
}

/** sig ile aday imza arasındaki uzaklık puanı (uyumsuzsa Infinity) */
function sigScore(a: EdgeSig, b: EdgeSig, tol: number, loose: number): number {
  if (a.kind !== b.kind) return Infinity;
  const dm = vlen(sub(a.mid, b.mid));
  if (a.kind === 'line') {
    if (!a.dir || !b.dir || Math.abs(dot(a.dir, b.dir)) < 0.999) return Infinity;
    if (dm > loose) return Infinity;
    return dm + 0.25 * Math.abs(a.length - b.length);
  }
  if (a.kind === 'circle') {
    if (!a.axis || !b.axis || !a.center || !b.center || a.radius == null || b.radius == null) return Infinity;
    if (Math.abs(dot(a.axis, b.axis)) < 0.999) return Infinity;
    const dc = vlen(sub(a.center, b.center));
    const dr = Math.abs(a.radius - b.radius);
    if (dc > loose || dr > Math.max(loose * 0.5, tol)) return Infinity;
    return dc + dr + 0.5 * dm + 0.1 * Math.abs(a.length - b.length);
  }
  if (dm > loose) return Infinity;
  return dm + 0.25 * Math.abs(a.length - b.length);
}

/** İmzalara karşılık gelen kenarları bulur. missing = eşleşmeyen imza sayısı */
export function matchEdges(shape: Shape3D, sigs: EdgeSig[]): { edges: Edge[]; missing: number } {
  const edges = shape.edges;
  const cand = edges.map((e) => edgeSig(e));
  const { diag } = bboxInfo(shape);
  const tol = Math.max(1e-4, diag * 1e-5);
  const loose = Math.max(tol * 10, diag * 0.05);
  const picked = new Set<number>();
  const findBest = (s: EdgeSig, lim: number) => {
    let best = -1;
    let bestScore = Infinity;
    cand.forEach((c, i) => {
      if (picked.has(i)) return;
      const sc = sigScore(s, c, tol, lim);
      if (sc < bestScore) {
        bestScore = sc;
        best = i;
      }
    });
    return best;
  };
  // 1. geçiş: sıkı eşleşme. 2. geçiş (kalanlar): parametrik değişikliğe dayanıklı geniş arama
  // (ör. yüksekliği değişen gövdenin üst kenarları) — tür ve yön yine aynı olmalı.
  const rest: EdgeSig[] = [];
  for (const s of sigs) {
    const best = findBest(s, loose);
    if (best < 0) rest.push(s);
    else picked.add(best);
  }
  let missing = 0;
  for (const s of rest) {
    const best = findBest(s, Math.max(loose, diag * 0.5));
    if (best < 0) missing++;
    else picked.add(best);
  }
  return { edges: [...picked].map((i) => edges[i]), missing };
}

// ---------------------------------------------------------------- üretim durumu

/** Desen/aynada yeniden uygulanacak "araç" katısı */
interface Tool {
  op: BoolOp;
  shape: Shape3D;
}

/** Gövdenin bir katısı. key: katıyı ilk üreten özellik (+ bölünmede ek); montajda parça kimliği */
export interface KeyedSolid {
  key: string;
  shape: Shape3D;
}

interface State {
  /** Ayrı katılar (oluşma sırasıyla; ilk katı gövdenin asıl parçası) */
  solids: KeyedSolid[];
  sketches: Map<string, SketchFeature>;
  /** featureId → araç katıları (desen/ayna için) */
  tools: Map<string, Tool[]>;
  suppressedSketches: Set<string>;
}

export interface ShapeBuildResult {
  /** Tüm katılar tek şekil (bileşik); katı yoksa null */
  shape: Shape3D | null;
  solids: KeyedSolid[];
  featureErrors: Record<string, string>;
}

/** Tüm katılar tek şekil (ölçü / kenar arama için); katı yoksa null */
function whole(st: State): Shape3D | null {
  return st.solids.length ? compoundOf(st.solids.map((s) => s.shape)) : null;
}

/** Gövdenin o anki ölçeğine göre "tüm gövde boyunca" uzunluğu */
function throughLength(st: State, f: Frame, fallback: number): number {
  const w = whole(st);
  if (!w) return Math.max(fallback * 4, 1000);
  const { diag, center } = bboxInfo(w);
  return 2 * (diag + vlen(sub(center, f.o))) + 10;
}

/** Kutuları (küçük payla) kesişiyor mu: boolean denemesinden önce hızlı eleme */
function boxesTouch(a: Shape3D, b: Shape3D): boolean {
  const [amin, amax] = a.boundingBox.bounds as [Vec3, Vec3];
  const [bmin, bmax] = b.boundingBox.bounds as [Vec3, Vec3];
  const tol = 1e-6 + 1e-6 * Math.max(vlen(sub(amax, amin)), vlen(sub(bmax, bmin)));
  for (let i = 0; i < 3; i++) if (amin[i] > bmax[i] + tol || bmin[i] > amax[i] + tol) return false;
  return true;
}

const piecesOf = (s: AnyShape): Shape3D[] => s.solids as unknown as Shape3D[];

/**
 * Araç katısını gövdeye uygular. add + merge: dokunduğu katılarla birleşir (birleşen katı en eski katının
 * anahtarını ve sırasını alır); add + !merge ya da hiçbir katıya dokunmayan parça: yeni katı (anahtar = key).
 * cut: her katıdan çıkarılır; ikiye bölünen katının ek parçaları "anahtar~n" alır.
 */
function applyOp(st: State, op: BoolOp, tool: Shape3D, key: string, merge = true) {
  const pieces = piecesOf(tool);
  if (op === 'add') {
    if (!pieces.length) throw new FeatureError('Birleştirme başarısız');
    let list = [...st.solids];
    pieces.forEach((piece, i) => {
      const k = i ? `${key}#${i}` : key;
      if (!merge) {
        list.push({ key: k, shape: piece });
        return;
      }
      let acc: Shape3D = piece;
      let at = -1;
      let accKey = k;
      const rest: KeyedSolid[] = [];
      for (const s of list) {
        if (!boxesTouch(acc, s.shape)) {
          rest.push(s);
          continue;
        }
        let r: Shape3D;
        try {
          r = acc.fuse(s.shape);
        } catch (e) {
          throw new FeatureError(errText(e, 'Birleştirme başarısız'));
        }
        if (solidCount(r) === 1) {
          acc = r;
          if (at < 0) {
            at = rest.length;
            accKey = s.key;
          }
        } else rest.push(s);
      }
      if (at < 0) rest.push({ key: accKey, shape: acc });
      else rest.splice(at, 0, { key: accKey, shape: acc });
      list = rest;
    });
    st.solids = list;
  } else {
    if (!st.solids.length) throw new FeatureError('Kesilecek katı yok');
    const out: KeyedSolid[] = [];
    for (const s of st.solids) {
      if (!boxesTouch(s.shape, tool)) {
        out.push(s);
        continue;
      }
      const r = s.shape.cut(tool);
      piecesOf(r).forEach((p, j) => out.push({ key: j ? `${s.key}~${j}` : s.key, shape: p }));
    }
    st.solids = out;
  }
}

function sketchOf(st: State, id: string): SketchFeature {
  const sk = st.sketches.get(id);
  if (sk) return sk;
  if (st.suppressedSketches.has(id)) throw new FeatureError('Sketch bastırılmış');
  throw new FeatureError('Sketch bulunamadı');
}

function profileFaces(sk: SketchFeature, profilePoints: Vec2[]): { frame: Frame; faces: Face[]; regions: Region[] } {
  const regions = selectRegions(findRegions(sk.entities), profilePoints);
  if (!regions.length) throw new FeatureError('Kapalı profil bulunamadı');
  const frame = frameOf(sk.plane);
  const faces: Face[] = [];
  for (const r of regions) {
    try {
      faces.push(regionFace(frame, r));
    } catch (e) {
      throw new FeatureError(errText(e, 'Profil yüzeyi oluşturulamadı'));
    }
  }
  return { frame, faces, regions };
}

function regionsExtent(regions: Region[]): number {
  let m = 1;
  for (const r of regions) for (const s of r.outer.segs) {
    const pts = s.kind === 'circle' ? [[s.c[0] + s.r, s.c[1] + s.r]] : [s.a, s.b];
    for (const p of pts) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
  }
  return m;
}

// ---------------------------------------------------------------- özellikler

function doExtrude(st: State, ft: ExtrudeFeature) {
  const sk = sketchOf(st, ft.sketchId);
  const { frame, faces, regions } = profileFaces(sk, ft.profilePoints);
  let s0: number;
  let s1: number;
  const sign = ft.reverse ? -1 : 1;
  if (ft.throughAll) {
    const L = throughLength(st, frame, regionsExtent(regions));
    if (ft.extent === 'oneSide') [s0, s1] = sign > 0 ? [0, L] : [-L, 0];
    else [s0, s1] = [-L, L];
  } else {
    const d = ft.distance;
    if (ft.extent === 'symmetric') {
      if (!(d > 0)) throw new FeatureError('Mesafe sıfırdan büyük olmalı');
      [s0, s1] = [-d / 2, d / 2];
    } else if (ft.extent === 'twoSides') {
      const d2 = ft.distance2;
      if (!(d + d2 > 0) || d < 0 || d2 < 0) throw new FeatureError('Mesafeler geçersiz');
      [s0, s1] = sign > 0 ? [-d2, d] : [-d, d2];
    } else {
      if (!(d > 0)) throw new FeatureError('Mesafe sıfırdan büyük olmalı');
      [s0, s1] = sign > 0 ? [0, d] : [-d, 0];
    }
  }
  const solids: Shape3D[] = [];
  for (const face of faces) {
    const base = s0 !== 0 ? face.translate(mul(frame.n, s0)) : face;
    solids.push(basicFaceExtrusion(base, new Vector(mul(frame.n, s1 - s0))));
  }
  const tool = solids.length === 1 ? solids[0] : fuseAll(solids);
  applyOp(st, ft.operation, tool, ft.id, ft.merge !== false);
  st.tools.set(ft.id, [{ op: ft.operation, shape: tool }]);
}

function doRevolve(st: State, ft: RevolveFeature) {
  const sk = sketchOf(st, ft.sketchId);
  const axisEnt = sk.entities.find((e) => e.id === ft.axisLineId);
  if (!axisEnt || axisEnt.kind !== 'line') throw new FeatureError('Dönme ekseni bulunamadı');
  const pt = (id: string) => {
    const p = sk.entities.find((e) => e.id === id);
    if (!p || p.kind !== 'point') throw new FeatureError('Dönme ekseni bulunamadı');
    return [p.x, p.y] as Vec2;
  };
  const { frame, faces } = profileFaces(sk, ft.profilePoints);
  const a = to3(frame, pt(axisEnt.p1));
  const b = to3(frame, pt(axisEnt.p2));
  if (vlen(sub(b, a)) < 1e-9) throw new FeatureError('Dönme ekseni geçersiz');
  const angle = Math.min(Math.max(ft.angle, 0), 360);
  if (!(angle > 0)) throw new FeatureError('Açı sıfırdan büyük olmalı');
  const dir = mul(unit(sub(b, a)), ft.reverse ? -1 : 1);
  const solids: Shape3D[] = [];
  for (const face of faces) {
    try {
      solids.push(revolution(face, a, dir, angle));
    } catch (e) {
      throw new FeatureError(errText(e, 'Döndürme başarısız (profil ekseni kesiyor olabilir)'));
    }
  }
  const tool = solids.length === 1 ? solids[0] : fuseAll(solids);
  if (!solidCount(tool)) throw new FeatureError('Döndürme katı üretmedi (profil ekseni kesiyor olabilir)');
  applyOp(st, ft.operation, tool, ft.id, ft.merge !== false);
  st.tools.set(ft.id, [{ op: ft.operation, shape: tool }]);
}

function doFilletChamfer(st: State, ft: FilletFeature | ChamferFeature): string | null {
  const all = whole(st);
  if (!all) throw new FeatureError('Katı yok');
  if (!ft.edges.length) throw new FeatureError('Kenar seçilmedi');
  const value = ft.type === 'fillet' ? ft.radius : ft.distance;
  if (!(value > 0)) throw new FeatureError(ft.type === 'fillet' ? 'Yarıçap sıfırdan büyük olmalı' : 'Mesafe sıfırdan büyük olmalı');
  const { edges, missing } = matchEdges(all, ft.edges);
  if (!edges.length) throw new FeatureError('Seçilen kenarlar bulunamadı');
  // Her katıya yalnız kendi kenarları uygulanır (katılar ayrı kalır)
  let used = 0;
  const out: KeyedSolid[] = [];
  for (const s of st.solids) {
    const own = s.shape.edges;
    const mine = edges.filter((e) => own.some((o) => o.isSame(e)));
    if (!mine.length) {
      out.push(s);
      continue;
    }
    const r = filletSolid(s.shape, mine, ft.type, value);
    out.push({ key: s.key, shape: r.shape });
    used += r.used;
  }
  st.solids = out;
  const skipped = edges.length - used;
  if (missing || skipped) {
    const parts = [missing ? `${missing} kenar bulunamadı` : '', skipped ? `${skipped} kenara uygulanamadı` : ''].filter(Boolean);
    return `Uyarı: ${parts.join(', ')}; ${used} kenara uygulandı`;
  }
  return null;
}

/** Tek katıya radyus/pah; uygulanamayan kenarlar atlanır (hiçbiri olmazsa hata) */
function filletSolid(base: Shape3D, edges: Edge[], type: 'fillet' | 'chamfer', value: number): { shape: Shape3D; used: number } {
  const ft = { type };
  const apply = (list: Edge[]): Shape3D | null => {
    const set = new Set(list.map((e) => e.hashCode));
    const pick = (e: Edge) => (set.has(e.hashCode) && list.some((x) => x.isSame(e)) ? value : null);
    try {
      const out = ft.type === 'fillet' ? base.fillet(pick) : base.chamfer(pick);
      return solidCount(out) ? out : null;
    } catch {
      return null;
    }
  };
  let used = edges;
  let r = apply(edges);
  if (!r && edges.length > 1) {
    // Bazı kenarlar uygulanamıyor olabilir (ör. silindir dikiş kenarı): tek tek dene, uygulananlarla tekrar
    const ok = edges.filter((e) => apply([e]) !== null);
    if (ok.length) {
      r = apply(ok);
      used = ok;
    }
  }
  if (!r) {
    throw new FeatureError(
      ft.type === 'fillet' ? 'Radyus uygulanamadı (yarıçap çok büyük olabilir)' : 'Pah uygulanamadı (mesafe çok büyük olabilir)',
    );
  }
  return { shape: r, used: used.length };
}


// ---------------------------------------------------------------- süpür

/** Yol parçası (sketch-2B, gidiş yönünde): çizgi, yay (ccw = gidiş saat yönü tersi) ya da tam daire */
type PathSeg =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; a: Vec2; b: Vec2; ccw: boolean }
  | { kind: 'circle'; c: Vec2; r: number };

const d2 = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Yol sketch'inin yardımcı olmayan eğrilerini tek zincire dizer (uçlar konumla eşleşir) */
export function pathChain(sk: SketchFeature): { segs: PathSeg[]; closed: boolean } {
  const pts = new Map<string, Vec2>();
  for (const e of sk.entities) if (e.kind === 'point') pts.set(e.id, [e.x, e.y]);
  const P = (id: string) => {
    const p = pts.get(id);
    if (!p) throw new FeatureError('Yol noktası bulunamadı');
    return p;
  };
  const raw: PathSeg[] = [];
  for (const e of sk.entities) {
    if (e.kind === 'point' || e.construction) continue;
    if (e.kind === 'line') raw.push({ kind: 'line', a: P(e.p1), b: P(e.p2) });
    else if (e.kind === 'arc') raw.push({ kind: 'arc', c: P(e.c), r: e.r, a: P(e.start), b: P(e.end), ccw: true });
    else raw.push({ kind: 'circle', c: P(e.c), r: e.r });
  }
  if (!raw.length) throw new FeatureError('Yol sketch\'inde çizgi/yay yok');
  const circles = raw.filter((s) => s.kind === 'circle');
  if (circles.length) {
    if (raw.length > 1) throw new FeatureError('Yol tek bir zincir olmalı (daire tek başına yol olabilir)');
    return { segs: circles, closed: true };
  }
  const open = raw as Exclude<PathSeg, { kind: 'circle' }>[];
  let ext = 1;
  for (const s of open) ext = Math.max(ext, Math.abs(s.a[0]), Math.abs(s.a[1]), Math.abs(s.b[0]), Math.abs(s.b[1]));
  const tol = Math.max(1e-6, ext * 1e-7);
  const deg = (p: Vec2) => open.reduce((n, s) => n + (d2(s.a, p) <= tol ? 1 : 0) + (d2(s.b, p) <= tol ? 1 : 0), 0);
  for (const s of open) if (deg(s.a) > 2 || deg(s.b) > 2) throw new FeatureError('Yol dallanıyor: tek bir zincir olmalı');
  // Açık zincirde tek dereceli uçtan başla
  const startSeg = open.find((s) => deg(s.a) === 1) ?? open.find((s) => deg(s.b) === 1);
  const used = new Set<number>();
  const segs: PathSeg[] = [];
  const flip = (s: Exclude<PathSeg, { kind: 'circle' }>): Exclude<PathSeg, { kind: 'circle' }> =>
    s.kind === 'line' ? { kind: 'line', a: s.b, b: s.a } : { ...s, a: s.b, b: s.a, ccw: !s.ccw };
  let first = startSeg ?? open[0];
  if (startSeg && deg(startSeg.a) !== 1) first = flip(startSeg);
  used.add(open.indexOf(startSeg ?? open[0]));
  segs.push(first);
  let cur = first.b;
  for (;;) {
    const i = open.findIndex((s, k) => !used.has(k) && (d2(s.a, cur) <= tol || d2(s.b, cur) <= tol));
    if (i < 0) break;
    used.add(i);
    const s = d2(open[i].a, cur) <= tol ? open[i] : flip(open[i]);
    segs.push(s);
    cur = (s as { b: Vec2 }).b;
  }
  if (used.size !== open.length) throw new FeatureError('Yol tek bir zincir olmalı (kopuk parçalar var)');
  const closed = segs.length > 1 && d2((segs[0] as { a: Vec2 }).a, cur) <= tol;
  return { segs, closed };
}

const arcAng = (c: Vec2, p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** Yay gidiş yönünde orta açı */
function arcMidAngle(s: { c: Vec2; a: Vec2; b: Vec2; ccw: boolean }): number {
  const a0 = arcAng(s.c, s.a);
  let sw = arcAng(s.c, s.b) - a0;
  if (s.ccw) {
    while (sw <= 1e-12) sw += Math.PI * 2;
  } else {
    while (sw >= -1e-12) sw -= Math.PI * 2;
  }
  return a0 + sw / 2;
}

/** Kapalı yolu ilk kenarın ortasından başlatır (profil bir köşeye denk gelmesin; tüm köşeler gönyelenir) */
function startAtMid(segs: PathSeg[]): PathSeg[] {
  const s = segs[0];
  if (s.kind === 'circle') return segs;
  let m: Vec2;
  if (s.kind === 'line') m = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
  else {
    const t = arcMidAngle(s);
    m = [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
  }
  const head = { ...s, a: m } as PathSeg;
  const tail = { ...s, b: m } as PathSeg;
  return [head, ...segs.slice(1), tail];
}

/** Yolun başlangıç noktası ve teğeti (sketch-2B) */
function pathStart(s: PathSeg): { p: Vec2; t: Vec2 } {
  if (s.kind === 'circle') return { p: [s.c[0] + s.r, s.c[1]], t: [0, 1] };
  if (s.kind === 'line') {
    const l = d2(s.a, s.b) || 1;
    return { p: s.a, t: [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l] };
  }
  const r = d2(s.a, s.c) || 1;
  const u: Vec2 = [(s.a[0] - s.c[0]) / r, (s.a[1] - s.c[1]) / r];
  return { p: s.a, t: s.ccw ? [-u[1], u[0]] : [u[1], -u[0]] };
}

function pathEdge(f: Frame, s: PathSeg): Edge {
  if (s.kind === 'line') return makeLine(to3(f, s.a), to3(f, s.b));
  if (s.kind === 'circle') return makeCircle(s.r, to3(f, s.c), f.n);
  const t = arcMidAngle(s);
  return makeThreePointArc(to3(f, s.a), to3(f, [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]), to3(f, s.b));
}

function doSweep(st: State, ft: SweepFeature) {
  const prof = sketchOf(st, ft.sketchId);
  if (!ft.pathSketchId) throw new FeatureError('Yol sketch\'i seçilmedi');
  if (ft.pathSketchId === ft.sketchId) throw new FeatureError('Profil ve yol ayrı sketch\'lerde olmalı');
  const pathSk = sketchOf(st, ft.pathSketchId);
  const regions = selectRegions(findRegions(prof.entities), ft.profilePoints);
  if (!regions.length) throw new FeatureError('Profil sketch\'inde kapalı bölge bulunamadı');
  const pf = frameOf(pathSk.plane);
  let { segs, closed } = pathChain(pathSk);
  if (closed && ft.placement === 'auto') segs = startAtMid(segs);
  let spine: Wire;
  try {
    spine = assembleWire(segs.map((s) => pathEdge(pf, s)));
  } catch (e) {
    throw new FeatureError(errText(e, 'Yol oluşturulamadı'));
  }
  // Profil çerçevesi: auto → yolun başında, yola dik
  let frame = frameOf(prof.plane);
  if (ft.placement === 'auto') {
    const { p, t } = pathStart(segs[0]);
    const n = unit(add(mul(pf.x, t[0]), mul(pf.y, t[1])));
    const o = to3(pf, p);
    // x = yol düzleminin normali, y = n × x (yolun sağı); rotate ile n etrafında döner
    const ang = ((ft.rotate || 0) * Math.PI) / 180;
    const x0 = pf.n;
    const y0 = cross(n, x0);
    let x = add(mul(x0, Math.cos(ang)), mul(y0, Math.sin(ang)));
    let nn = n;
    // Ayna: x ve n birlikte ters (sağ el kuralı korunur, y aynı kalır)
    if (ft.flip) {
      x = mul(x, -1);
      nn = mul(n, -1);
    }
    frame = { o, x, y: cross(nn, x), n: nn };
  }
  const mode = ft.corner === 'round' ? 'round' : 'right';
  const sweepWire = (w: Wire): Shape3D => {
    let r: Shape3D;
    try {
      r = genericSweep(w, spine, { transitionMode: mode, forceProfileSpineOthogonality: ft.placement === 'auto' }) as Shape3D;
    } catch (e) {
      throw new FeatureError(errText(e, 'Süpürme başarısız (profil yola dik ve yolun başında olmalı)'));
    }
    if (!solidCount(r)) throw new FeatureError('Süpürme katı üretmedi (profil yola dik ve yolun başında olmalı)');
    return r;
  };
  // Her döngü saat yönü tersine (ccw) süpürülür: delik döngüleri (cw) ters katı vermesin
  const ccw = (l: Loop) => (l.area < 0 ? reverseLoop(l) : l);
  const solids: Shape3D[] = [];
  for (const rg of regions) {
    let s = sweepWire(loopWire(frame, ccw(rg.outer)));
    if (rg.holes.length) {
      const holes = rg.holes.map((h) => sweepWire(loopWire(frame, ccw(h))));
      s = s.cut(compoundOf(holes));
      if (!solidCount(s)) throw new FeatureError('Profil boşlukları süpürülemedi');
    }
    solids.push(s);
  }
  const tool = solids.length === 1 ? solids[0] : fuseAll(solids);
  if (!solidCount(tool)) throw new FeatureError('Süpürme katı üretmedi');
  applyOp(st, ft.operation, tool, ft.id, ft.merge !== false);
  st.tools.set(ft.id, [{ op: ft.operation, shape: tool }]);
}

function doHole(st: State, ft: HoleFeature) {
  const all = whole(st);
  if (!all) throw new FeatureError('Kesilecek katı yok');
  if (!ft.points.length) throw new FeatureError('Delik merkezi seçilmedi');
  if (!(ft.diameter > 0)) throw new FeatureError('Çap sıfırdan büyük olmalı');
  const frame = frameOf(ft.plane);
  const r = ft.diameter / 2;
  const depth = ft.throughAll ? throughLength(st, frame, r) : ft.depth;
  if (!(depth > 0)) throw new FeatureError('Derinlik sıfırdan büyük olmalı');
  const { diag } = bboxInfo(all);
  // Yüzeyin biraz üstünden başla (çakışık yüz sorunlarını önler)
  const ext = Math.max(0.01, diag * 1e-4);

  // Profil (eksen = z, yarıçap = ρ): yüzeyden aşağı kademeli çokgen
  const prof: [number, number][] = []; // [ρ, z] z ≤ ext
  if (ft.holeType === 'counterbore') {
    const R = ft.cbDiameter / 2;
    if (!(R > r)) throw new FeatureError('Havşa başı çapı delik çapından büyük olmalı');
    if (!(ft.cbDepth > 0)) throw new FeatureError('Havşa başı derinliği sıfırdan büyük olmalı');
    prof.push([0, ext], [R, ext], [R, -ft.cbDepth], [r, -ft.cbDepth], [r, -depth], [0, -depth]);
  } else if (ft.holeType === 'countersink') {
    const R = ft.csDiameter / 2;
    if (!(R > r)) throw new FeatureError('Havşa çapı delik çapından büyük olmalı');
    const half = ((ft.csAngle > 0 && ft.csAngle < 180 ? ft.csAngle : 90) * Math.PI) / 360;
    const hc = (R - r) / Math.tan(half);
    const Rt = R + ext * Math.tan(half);
    if (hc >= depth) prof.push([0, ext], [Rt, ext], [R - depth * Math.tan(half), -depth], [0, -depth]);
    else prof.push([0, ext], [Rt, ext], [r, -hc], [r, -depth], [0, -depth]);
  } else {
    prof.push([0, ext], [r, ext], [r, -depth], [0, -depth]);
  }

  const tools: Shape3D[] = [];
  for (const p2 of ft.points) {
    const c = to3(frame, p2);
    const pts = prof.map(([rho, z]) => add(c, add(mul(frame.x, rho), mul(frame.n, z))));
    const face = makePolygon(pts);
    tools.push(revolution(face, c, frame.n, 360));
  }
  const tool = compoundOf(tools);
  applyOp(st, 'cut', tool, ft.id);
  st.tools.set(ft.id, [{ op: 'cut', shape: tool }]);
}

function patternSources(st: State, ids: string[]): Tool[] {
  if (!ids.length) throw new FeatureError('Desenlenecek özellik seçilmedi');
  const out: Tool[] = [];
  for (const id of ids) {
    const t = st.tools.get(id);
    if (!t) throw new FeatureError('Desenlenecek özellik bulunamadı ya da desenlenemez');
    out.push(...t);
  }
  return out;
}

/** Araçların dönüştürülmüş kopyalarını uygular; kopyaları da araç olarak kaydeder */
function applyCopies(st: State, id: string, src: Tool[], xforms: ((s: Shape3D) => Shape3D)[]) {
  const made: Tool[] = [];
  for (const op of ['add', 'cut'] as const) {
    const group = src.filter((t) => t.op === op);
    if (!group.length) continue;
    const copies: Shape3D[] = [];
    for (const xf of xforms) for (const t of group) copies.push(xf(t.shape.clone()));
    if (!copies.length) continue;
    const tool = compoundOf(copies);
    applyOp(st, op, tool, id);
    made.push({ op, shape: tool });
  }
  st.tools.set(id, made);
}

function doLinearPattern(st: State, ft: LinearPatternFeature) {
  const src = patternSources(st, ft.featureIds);
  const n1 = Math.max(1, Math.floor(ft.count1));
  const n2 = ft.count2 > 1 ? Math.floor(ft.count2) : 1;
  const d1 = unit(ft.dir1);
  const d2 = unit(ft.dir2);
  const xforms: ((s: Shape3D) => Shape3D)[] = [];
  for (let i = 0; i < n1; i++)
    for (let j = 0; j < n2; j++) {
      if (i === 0 && j === 0) continue;
      const v = add(mul(d1, i * ft.spacing1), mul(d2, j * ft.spacing2));
      xforms.push((s) => s.translate(v));
    }
  if (!xforms.length) throw new FeatureError('Kopya sayısı en az 2 olmalı');
  applyCopies(st, ft.id, src, xforms);
}

function doCircularPattern(st: State, ft: CircularPatternFeature) {
  const src = patternSources(st, ft.featureIds);
  const n = Math.floor(ft.count);
  if (n < 2) throw new FeatureError('Kopya sayısı en az 2 olmalı');
  const full = Math.abs(Math.abs(ft.angle) - 360) < 1e-9;
  const step = full ? 360 / n : ft.angle / (n - 1);
  const axis = unit(ft.axisDir);
  const xforms: ((s: Shape3D) => Shape3D)[] = [];
  for (let i = 1; i < n; i++) xforms.push((s) => s.rotate(step * i, ft.axisOrigin, axis));
  applyCopies(st, ft.id, src, xforms);
}

function doMirror(st: State, ft: MirrorFeature) {
  const frame = frameOf(ft.plane);
  const mir = (s: Shape3D) => s.mirror(frame.n, frame.o);
  if (!ft.featureIds.length) {
    const all = whole(st);
    if (!all) throw new FeatureError('Aynalanacak katı yok');
    const m = mir(all.clone());
    applyOp(st, 'add', m, ft.id);
    st.tools.set(ft.id, [{ op: 'add', shape: m }]);
    return;
  }
  applyCopies(st, ft.id, patternSources(st, ft.featureIds), [mir]);
}

const FAIL_TEXT: Record<Feature['type'], string> = {
  sketch: 'Sketch işlenemedi',
  extrude: 'Ekstrüzyon başarısız',
  revolve: 'Döndürme başarısız',
  sweep: 'Süpürme başarısız',
  fillet: 'Radyus başarısız',
  chamfer: 'Pah başarısız',
  hole: 'Delik açılamadı',
  linearPattern: 'Doğrusal desen başarısız',
  circularPattern: 'Dairesel desen başarısız',
  mirror: 'Aynalama başarısız',
};

/** Özellik geçmişinden katı üretir (mesh'siz) */
export function buildShape(body: Body): ShapeBuildResult {
  const st: State = { solids: [], sketches: new Map(), tools: new Map(), suppressedSketches: new Set() };
  const featureErrors: Record<string, string> = {};
  for (const ft of body.features) {
    if (ft.suppressed) {
      if (ft.type === 'sketch') st.suppressedSketches.add(ft.id);
      continue;
    }
    const before = st.solids;
    try {
      switch (ft.type) {
        case 'sketch':
          st.sketches.set(ft.id, ft);
          break;
        case 'extrude':
          doExtrude(st, ft);
          break;
        case 'revolve':
          doRevolve(st, ft);
          break;
        case 'sweep':
          doSweep(st, ft);
          break;
        case 'fillet':
        case 'chamfer': {
          const warn = doFilletChamfer(st, ft);
          if (warn) featureErrors[ft.id] = warn;
          break;
        }
        case 'hole':
          doHole(st, ft);
          break;
        case 'linearPattern':
          doLinearPattern(st, ft);
          break;
        case 'circularPattern':
          doCircularPattern(st, ft);
          break;
        case 'mirror':
          doMirror(st, ft);
          break;
        default:
          throw new FeatureError('Bilinmeyen özellik türü');
      }
    } catch (e) {
      st.solids = before;
      featureErrors[ft.id] = errText(e, FAIL_TEXT[(ft as Feature).type] ?? 'Özellik başarısız');
    }
  }
  const solids = st.solids.filter((s) => solidCount(s.shape));
  return { shape: solids.length ? compoundOf(solids.map((s) => s.shape)) : null, solids, featureErrors };
}

export { measureVolume };
