// Sketch profil analizi: yardımcı olmayan eğrilerden kapalı döngü/bölge bulma.
// Saf fonksiyonlar (hem ana iş parçacığında hem çekirdek worker'ında kullanılır).
//
// Yöntem: uçlar toleransla birleştirilir → düzlemsel graf (çizgi/yay kenarları) → açık uçlar budanır →
// her düğümde giden kenarlar teğet açısına göre sıralanır → yüz izleme (en keskin sola dönüş; iç sola)
// ile minimal döngüler. Pozitif alanlı döngüler sınırlı yüzlerdir; her bağlı bileşenin negatif alanlı
// döngüsü (dış sınırı) içine düştüğü yüzün deliği olur. Daireler kendi başına bileşendir.
import type { SkEntity, Vec2 } from '../types';

export type Seg =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  /** a'dan b'ye; ccw=true saat yönü tersi. a0/a1 radyan. */
  | { kind: 'arc'; c: Vec2; r: number; a0: number; a1: number; ccw: boolean; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number };

/** Kapalı döngü: parçalar uç uca sıralı (daire tek parça) */
export interface Loop {
  segs: Seg[];
  /** işaretli alan (ccw pozitif) */
  area: number;
}

/** Kapalı bölge = dış döngü eksi doğrudan içindeki döngüler */
export interface Region {
  outer: Loop;
  holes: Loop[];
  /** iç içe derinlik (0 = en dış) */
  depth: number;
  /** bölgenin içinde kalan bir nokta */
  sample: Vec2;
  /** net alan (mm²) */
  area: number;
}

const TAU = Math.PI * 2;

/** Açıyı [0, 2π) aralığına getirir */
const norm = (a: number) => {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
};

/** Yayın işaretli süpürme açısı (ccw pozitif, cw negatif); a0 = a1 ise tam tur */
export function arcSweep(s: { a0: number; a1: number; ccw: boolean }): number {
  if (s.ccw) {
    const d = norm(s.a1 - s.a0);
    return d < 1e-12 ? TAU : d;
  }
  const d = norm(s.a0 - s.a1);
  return -(d < 1e-12 ? TAU : d);
}

/** Yayın parametre ortasındaki nokta */
export function arcMid(s: { c: Vec2; r: number; a0: number; a1: number; ccw: boolean }): Vec2 {
  const m = s.a0 + arcSweep(s) / 2;
  return [s.c[0] + s.r * Math.cos(m), s.c[1] + s.r * Math.sin(m)];
}

/** Parçanın döngü alanına katkısı: ½∮(x dy − y dx) */
function segArea(s: Seg): number {
  if (s.kind === 'line') return 0.5 * (s.a[0] * s.b[1] - s.a[1] * s.b[0]);
  if (s.kind === 'circle') return Math.PI * s.r * s.r;
  const d = arcSweep(s);
  return 0.5 * (s.r * s.r * d + s.c[0] * (s.b[1] - s.a[1]) - s.c[1] * (s.b[0] - s.a[0]));
}

const loopArea = (segs: Seg[]) => segs.reduce((acc, s) => acc + segArea(s), 0);

/** p'den bakınca a→b'nin işaretli açısı */
function subtended(p: Vec2, a: Vec2, b: Vec2): number {
  const ax = a[0] - p[0];
  const ay = a[1] - p[1];
  const bx = b[0] - p[0];
  const by = b[1] - p[1];
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/** Parçanın p etrafındaki sarım açısı katkısı (radyan) */
function segWinding(s: Seg, p: Vec2): number {
  if (s.kind === 'line') return subtended(p, s.a, s.b);
  if (s.kind === 'circle') return Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) < s.r ? TAU : 0;
  // Yay ≤ 90°'lik parçalara bölünür; her parça = kiriş + (p kesme bölgesindeyse ±2π)
  const sw = arcSweep(s);
  const n = Math.max(1, Math.ceil(Math.abs(sw) / (Math.PI / 2)));
  const inCircle = Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) < s.r;
  let w = 0;
  let prev: Vec2 = s.a;
  for (let i = 1; i <= n; i++) {
    const ang = s.a0 + (sw * i) / n;
    const q: Vec2 = i === n ? s.b : [s.c[0] + s.r * Math.cos(ang), s.c[1] + s.r * Math.sin(ang)];
    w += subtended(p, prev, q);
    if (inCircle) {
      // ccw yönlü parça için kesme bölgesi kirişin sağındadır
      const [a, b] = sw > 0 ? [prev, q] : [q, prev];
      const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (cr < 0) w += sw > 0 ? TAU : -TAU;
    }
    prev = q;
  }
  return w;
}

