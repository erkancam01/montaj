// Gövde üretimi: özellik geçmişini replicad (OpenCascade) ile katıya çevirir.
// Worker'dan bağımsızdır (Node testlerinde de çalışır); setOC() önceden çağrılmış olmalıdır.
import {
  addHolesInFace,
  assembleWire,
  basicFaceExtrusion,
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
import { arcMid, findRegions, selectRegions, type Loop, type Region, type Seg } from '../sketch/profiles';
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
  Vec2,
  Vec3,
} from '../types';

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

/** Araç katılarını tek şekle toplar (bileşik) */
function compoundOf(shapes: Shape3D[]): Shape3D {
  return shapes.length === 1 ? shapes[0] : (makeCompound(shapes) as Shape3D);
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

interface State {
  shape: Shape3D | null;
  sketches: Map<string, SketchFeature>;
  /** featureId → araç katıları (desen/ayna için) */
  tools: Map<string, Tool[]>;
  suppressedSketches: Set<string>;
}

export interface ShapeBuildResult {
  shape: Shape3D | null;
  featureErrors: Record<string, string>;
}

/** Gövdenin o anki ölçeğine göre "tüm gövde boyunca" uzunluğu */
function throughLength(st: State, f: Frame, fallback: number): number {
  if (!st.shape || !solidCount(st.shape)) return Math.max(fallback * 4, 1000);
  const { diag, center } = bboxInfo(st.shape);
  return 2 * (diag + vlen(sub(center, f.o))) + 10;
}

function applyOp(st: State, op: BoolOp, tool: Shape3D) {
  if (op === 'add') {
    if (!st.shape || !solidCount(st.shape)) {
      st.shape = tool.clone();
      return;
    }
    const r = st.shape.fuse(tool);
    if (!solidCount(r)) throw new FeatureError('Birleştirme başarısız');
    st.shape = r;
  } else {
    if (!st.shape || !solidCount(st.shape)) throw new FeatureError('Kesilecek katı yok');
    const r = st.shape.cut(tool);
    st.shape = solidCount(r) ? r : null;
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
  applyOp(st, ft.operation, tool);
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
  applyOp(st, ft.operation, tool);
  st.tools.set(ft.id, [{ op: ft.operation, shape: tool }]);
}

function doFilletChamfer(st: State, ft: FilletFeature | ChamferFeature): string | null {
  if (!st.shape || !solidCount(st.shape)) throw new FeatureError('Katı yok');
  if (!ft.edges.length) throw new FeatureError('Kenar seçilmedi');
  const value = ft.type === 'fillet' ? ft.radius : ft.distance;
  if (!(value > 0)) throw new FeatureError(ft.type === 'fillet' ? 'Yarıçap sıfırdan büyük olmalı' : 'Mesafe sıfırdan büyük olmalı');
  const { edges, missing } = matchEdges(st.shape, ft.edges);
  if (!edges.length) throw new FeatureError('Seçilen kenarlar bulunamadı');
  const base = st.shape;
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
  st.shape = r;
  const skipped = edges.length - used.length;
  if (missing || skipped) {
    const parts = [missing ? `${missing} kenar bulunamadı` : '', skipped ? `${skipped} kenara uygulanamadı` : ''].filter(Boolean);
    return `Uyarı: ${parts.join(', ')}; ${used.length} kenara uygulandı`;
  }
  return null;
}

function doHole(st: State, ft: HoleFeature) {
  if (!st.shape || !solidCount(st.shape)) throw new FeatureError('Kesilecek katı yok');
  if (!ft.points.length) throw new FeatureError('Delik merkezi seçilmedi');
  if (!(ft.diameter > 0)) throw new FeatureError('Çap sıfırdan büyük olmalı');
  const frame = frameOf(ft.plane);
  const r = ft.diameter / 2;
  const depth = ft.throughAll ? throughLength(st, frame, r) : ft.depth;
  if (!(depth > 0)) throw new FeatureError('Derinlik sıfırdan büyük olmalı');
  const { diag } = bboxInfo(st.shape);
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
  applyOp(st, 'cut', tool);
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
    applyOp(st, op, tool);
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
    if (!st.shape || !solidCount(st.shape)) throw new FeatureError('Aynalanacak katı yok');
    const m = mir(st.shape.clone());
    const r = st.shape.fuse(m);
    if (!solidCount(r)) throw new FeatureError('Aynalama başarısız');
    st.shape = r;
    st.tools.set(ft.id, [{ op: 'add', shape: m }]);
    return;
  }
  applyCopies(st, ft.id, patternSources(st, ft.featureIds), [mir]);
}

const FAIL_TEXT: Record<Feature['type'], string> = {
  sketch: 'Sketch işlenemedi',
  extrude: 'Ekstrüzyon başarısız',
  revolve: 'Döndürme başarısız',
  fillet: 'Radyus başarısız',
  chamfer: 'Pah başarısız',
  hole: 'Delik açılamadı',
  linearPattern: 'Doğrusal desen başarısız',
  circularPattern: 'Dairesel desen başarısız',
  mirror: 'Aynalama başarısız',
};

/** Özellik geçmişinden katı üretir (mesh'siz) */
export function buildShape(body: Body): ShapeBuildResult {
  const st: State = { shape: null, sketches: new Map(), tools: new Map(), suppressedSketches: new Set() };
  const featureErrors: Record<string, string> = {};
  for (const ft of body.features) {
    if (ft.suppressed) {
      if (ft.type === 'sketch') st.suppressedSketches.add(ft.id);
      continue;
    }
    const before = st.shape;
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
      st.shape = before;
      featureErrors[ft.id] = errText(e, FAIL_TEXT[(ft as Feature).type] ?? 'Özellik başarısız');
    }
  }
  return { shape: st.shape && solidCount(st.shape) ? st.shape : null, featureErrors };
}

export { measureVolume };
