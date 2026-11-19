// Sketch katmanı (Canvas içinde): düzlem ızgarası, eksenler, varlıklar, bölgeler, ölçüler, önizleme,
// kamera hizalama ve canvas DOM girdisi. Ayrıca aktif gövdenin diğer sketch'lerini ince çizgilerle gösterir.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  PointsMaterial,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { bodyPlaneToWorld } from '../../modeling/actions';
import type { PlaneDef, SkConstraint, SkEntity, SketchFeature, Vec2 } from '../../modeling/types';
import { bodyFileId } from '../../modeling/types';
import { findRegions, type Loop } from '../../sketch/profiles';
import { beginSession, endSession, isDimension, useSketchUi } from '../../sketch/session';
import { useAssembly } from '../../store/useAssembly';
import { dimGeometry } from './annotations';
import { boundsOf, curvePolyline, isCurve, pointMap, TAU, type PtMap } from './geom';
import { onKeyDown, onPointerDown, onPointerLeave, onPointerMove, onPointerUp, resetController, useDraw } from './tools';
import { pxSize, updateLabels, view, worldToSketch, type WorldPlane } from './view';
import { lookAtPlane } from '../../lib/viewCommands';

// ---------------------------------------------------------------- Renkler

export const SK_COLORS = {
  free: '#5ea8ff',
  defined: '#eef1f5',
  sel: '#ffb547',
  hover: '#ffd98a',
  conflict: '#ff5c61',
  dim: '#a9b4c1',
  preview: '#8cc4ff',
  marker: '#ffd98a',
  other: '#8792a0',
  origin: '#f2c14e',
  axisX: '#e5534b',
  axisY: '#57ab5a',
  grid: '#8f9aa8',
  region: '#2f6fed',
  /** Projeksiyonla gelen (dış referans) geometri */
  ext: '#c77dff',
};

const rgb = (hex: string): [number, number, number] => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};

// ---------------------------------------------------------------- Düzlem

function worldPlane(bodyId: string, plane: PlaneDef): WorldPlane {
  const w = bodyPlaneToWorld(bodyId, plane);
  const o = new Vector3(...w.origin);
  const n = new Vector3(...w.normal).normalize();
  const x = new Vector3(...w.xDir).normalize();
  const y = new Vector3().crossVectors(n, x).normalize();
  return { o, x, y, n };
}

function basisMatrix(p: WorldPlane): Matrix4 {
  return new Matrix4().makeBasis(p.x, p.y, p.n).setPosition(p.o);
}

/** Gövde çerçevesi (instance ∘ part) değişince yeniden hesaplamak için */
function useInstanceKey(bodyId: string): string {
  return useAssembly((s) => {
    const fid = bodyFileId(bodyId);
    const i = s.doc.instances.find((x) => x.fileId === fid);
    const p = s.doc.parts.find((x) => x.fileId === fid);
    const t = (o?: { position: number[]; quaternion: number[] }) => (o ? `${o.position.join(',')}|${o.quaternion.join(',')}` : '');
    return `${t(i)}/${t(p)}`;
  });
}

// ---------------------------------------------------------------- Kök

export function SketchLayer() {
  const sketchKey = useAssembly((s) => (s.modeling.sketch ? `${s.modeling.sketch.bodyId}:${s.modeling.sketch.featureId}` : null));
  const editingId = useAssembly((s) => s.modeling.sketch?.featureId ?? null);
  const activeBodyId = useAssembly((s) => s.modeling.activeBodyId);
  return (
    <>
      {activeBodyId && <BodySketches bodyId={activeBodyId} exclude={editingId} />}
      {sketchKey && <ActiveSketch key={sketchKey} />}
    </>
  );
}

// ---------------------------------------------------------------- Diğer sketch'ler

function BodySketches({ bodyId, exclude }: { bodyId: string; exclude: string | null }) {
  const sketches = useAssembly((s) => s.doc.bodies.find((b) => b.id === bodyId)?.features);
  const instKey = useInstanceKey(bodyId);
  const list = useMemo(
    () => (sketches ?? []).filter((f): f is SketchFeature => f.type === 'sketch' && !f.suppressed && f.id !== exclude),
    [sketches, exclude],
  );
  return (
    <>
      {list.map((f) => (
        <StaticSketch key={f.id} bodyId={bodyId} data={f} instKey={instKey} />
      ))}
    </>
  );
}