/** Döngünün p etrafındaki sarım sayısı */
function winding(loop: Loop, p: Vec2): number {
  let w = 0;
  for (const s of loop.segs) w += segWinding(s, p);
  return Math.round(w / TAU);
}

const loopContains = (loop: Loop, p: Vec2) => winding(loop, p) !== 0;

/** Nokta bölgenin içinde mi (dış döngü içinde, deliklerin dışında) */
export function regionContains(region: Region, p: Vec2): boolean {
  if (!loopContains(region.outer, p)) return false;
  for (const h of region.holes) if (loopContains(h, p)) return false;
  return true;
}

// ---------------------------------------------------------------- yardımcılar

/** Yatay y doğrusunun parçayla kesiştiği x'ler */
function segCrossX(s: Seg, y: number, out: number[]) {
  if (s.kind === 'line') {
    const [a, b] = [s.a, s.b];
    if (a[1] > y !== b[1] > y) out.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    return;
  }
  const dy = y - s.c[1];
  if (Math.abs(dy) >= s.r) return;
  const dx = Math.sqrt(s.r * s.r - dy * dy);
  for (const x of [s.c[0] - dx, s.c[0] + dx]) {
    if (s.kind === 'circle') {
      out.push(x);
      continue;
    }
    const ang = Math.atan2(dy, x - s.c[0]);
    const sw = arcSweep(s);
    const rel = sw > 0 ? norm(ang - s.a0) : norm(s.a0 - ang);
    if (rel > 1e-12 && rel < Math.abs(sw) - 1e-12) out.push(x);
  }
}

/** Döngünün sınırlayıcı kutusu (yaylar için uç noktalar + eksen uçları) */
function loopBox(loop: Loop): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Vec2) => {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  };
  for (const s of loop.segs) {
    if (s.kind === 'line') {
      add(s.a);
      add(s.b);
    } else if (s.kind === 'circle') {
      add([s.c[0] - s.r, s.c[1] - s.r]);
      add([s.c[0] + s.r, s.c[1] + s.r]);
    } else {
      add(s.a);
      add(s.b);
      const sw = arcSweep(s);
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const rel = sw > 0 ? norm(ang - s.a0) : norm(s.a0 - ang);
        if (rel <= Math.abs(sw)) add([s.c[0] + s.r * Math.cos(ang), s.c[1] + s.r * Math.sin(ang)]);
      }
    }
  }
  return [x0, y0, x1, y1];
}