function StaticSketch({ bodyId, data, instKey }: { bodyId: string; data: SketchFeature; instKey: string }) {
  const matrix = useMemo(() => {
    const m = basisMatrix(worldPlane(bodyId, data.plane));
    // Yüzeyle z-çakışmasını önlemek için normal yönünde çok küçük öteleme
    return m.multiply(new Matrix4().makeTranslation(0, 0, 0.05));
  }, [bodyId, data.plane, instKey]); // instKey: gövde taşınınca yeniden hesapla
  const points = useMemo(() => {
    const pm = pointMap(data.entities);
    const out: [number, number, number][] = [];
    for (const e of data.entities) {
      if (!isCurve(e) || e.construction) continue;
      const pl = curvePolyline(e, pm);
      for (let i = 0; i + 1 < pl.length; i++) out.push([pl[i][0], pl[i][1], 0], [pl[i + 1][0], pl[i + 1][1], 0]);
    }
    return out;
  }, [data.entities]);
  if (!points.length) return null;
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <Line segments points={points} color={SK_COLORS.other} lineWidth={1.25} transparent opacity={0.85} toneMapped={false} />
    </group>
  );
}

// ---------------------------------------------------------------- Aktif sketch

interface OrbitLike {
  target: Vector3;
  update(): void;
}

function orbit(c: unknown): OrbitLike | null {
  const o = c as Partial<OrbitLike> | null;
  return o && o.target instanceof Vector3 && typeof o.update === 'function' ? (o as OrbitLike) : null;
}

function ActiveSketch() {
  const sk = useAssembly((s) => s.modeling.sketch);
  const bodyId = sk?.bodyId ?? '';
  const featureId = sk?.featureId ?? '';
  const plane = sk?.data.plane;
  const instKey = useInstanceKey(bodyId);
  const wp = useMemo(
    () => (plane ? worldPlane(bodyId, plane) : null),
    [bodyId, plane, instKey],
  );
  const matrix = useMemo(() => (wp ? basisMatrix(wp) : new Matrix4()), [wp]);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls);
  const aligned = useRef(false);
  const tool = useSketchUi((s) => s.tool);

  // Görünüm referansları
  view.plane = wp;
  view.camera = camera;
  view.dom = gl.domElement;

  // Oturum yaşam döngüsü
  useEffect(() => {
    resetController();
    beginSession(featureId);
    return () => {
      resetController();
      endSession();
      view.plane = null;
    };
  }, [featureId]);

  // Kamerayı düzleme dik hizala (bir kez, yumuşak geçiş)
  useEffect(() => {
    const ctl = orbit(controls);
    if (aligned.current || !wp || !ctl) return;
    aligned.current = true;
    const data = useAssembly.getState().modeling.sketch?.data;
    const b = data ? boundsOf(data.entities) : null;
    const center = b ? new Vector2((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2) : new Vector2(0, 0);
    const toTarget = wp.o.clone().addScaledVector(wp.x, center.x).addScaledVector(wp.y, center.y);
    const cam = camera as PerspectiveCamera;
    const cur = cam.position.distanceTo(ctl.target);
    let toDist = Math.min(Math.max(cur, 20), 5000);
    if (b) {
      const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 1);
      const fov = ((cam.fov ?? 45) * Math.PI) / 180;
      toDist = Math.max((ext * 0.75) / Math.tan(fov / 2), 20);
    }
    // Düzleme dik, sketch x'i sağa ve y'si yukarı (yumuşak geçiş; kamera kullanıcı girdisiyle kesilir)
    lookAtPlane(wp.o, wp.n, { up: wp.y, target: toTarget, distance: toDist, duration: 450, flip: false });
  }, [controls, wp, camera]);

  // Fare: kamera tüm uygulamada aynı şemadadır (CadControls: orta = döndür, Ctrl+orta = kaydır,
  // Shift+orta = yakınlaştır, tekerlek = imlece yakınlaştır). Sol tuş çizim/seçim, sağ tuş menü içindir.

  // Canvas DOM girdisi
  useEffect(() => {
    const el = gl.domElement;
    const down = (e: PointerEvent) => onPointerDown(e);
    const ctx = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('contextmenu', ctx);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('contextmenu', ctx);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [gl]);

  // İmleç
  useEffect(() => {
    const el = gl.domElement;
    el.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    return () => {
      el.style.cursor = '';
    };
  }, [gl, tool]);

  useFrame(() => {
    const ctl = orbit(controls);
    // Piksel ölçeği (ok ve etiket boyutları)
    if (ctl && wp) {
      const px = pxSize(worldToSketch(ctl.target));
      const cur = useDraw.getState().px;
      if (Number.isFinite(px) && px > 0 && Math.abs(px - cur) / cur > 0.08) useDraw.setState({ px });
    }
    updateLabels();
  });

  if (!sk || !wp) return null;
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <SketchGrid />
      <Axes />
      <Regions entities={sk.data.entities} />
      <Entities data={sk.data} />
      <Dimensions data={sk.data} />
      <PreviewLayer />
    </group>
  );
}

// ---------------------------------------------------------------- Izgara ve eksenler

function niceStep(v: number): number {
  return Math.pow(10, Math.ceil(Math.log10(Math.max(v, 1e-6))));
}

function SketchGrid() {
  const controls = useThree((s) => s.controls);
  const [g, setG] = useState<{ minor: number; cx: number; cy: number } | null>(null);
  useFrame(() => {
    const ctl = orbit(controls);
    if (!ctl || !view.plane) return;
    const px = useDraw.getState().px;
    const minor = niceStep(px * 12);
    const major = minor * 10;
    const t = worldToSketch(ctl.target);
    const cx = Math.round(t[0] / major) * major;
    const cy = Math.round(t[1] / major) * major;
    if (!g || g.minor !== minor || g.cx !== cx || g.cy !== cy) setG({ minor, cx, cy });
  });
  const geo = useMemo(() => {
    if (!g) return null;
    const N = 100;
    const half = N * g.minor;
    const minor: [number, number, number][] = [];
    const major: [number, number, number][] = [];
    for (let i = -N; i <= N; i++) {
      const x = g.cx + i * g.minor;
      const y = g.cy + i * g.minor;
      const isMajorX = Math.abs(Math.round(x / (g.minor * 10)) * g.minor * 10 - x) < g.minor * 1e-3;
      const isMajorY = Math.abs(Math.round(y / (g.minor * 10)) * g.minor * 10 - y) < g.minor * 1e-3;
      (isMajorX ? major : minor).push([x, g.cy - half, 0], [x, g.cy + half, 0]);
      (isMajorY ? major : minor).push([g.cx - half, y, 0], [g.cx + half, y, 0]);
    }
    return { minor, major };
  }, [g]);
  if (!geo) return null;
  return (
    <>
      <Line segments points={geo.minor} color={SK_COLORS.grid} lineWidth={1} transparent opacity={0.07} depthTest={false} depthWrite={false} renderOrder={1} toneMapped={false} />
      <Line segments points={geo.major} color={SK_COLORS.grid} lineWidth={1} transparent opacity={0.16} depthTest={false} depthWrite={false} renderOrder={1} toneMapped={false} />
    </>
  );
}

function Axes() {
  const px = useDraw((s) => s.px);
  const E = Math.max(px * 4000, 100);
  const dpr = useThree((s) => s.viewport.dpr);
  const origin = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
    return g;
  }, []);
  const mat = useMemo(
    () => new PointsMaterial({ color: SK_COLORS.origin, size: 8, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }),
    [],
  );
  mat.size = 8 * dpr;
  useEffect(() => () => {
    origin.dispose();
    mat.dispose();
  }, [origin, mat]);
  return (
    <>
      <Line points={[[-E, 0, 0], [E, 0, 0]]} color={SK_COLORS.axisX} lineWidth={1} transparent opacity={0.55} depthTest={false} renderOrder={2} toneMapped={false} />
      <Line points={[[0, -E, 0], [0, E, 0]]} color={SK_COLORS.axisY} lineWidth={1} transparent opacity={0.55} depthTest={false} renderOrder={2} toneMapped={false} />
      <points geometry={origin} material={mat} renderOrder={7} />
    </>
  );
}

// ---------------------------------------------------------------- Bölgeler

function loopPoints(loop: Loop): Vector2[] {
  const out: Vector2[] = [];
  const pushPt = (x: number, y: number) => {
    const l = out[out.length - 1];
    if (!l || Math.abs(l.x - x) > 1e-9 || Math.abs(l.y - y) > 1e-9) out.push(new Vector2(x, y));
  };
  for (const s of loop.segs) {
    if (s.kind === 'line') {
      pushPt(s.a[0], s.a[1]);
      pushPt(s.b[0], s.b[1]);
    } else if (s.kind === 'circle') {
      for (let i = 0; i < 96; i++) pushPt(s.c[0] + s.r * Math.cos((TAU * i) / 96), s.c[1] + s.r * Math.sin((TAU * i) / 96));
    } else {
      let sweep = s.a1 - s.a0;
      if (s.ccw) {
        while (sweep <= 0) sweep += TAU;
      } else {
        while (sweep >= 0) sweep -= TAU;
      }
      const n = Math.max(2, Math.ceil((Math.abs(sweep) / TAU) * 96));
      for (let i = 0; i <= n; i++) {
        const a = s.a0 + (sweep * i) / n;
        pushPt(s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a));
      }
    }
  }
  if (out.length > 1 && out[0].distanceTo(out[out.length - 1]) < 1e-9) out.pop();
  return out;
}