/** Bölge içinde güvenli nokta: yatay tarama çizgilerinde en geniş iç aralığın ortası */
function regionSample(outer: Loop, holes: Loop[]): Vec2 {
  const [x0, y0, x1, y1] = loopBox(outer);
  const probe: Region = { outer, holes, depth: 0, sample: [0, 0], area: 0 };
  let best: Vec2 | null = null;
  let bestW = -1;
  const N = 17;
  for (let i = 1; i <= N; i++) {
    // Düzensiz aralık: düğüm yüksekliklerine denk gelmeyi önler
    const t = (i - 0.5 + 0.123 * Math.sin(i * 7.7)) / N;
    const y = y0 + (y1 - y0) * t;
    const xs: number[] = [];
    for (const s of outer.segs) segCrossX(s, y, xs);
    for (const h of holes) for (const s of h.segs) segCrossX(s, y, xs);
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k++) {
      const w = xs[k + 1] - xs[k];
      if (w <= bestW) continue;
      const m: Vec2 = [(xs[k] + xs[k + 1]) / 2, y];
      if (regionContains(probe, m)) {
        best = m;
        bestW = w;
      }
    }
  }
  if (best) return best;
  // Yedek: ilk parçanın ortasının biraz solu (ccw döngüde iç taraf)
  const s = outer.segs[0];
  const scale = Math.max(x1 - x0, y1 - y0, 1e-9);
  if (s.kind === 'circle') return [...s.c];
  const a = s.kind === 'line' ? s.a : s.a;
  const b = s.kind === 'line' ? s.b : arcMid(s);
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / d) * scale * 1e-4, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / d) * scale * 1e-4];
}

/** Döngünün sınırı üzerinde bir nokta */
function loopPoint(loop: Loop): Vec2 {
  const s = loop.segs[0];
  if (s.kind === 'circle') return [s.c[0] + s.r * Math.cos(0.7317), s.c[1] + s.r * Math.sin(0.7317)];
  return s.kind === 'line' ? [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2] : arcMid(s);
}

/** Döngüyü ters yönde döndürür */
export function reverseLoop(loop: Loop): Loop {
  const segs: Seg[] = loop.segs
    .slice()
    .reverse()
    .map((s): Seg => {
      if (s.kind === 'line') return { kind: 'line', a: s.b, b: s.a };
      if (s.kind === 'circle') return s;
      return { ...s, a0: s.a1, a1: s.a0, ccw: !s.ccw, a: s.b, b: s.a };
    });
  return { segs, area: -loop.area };
}

// ---------------------------------------------------------------- graf

interface HalfEdge {
  from: number;
  to: number;
  /** düğümden çıkış teğet açısı */
  ang: number;
  /** sola dönüş eğriliği (eşit açıları ayırmak için) */
  curv: number;
  seg: Seg;
  twin: number;
  used: boolean;
}