function Regions({ entities }: { entities: SkEntity[] }) {
  const geom = useMemo(() => {
    try {
      const regions = findRegions(entities);
      if (!regions.length) return null;
      const shapes: Shape[] = [];
      for (const r of regions) {
        const pts = loopPoints(r.outer);
        if (pts.length < 3) continue;
        const sh = new Shape(pts);
        for (const h of r.holes) {
          const hp = loopPoints(h);
          if (hp.length >= 3) sh.holes.push(new Shape(hp));
        }
        shapes.push(sh);
      }
      return shapes.length ? new ShapeGeometry(shapes) : null;
    } catch (e) {
      console.error('Bölgeler hesaplanamadı', e);
      return null;
    }
  }, [entities]);
  useEffect(() => () => geom?.dispose(), [geom]);
  if (!geom) return null;
  return (
    <mesh geometry={geom} renderOrder={2}>
      <meshBasicMaterial color={SK_COLORS.region} transparent opacity={0.14} depthTest={false} depthWrite={false} side={DoubleSide} toneMapped={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------- Varlıklar

/** Seçim/hover/çelişki durumuna göre vurgulanan varlık kümeleri */
function useHighlight(data: SketchFeature) {
  const sel = useSketchUi((s) => s.sel);
  const hover = useSketchUi((s) => s.hover);
  const status = useSketchUi((s) => s.status);
  const pending = useDraw((s) => s.pending);
  return useMemo(() => {
    const selSet = new Set<string>(pending);
    const hoverSet = new Set<string>();
    const conflictSet = new Set<string>();
    const byId = new Map(data.constraints.map((c) => [c.id, c]));
    for (const id of sel) {
      const c = byId.get(id);
      if (c) c.refs.forEach((r) => hoverSet.add(r));
      else selSet.add(id);
    }
    if (hover) {
      const c = byId.get(hover);
      if (c) c.refs.forEach((r) => hoverSet.add(r));
      else hoverSet.add(hover);
    }
    for (const id of status.conflicting) byId.get(id)?.refs.forEach((r) => conflictSet.add(r));
    const defined = status.known && status.ok && status.dof === 0;
    return { selSet, hoverSet, conflictSet, defined, conflicting: new Set(status.conflicting), sel: new Set(sel), hover };
  }, [data.constraints, sel, hover, status, pending]);
}

function entityColor(id: string, h: ReturnType<typeof useHighlight>, ext?: boolean): string {
  if (h.selSet.has(id)) return SK_COLORS.sel;
  if (h.hoverSet.has(id)) return SK_COLORS.hover;
  if (h.conflictSet.has(id)) return SK_COLORS.conflict;
  if (ext) return SK_COLORS.ext;
  return h.defined ? SK_COLORS.defined : SK_COLORS.free;
}

type V3 = [number, number, number];

function pushPolyline(pl: Vec2[], col: V3, pos: V3[], cols: V3[]) {
  for (let i = 0; i + 1 < pl.length; i++) {
    pos.push([pl[i][0], pl[i][1], 0], [pl[i + 1][0], pl[i + 1][1], 0]);
    cols.push(col, col);
  }
}

function Entities({ data }: { data: SketchFeature }) {
  const h = useHighlight(data);
  const px = useDraw((s) => s.px);
  const dpr = useThree((s) => s.viewport.dpr);
  const pm = useMemo(() => pointMap(data.entities), [data.entities]);
  const built = useMemo(() => {
    const solid = { pos: [] as V3[], col: [] as V3[] };
    const dashed = { pos: [] as V3[], col: [] as V3[] };
    const ppos: number[] = [];
    const pcol: number[] = [];
    for (const e of data.entities) {
      const col = rgb(entityColor(e.id, h, !!e.ext));
      if (e.kind === 'point') {
        ppos.push(e.x, e.y, 0);
        pcol.push(...col);
        continue;
      }
      const pl = curvePolyline(e, pm);
      pushPolyline(pl, col, e.construction ? dashed.pos : solid.pos, e.construction ? dashed.col : solid.col);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(ppos, 3));
    g.setAttribute('color', new Float32BufferAttribute(pcol, 3));
    return { solid, dashed, points: g };
  }, [data.entities, pm, h]);
  const mat = useMemo(
    () => new PointsMaterial({ size: 6, vertexColors: true, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }),
    [],
  );
  mat.size = 6 * dpr;
  useEffect(() => () => built.points.dispose(), [built]);
  useEffect(() => () => mat.dispose(), [mat]);
  return (
    <>
      {built.solid.pos.length > 0 && (
        <Line segments points={built.solid.pos} vertexColors={built.solid.col} lineWidth={2} transparent depthTest={false} renderOrder={5} toneMapped={false} />
      )}
      {built.dashed.pos.length > 0 && (
        <Line
          segments
          points={built.dashed.pos}
          vertexColors={built.dashed.col}
          lineWidth={1.4}
          dashed
          dashSize={7 * px}
          gapSize={4 * px}
          transparent
          depthTest={false}
          renderOrder={5}
          toneMapped={false}
        />
      )}
      <points geometry={built.points} material={mat} renderOrder={6} />
    </>
  );
}

// ---------------------------------------------------------------- Ölçüler

function Dimensions({ data }: { data: SketchFeature }) {
  const h = useHighlight(data);
  const px = useDraw((s) => s.px);
  const previewDim = useDraw((s) => s.preview?.dim);
  const built = useMemo(() => {
    const pm: PtMap = pointMap(data.entities);
    const byId = new Map(data.entities.map((e) => [e.id, e]));
    const refs = { get: (id: string) => byId.get(id), pm };
    const pos: V3[] = [];
    const col: V3[] = [];
    const list: SkConstraint[] = data.constraints.filter((c) => isDimension(c.type));
    if (previewDim) list.push(previewDim);
    for (const c of list) {
      const g = dimGeometry(c, refs, px);
      if (!g) continue;
      const color =
        c.id === '__preview'
          ? SK_COLORS.preview
          : h.conflicting.has(c.id)
            ? SK_COLORS.conflict
            : h.sel.has(c.id)
              ? SK_COLORS.sel
              : h.hover === c.id
                ? SK_COLORS.hover
                : SK_COLORS.dim;
      const cc = rgb(color);
      for (const pl of g.polys) pushPolyline(pl, cc, pos, col);
    }
    return { pos, col };
  }, [data.entities, data.constraints, px, previewDim, h]);
  if (!built.pos.length) return null;
  return <Line segments points={built.pos} vertexColors={built.col} lineWidth={1} transparent depthTest={false} renderOrder={4} toneMapped={false} />;
}

// ---------------------------------------------------------------- Önizleme

function PreviewLayer() {
  const preview = useDraw((s) => s.preview);
  const marker = useDraw((s) => s.marker);
  const px = useDraw((s) => s.px);
  const dpr = useThree((s) => s.viewport.dpr);
  const built = useMemo(() => {
    const solid: V3[] = [];
    const guides: V3[] = [];
    const push = (pl: Vec2[], out: V3[]) => {
      for (let i = 0; i + 1 < pl.length; i++) out.push([pl[i][0], pl[i][1], 0], [pl[i + 1][0], pl[i + 1][1], 0]);
    };
    preview?.polys.forEach((p) => push(p, solid));
    preview?.guides.forEach((p) => push(p, guides));
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute((preview?.points ?? []).flatMap((p) => [p[0], p[1], 0]), 3));
    const m = new BufferGeometry();
    m.setAttribute('position', new Float32BufferAttribute(marker ? [marker[0], marker[1], 0] : [], 3));
    return { solid, guides, points: g, marker: m };
  }, [preview, marker]);
  const pmat = useMemo(
    () => new PointsMaterial({ color: SK_COLORS.preview, size: 6, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }),
    [],
  );
  const mmat = useMemo(
    () =>
      new PointsMaterial({ color: SK_COLORS.marker, size: 11, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.55, toneMapped: false }),
    [],
  );
  pmat.size = 6 * dpr;
  mmat.size = 11 * dpr;
  useEffect(
    () => () => {
      built.points.dispose();
      built.marker.dispose();
    },
    [built],
  );
  useEffect(
    () => () => {
      pmat.dispose();
      mmat.dispose();
    },
    [pmat, mmat],
  );
  return (
    <>
      {built.solid.length > 0 && (
        <Line segments points={built.solid} color={SK_COLORS.preview} lineWidth={1.6} transparent depthTest={false} renderOrder={8} toneMapped={false} />
      )}
      {built.guides.length > 0 && (
        <Line
          segments
          points={built.guides}
          color={SK_COLORS.preview}
          lineWidth={1}
          dashed
          dashSize={5 * px}
          gapSize={4 * px}
          transparent
          opacity={0.6}
          depthTest={false}
          renderOrder={8}
          toneMapped={false}
        />
      )}
      <points geometry={built.marker} material={mmat} renderOrder={9} />
      <points geometry={built.points} material={pmat} renderOrder={9} />
    </>
  );
}