/** Yardımcı (construction) olmayan eğrilerden kapalı bölgeleri bulur. */
export function findRegions(entities: SkEntity[]): Region[] {
  const pts = new Map<string, Vec2>();
  for (const e of entities) if (e.kind === 'point') pts.set(e.id, [e.x, e.y]);

  // Ölçek → birleştirme toleransı
  let ext = 0;
  for (const p of pts.values()) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
  for (const e of entities) if ((e.kind === 'circle' || e.kind === 'arc') && Number.isFinite(e.r)) ext = Math.max(ext, Math.abs(e.r));
  const tol = Math.max(1e-6 * Math.max(ext, 1), 1e-9);

  // Düğümler (toleransla birleştirilmiş uç noktalar)
  const nodes: Vec2[] = [];
  const nodeOf = (p: Vec2): number => {
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(nodes[i][0] - p[0]) <= tol && Math.abs(nodes[i][1] - p[1]) <= tol) return i;
    }
    nodes.push([p[0], p[1]]);
    return nodes.length - 1;
  };

  const circleLoops: Loop[] = [];
  const edges: { u: number; v: number; seg: Seg }[] = [];
  for (const e of entities) {
    if (e.kind === 'point' || e.construction) continue;
    if (e.kind === 'line') {
      const a = pts.get(e.p1);
      const b = pts.get(e.p2);
      if (!a || !b) continue;
      const u = nodeOf(a);
      const v = nodeOf(b);
      if (u === v) continue;
      edges.push({ u, v, seg: { kind: 'line', a: nodes[u], b: nodes[v] } });
    } else if (e.kind === 'circle') {
      const c = pts.get(e.c);
      if (!c || !(e.r > tol)) continue;
      circleLoops.push({ segs: [{ kind: 'circle', c: [c[0], c[1]], r: e.r }], area: Math.PI * e.r * e.r });
    } else {
      const c = pts.get(e.c);
      const s = pts.get(e.start);
      const t = pts.get(e.end);
      if (!c || !s || !t) continue;
      const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      if (!(r > tol)) continue;
      const u = nodeOf(s);
      const v = nodeOf(t);
      if (u === v) {
        // Başı sonuna değen yay = daire
        circleLoops.push({ segs: [{ kind: 'circle', c: [c[0], c[1]], r }], area: Math.PI * r * r });
        continue;
      }
      const a = nodes[u];
      const b = nodes[v];
      const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      const a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      edges.push({ u, v, seg: { kind: 'arc', c: [c[0], c[1]], r, a0, a1, ccw: true, a, b } });
    }
  }

  // Açık uçları buda (derece 1 düğümler)
  const alive = edges.map(() => true);
  for (;;) {
    const deg = new Array(nodes.length).fill(0);
    edges.forEach((e, i) => {
      if (!alive[i]) return;
      deg[e.u]++;
      deg[e.v]++;
    });
    let changed = false;
    edges.forEach((e, i) => {
      if (alive[i] && (deg[e.u] < 2 || deg[e.v] < 2)) {
        alive[i] = false;
        changed = true;
      }
    });
    if (!changed) break;
  }

  // Yarım kenarlar
  const he: HalfEdge[] = [];
  const out: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => {
    if (!alive[i]) return;
    const s = e.seg;
    let fwd: HalfEdge;
    let bwd: HalfEdge;
    if (s.kind === 'line') {
      const ang = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
      fwd = { from: e.u, to: e.v, ang, curv: 0, seg: s, twin: -1, used: false };
      bwd = { from: e.v, to: e.u, ang: ang + Math.PI, curv: 0, seg: { kind: 'line', a: s.b, b: s.a }, twin: -1, used: false };
    } else if (s.kind === 'arc') {
      // ccw teğet: (-(y-cy), x-cx)
      const ta = Math.atan2(s.a[0] - s.c[0], -(s.a[1] - s.c[1]));
      const tb = Math.atan2(-(s.b[0] - s.c[0]), s.b[1] - s.c[1]);
      fwd = { from: e.u, to: e.v, ang: ta, curv: 1 / s.r, seg: s, twin: -1, used: false };
      bwd = {
        from: e.v,
        to: e.u,
        ang: tb,
        curv: -1 / s.r,
        seg: { ...s, a0: s.a1, a1: s.a0, ccw: false, a: s.b, b: s.a },
        twin: -1,
        used: false,
      };
    } else return;
    fwd.ang = norm(fwd.ang);
    bwd.ang = norm(bwd.ang);
    const fi = he.length;
    he.push(fwd, bwd);
    he[fi].twin = fi + 1;
    he[fi + 1].twin = fi;
    out[e.u].push(fi);
    out[e.v].push(fi + 1);
  });
  // Açıya göre ccw sıralama; eşit açıda sağa kıvrılan önce
  for (const list of out) {
    list.sort((i, j) => {
      const d = he[i].ang - he[j].ang;
      if (Math.abs(d) > 1e-9) return d;
      return he[i].curv - he[j].curv;
    });
  }
  const posInOut = new Map<number, number>();
  out.forEach((list) => list.forEach((h, k) => posInOut.set(h, k)));

  // Yüz izleme: e(u→v) sonrası, v'de twin(e)'den hemen önceki (saat yönünde bir sonraki) kenar
  const comp = new Array(nodes.length).fill(-1);
  const faceLoops: { loop: Loop; comp: number }[] = [];
  for (let start = 0; start < he.length; start++) {
    if (he[start].used) continue;
    const segs: Seg[] = [];
    let h = start;
    let guard = 0;
    let ok = true;
    while (!he[h].used) {
      he[h].used = true;
      segs.push(he[h].seg);
      const v = he[h].to;
      const list = out[v];
      const k = posInOut.get(he[h].twin)!;
      h = list[(k - 1 + list.length) % list.length];
      if (++guard > he.length + 1) {
        ok = false;
        break;
      }
    }
    if (!ok || h !== start || segs.length < 1) continue;
    faceLoops.push({ loop: { segs, area: loopArea(segs) }, comp: -1 });
  }

  // Bağlı bileşenler (düğüm birleşim-bul)
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of he) parent[find(e.from)] = find(e.to);
  nodes.forEach((_, i) => (comp[i] = find(i)));
  const loopComp = (l: Loop): number => {
    const s = l.segs[0];
    if (s.kind === 'circle') return -1;
    return comp[nodeOf(s.a)];
  };

  // Bileşen kimlikleri: graf bileşenleri + her daire ayrı bileşen
  interface Comp {
    faces: Loop[];
    /** dış sınır (ccw'ye çevrilmiş) */
    boundary: Loop | null;
    /** sınır üzerinde nokta */
    probe: Vec2;
    depth: number;
    parentFace: number;
  }
  const comps = new Map<number | string, Comp>();
  for (const fl of faceLoops) {
    const id = loopComp(fl.loop);
    let c = comps.get(id);
    if (!c) {
      c = { faces: [], boundary: null, probe: loopPoint(fl.loop), depth: 0, parentFace: -1 };
      comps.set(id, c);
    }
    const tolA = tol * tol;
    if (fl.loop.area > tolA) c.faces.push(fl.loop);
    else if (fl.loop.area < -tolA) {
      // Dış sınır: en büyük negatif alanlı döngü
      if (!c.boundary || -fl.loop.area > c.boundary.area) c.boundary = reverseLoop(fl.loop);
    }
  }
  circleLoops.forEach((l, i) => {
    comps.set(`c${i}`, { faces: [l], boundary: l, probe: loopPoint(l), depth: 0, parentFace: -1 });
  });

  // Tüm sınırlı yüzler
  const faces: { loop: Loop; comp: Comp; depth: number; holes: Loop[] }[] = [];
  const compList = [...comps.values()].filter((c) => c.faces.length && c.boundary);
  for (const c of compList) for (const f of c.faces) faces.push({ loop: f, comp: c, depth: 0, holes: [] });

  // Derinlik: bileşen noktasını içeren (başka bileşenlerin) yüz sayısı; ebeveyn = en derin içeren yüz
  for (const c of compList) {
    const containing: number[] = [];
    faces.forEach((f, fi) => {
      if (f.comp !== c && loopContains(f.loop, c.probe)) containing.push(fi);
    });
    c.depth = containing.length;
    c.parentFace = -1;
    let bestArea = Infinity;
    for (const fi of containing) {
      if (faces[fi].loop.area < bestArea) {
        bestArea = faces[fi].loop.area;
        c.parentFace = fi;
      }
    }
  }
  for (const f of faces) f.depth = f.comp.depth;
  for (const c of compList) if (c.parentFace >= 0) faces[c.parentFace].holes.push(reverseLoop(c.boundary!));

  return faces.map((f) => {
    const area = f.loop.area - f.holes.reduce((acc, h) => acc + Math.abs(h.area), 0);
    return { outer: f.loop, holes: f.holes, depth: f.depth, sample: regionSample(f.loop, f.holes), area };
  });
}

/** profilePoints'e göre bölge seçimi (boş → çift derinlikli tüm bölgeler) */
export function selectRegions(regions: Region[], profilePoints: Vec2[]): Region[] {
  if (!profilePoints.length) return regions.filter((r) => r.depth % 2 === 0);
  const out: Region[] = [];
  for (const p of profilePoints) {
    let best: Region | null = null;
    for (const r of regions) {
      if (!regionContains(r, p)) continue;
      if (!best || r.depth > best.depth || (r.depth === best.depth && r.area < best.area)) best = r;
    }
    if (best && !out.includes(best)) out.push(best);
  }
  return out;
}
