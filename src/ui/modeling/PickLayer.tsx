// Canvas içi modelleme katmanı:
// - kenar seçim isteğinde gövde kenarlarını kalın, seçilebilir çizgiler olarak çizer (hover / seçili vurgusu)
// - extrude/revolve taslağında sketch'in kapalı bölgelerini tıklanabilir dolgular olarak çizer
// - delik taslağında yüzey düzlemine tıklayarak merkez ekler, merkezleri işaretler
// - revolve ekseni, desen yönü/ekseni ve ayna düzlemi için basit görseller
// Tıklama/hover işlemleri canvas üzerinde elle raycast edilir (gövde mesh'leri olayları yutmasın diye);
// tüketilen tıklama R3F'ye ulaşmaz.
import { isProfileFeature } from '@/core/features/registry';
import { bodyPrimaryPart } from '@/core/modeling/bodyParts';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import {
  DoubleSide,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Ray,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Group,
} from 'three';
import { useShallow } from 'zustand/react/shallow';
import { geometryCache, type ParsedMesh } from '@/core/geometry/geometryCache';
import { objectRegistry } from '@/ui/viewport/registry';
import { updateFeatureDraft } from '@/state/modelingActions';
import { pickableEdge } from '@/ui/modeling/pick';
import { useAssembly } from '@/state/useAssembly';
import { selectRegions, type Region } from '@/core/sketch/profiles';
import type { Feature, PickRequest, PlaneDef, SketchFeature, Vec2, Vec3 } from '@/core/types';
import { bodyFileId, isBodyFileId } from '@/core/types';
import { inViewCube, sceneRefs } from '@/ui/viewport/sceneRefs';
import {
  bodyMesh,
  bodyScale,
  dot3,
  matchEdgeIndices,
  norm3,
  planeMatrix,
  planeTo2,
  planeTo3,
  pointMap,
  regionAt,
  regionGeometry,
  regionOutline,
  sketchOf,
  sketchRegions,
  sub3,
} from '@/ui/modeling/geom';
import { useModelingUi } from '@/ui/modeling/modelingUi';

const C_EDGE = '#7fb2ff';
const C_HOVER = '#3ea6ff';
const C_PICKED = '#30a46c';
const C_REGION = '#3e7bfa';
const C_REGION_SEL = '#f5a524';
const C_AXIS = '#f5a524';
const C_HOLE = '#ff8f5a';

/** İmleç ile kenar arasındaki en fazla piksel mesafesi */
const EDGE_PX = 7;

type Hover =
  | { kind: 'edge'; partId: string; edgeIndex: number }
  | { kind: 'region'; index: number }
  | { kind: 'point'; p: Vec2 };

const hoverKey = (h: Hover | null) =>
  !h ? '' : h.kind === 'edge' ? `e:${h.partId}:${h.edgeIndex}` : h.kind === 'region' ? `r:${h.index}` : `p:${h.p[0]}:${h.p[1]}`;

const st = () => useAssembly.getState();

// ---------------------------------------------------------------- Kök

export function PickLayer() {
  const sketchOpen = useAssembly((s) => !!s.modeling.sketch);
  const pick = useAssembly((s) => s.modeling.pick);
  const feature = useAssembly((s) => s.modeling.feature);
  const [hover, setHoverState] = useState<Hover | null>(null);
  const hoverRef = useRef<Hover | null>(null);
  const setHover = (h: Hover | null) => {
    if (hoverKey(h) === hoverKey(hoverRef.current)) return;
    hoverRef.current = h;
    setHoverState(h);
  };

  if (sketchOpen) return null;
  const edgePick = pick?.kinds.includes('edge') ? pick : null;
  return (
    <>
      <Interaction setHover={setHover} />
      {edgePick && <EdgePickLayer pick={edgePick} hover={hover?.kind === 'edge' ? hover : null} />}
      {feature && <DraftVisuals bodyId={feature.bodyId} draft={feature.draft} hover={hover} picking={!!pick} />}
    </>
  );
}

// ---------------------------------------------------------------- Gövde çerçevesi

/** Çocuklarını parça grubunun (mesh koordinatı = gövde-yerel) dünya dönüşümüyle çizer */
function BodyFrame({ partId, children }: { partId: string; children: ReactNode }) {
  const ref = useRef<Group>(null);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const target = objectRegistry.get(partId);
    g.visible = !!target;
    if (!target) return;
    target.updateWorldMatrix(true, false);
    g.matrix.copy(target.matrixWorld);
    g.matrixWorldNeedsUpdate = true;
  });
  return (
    <group ref={ref} matrixAutoUpdate={false} visible={false}>
      {children}
    </group>
  );
}

/** Gövdenin (ilk) parça id'si ve dosya durumu (yeniden üretimde değişir) */
function useBodyPart(bodyId: string) {
  return useAssembly(
    useShallow((s) => {
      const fid = bodyFileId(bodyId);
      const p = bodyPrimaryPart(s.doc, bodyId);
      return { partId: p?.id ?? null, status: s.fileStatus[fid] };
    }),
  );
}

/** Düzlem → konum/dönüş (düzlem-2B içeriği bu grubun içinde z = 0'da çizilir) */
function usePlaneTransform(plane: PlaneDef) {
  return useMemo(() => {
    const m = planeMatrix(plane);
    const p = new Vector3();
    const q = new Quaternion();
    m.decompose(p, q, new Vector3());
    return { position: p, quaternion: q };
  }, [plane]);
}

function PlaneGroup({ plane, children }: { plane: PlaneDef; children: ReactNode }) {
  const t = usePlaneTransform(plane);
  return (
    <group position={t.position} quaternion={t.quaternion}>
      {children}
    </group>
  );
}

// ---------------------------------------------------------------- Etkileşim

interface Ctx {
  raycaster: Raycaster;
  camera: Camera;
  heightPx: number;
}

/** t uzaklıktaki bir pikselin dünya boyu */
function worldPerPixel(ctx: Ctx, t: number): number {
  const c = ctx.camera;
  if ((c as PerspectiveCamera).isPerspectiveCamera) {
    const pc = c as PerspectiveCamera;
    return (2 * Math.tan((pc.fov * Math.PI) / 360) * t) / pc.zoom / ctx.heightPx;
  }
  if ((c as OrthographicCamera).isOrthographicCamera) {
    const oc = c as OrthographicCamera;
    return (oc.top - oc.bottom) / oc.zoom / ctx.heightPx;
  }
  return t / ctx.heightPx;
}

function localRay(ray: Ray, frame: Matrix4): Ray {
  return ray.clone().applyMatrix4(frame.clone().invert());
}

function rayPlane(ray: Ray, plane: PlaneDef): Vec3 | null {
  const n = plane.normal;
  const d: Vec3 = [ray.direction.x, ray.direction.y, ray.direction.z];
  const o: Vec3 = [ray.origin.x, ray.origin.y, ray.origin.z];
  const den = dot3(d, n);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot3(sub3(plane.origin, o), n) / den;
  if (t < 0) return null;
  return [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
}

/** Sahnedeki en yakın mesh yüzeyine dünya uzaklığı (kenar örtülme testi) */
function nearestSurface(raycaster: Raycaster): number {
  const root = sceneRefs.root;
  if (!root) return Infinity;
  const hits = raycaster.intersectObject(root, true);
  for (const h of hits) if ((h.object as Mesh).isMesh) return h.distance;
  return Infinity;
}

function edgePickParts(pick: PickRequest) {
  const s = st();
  return s.doc.parts.filter((p) => isBodyFileId(p.fileId) && p.visible && (!pick.bodyId || p.fileId === bodyFileId(pick.bodyId)));
}

function edgesMesh(fileId: string, nodeKey: number): ParsedMesh | undefined {
  return geometryCache.get(fileId)?.nodes[nodeKey]?.meshes.find((m) => m.brepEdges);
}

const _a = new Vector3();
const _b = new Vector3();
const _onRay = new Vector3();
const _onSeg = new Vector3();

function hitEdge(ctx: Ctx, pick: PickRequest): (Hover & { kind: 'edge' }) | null {
  const cands: { partId: string; edgeIndex: number; px: number; world: Vector3 }[] = [];
  for (const part of edgePickParts(pick)) {
    const group = objectRegistry.get(part.id);
    const mesh = edgesMesh(part.fileId, part.nodeKey);
    const be = mesh?.brepEdges;
    if (!group || !be) continue;
    group.updateWorldMatrix(true, false);
    const lr = localRay(ctx.raycaster.ray, group.matrixWorld);
    const pos = be.position;
    be.ranges.forEach((r, ei) => {
      if (!pickableEdge(pick, part.id, be.sigs[ei])) return;
      let best = Infinity;
      let bestP: Vector3 | null = null;
      for (let s = r.first; s <= r.last; s++) {
        const o = s * 6;
        if (o + 5 >= pos.length) break;
        _a.set(pos[o], pos[o + 1], pos[o + 2]);
        _b.set(pos[o + 3], pos[o + 4], pos[o + 5]);
        const d2 = lr.distanceSqToSegment(_a, _b, _onRay, _onSeg);
        const t = _onRay.distanceTo(lr.origin);
        const px = Math.sqrt(d2) / Math.max(1e-9, worldPerPixel(ctx, t));
        if (px < best) {
          best = px;
          bestP = _onSeg.clone();
        }
      }
      if (best < EDGE_PX && bestP) {
        cands.push({ partId: part.id, edgeIndex: ei, px: best, world: bestP.applyMatrix4(group.matrixWorld) });
      }
    });
  }
  if (!cands.length) return null;
  cands.sort((x, y) => x.px - y.px);
  const surf = nearestSurface(ctx.raycaster);
  const origin = ctx.raycaster.ray.origin;
  for (const c of cands) {
    const t = c.world.distanceTo(origin);
    const tol = Math.max(EDGE_PX * 1.5 * worldPerPixel(ctx, t), 0.05);
    if (t <= surf + tol) return { kind: 'edge', partId: c.partId, edgeIndex: c.edgeIndex };
  }
  return null;
}

/** Gövde-yerel ışın (gövdenin ilk parçasının çerçevesinde) */
function bodyRay(ctx: Ctx, bodyId: string): Ray | null {
  const part = bodyPrimaryPart(st().doc, bodyId);
  const group = part ? objectRegistry.get(part.id) : undefined;
  if (!group) return null;
  group.updateWorldMatrix(true, false);
  return localRay(ctx.raycaster.ray, group.matrixWorld);
}

function snap(v: number): number {
  const ui = st().ui;
  if (!ui.snap || !(ui.snapMove > 0)) return Number(v.toFixed(3));
  return Number((Math.round(v / ui.snapMove) * ui.snapMove).toFixed(6));
}

/** Geçerli moda göre imlecin altındaki hedef */
function resolveHit(ctx: Ctx): Hover | null {
  const s = st();
  if (s.modeling.sketch) return null;
  const pick = s.modeling.pick;
  if (pick) return pick.kinds.includes('edge') ? hitEdge(ctx, pick) : null;
  const fs = s.modeling.feature;
  if (!fs) return null;
  const d = fs.draft;
  if (d.type === 'hole') {
    if (!useModelingUi.getState().holePlace) return null;
    const lr = bodyRay(ctx, fs.bodyId);
    const p = lr && rayPlane(lr, d.plane);
    if (!p) return null;
    const q = planeTo2(d.plane, p);
    return { kind: 'point', p: [snap(q[0]), snap(q[1])] };
  }
  if (isProfileFeature(d)) {
    const body = s.doc.bodies.find((b) => b.id === fs.bodyId);
    const sk = sketchOf(body, d.sketchId);
    if (!sk) return null;
    const regions = sketchRegions(sk);
    if (!regions.length) return null;
    const lr = bodyRay(ctx, fs.bodyId);
    const p = lr && rayPlane(lr, sk.plane);
    if (!p) return null;
    const i = regionAt(regions, planeTo2(sk.plane, p));
    return i >= 0 ? { kind: 'region', index: i } : null;
  }
  return null;
}

/** Hedefe tıklandı: true = tıklama tüketildi */
function activate(h: Hover): boolean {
  const s = st();
  if (h.kind === 'edge') {
    const pick = s.modeling.pick;
    const part = s.doc.parts.find((p) => p.id === h.partId);
    const sig = part ? edgesMesh(part.fileId, part.nodeKey)?.brepEdges?.sigs[h.edgeIndex] : undefined;
    if (!pick || !sig) return false;
    s.addPicked({ kind: 'edge', partId: h.partId, edgeIndex: h.edgeIndex, sig });
    return true;
  }
  const fs = s.modeling.feature;
  if (!fs) return false;
  const d = fs.draft;
  if (h.kind === 'point' && d.type === 'hole') {
    updateFeatureDraft({ points: [...d.points, h.p] });
    return true;
  }
  if (h.kind === 'region' && isProfileFeature(d)) {
    const body = s.doc.bodies.find((b) => b.id === fs.bodyId);
    const sk = sketchOf(body, d.sketchId);
    if (!sk) return false;
    const regions = sketchRegions(sk);
    const region = regions[h.index];
    if (!region) return false;
    const owners = d.profilePoints.map((p) => regionAt(regions, p));
    const points = owners.includes(h.index) ? d.profilePoints.filter((_, j) => owners[j] !== h.index) : [...d.profilePoints, region.sample];
    useModelingUi.getState().set({ profileMode: 'pick' });
    updateFeatureDraft({ profilePoints: points });
    return true;
  }
  return false;
}

function Interaction({ setHover }: { setHover(h: Hover | null): void }) {
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const setHoverRef = useRef(setHover);
  useEffect(() => {
    setHoverRef.current = setHover;
  });

  useEffect(() => {
    const el = gl.domElement;
    const raycaster = new Raycaster();
    let down: { x: number; y: number } | null = null;
    let raf = 0;
    let last: PointerEvent | null = null;
    let cursorSet = false;

    const ctxOf = (ev: MouseEvent): Ctx => {
      const rect = el.getBoundingClientRect();
      const ndc = new Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      const camera = get().camera;
      raycaster.setFromCamera(ndc, camera);
      return { raycaster, camera, heightPx: rect.height || 1 };
    };
    const active = () => {
      const s = st();
      if (s.modeling.sketch) return false;
      if (s.modeling.pick) return s.modeling.pick.kinds.includes('edge');
      const d = s.modeling.feature?.draft;
      return !!d && (isProfileFeature(d) || (d.type === 'hole' && useModelingUi.getState().holePlace));
    };
    const setCursor = (on: boolean) => {
      if (on) {
        el.style.cursor = 'pointer';
        cursorSet = true;
      } else if (cursorSet) {
        el.style.cursor = '';
        cursorSet = false;
      }
    };
    const update = () => {
      raf = 0;
      const ev = last;
      if (!ev) return;
      if (!active() || ev.buttons) {
        setHoverRef.current(null);
        setCursor(false);
        return;
      }
      let h: Hover | null = null;
      try {
        h = resolveHit(ctxOf(ev));
      } catch (e) {
        console.error('Seçim katmanı hatası', e);
      }
      setHoverRef.current(h);
      setCursor(!!h);
    };
    const onMove = (ev: PointerEvent) => {
      last = ev;
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onDown = (ev: PointerEvent) => {
      down = ev.button === 0 && !inViewCube(ev.clientX, ev.clientY) ? { x: ev.clientX, y: ev.clientY } : null;
    };
    const onLeave = () => {
      last = null;
      setHoverRef.current(null);
      setCursor(false);
    };
    const onClick = (ev: MouseEvent) => {
      if (ev.button !== 0 || !down) return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4;
      down = null;
      if (moved || !active()) return;
      let h: Hover | null = null;
      try {
        h = resolveHit(ctxOf(ev));
      } catch (e) {
        console.error('Seçim katmanı hatası', e);
      }
      if (h && activate(h)) {
        // Tüketilen tıklama sahne seçimine (R3F) ulaşmasın
        ev.stopPropagation();
        last = ev as PointerEvent;
        if (!raf) raf = requestAnimationFrame(update);
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('click', onClick, true);
    // Mod değişince (ör. seçim isteği bitti) hover'ı yenile
    const unsub = useAssembly.subscribe((s, p) => {
      if (s.modeling.pick !== p.modeling.pick || s.modeling.feature !== p.modeling.feature) {
        if (last && !raf) raf = requestAnimationFrame(update);
        else if (!last) setHoverRef.current(null);
      }
    });
    const unsubUi = useModelingUi.subscribe((s, p) => {
      if (s.holePlace !== p.holePlace && last && !raf) raf = requestAnimationFrame(update);
    });
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick, true);
      unsub();
      unsubUi();
      if (raf) cancelAnimationFrame(raf);
      setCursor(false);
    };
  }, [gl, get]);
  return null;
}

// ---------------------------------------------------------------- Kenar seçimi

function EdgePickLayer({ pick, hover }: { pick: PickRequest; hover: (Hover & { kind: 'edge' }) | null }) {
  const parts = useAssembly(
    useShallow((s) =>
      s.doc.parts
        .filter((p) => isBodyFileId(p.fileId) && p.visible && (!pick.bodyId || p.fileId === bodyFileId(pick.bodyId)))
        .map((p) => `${p.id}|${p.fileId}|${p.nodeKey}`),
    ),
  );
  const draftEdges = useAssembly((s) => {
    const d = s.modeling.feature?.draft;
    return pick.key === 'edges' && d && (d.type === 'fillet' || d.type === 'chamfer') ? d.edges : null;
  });
  return (
    <>
      {parts.map((k) => {
        const [partId, fileId, nodeKey] = k.split('|');
        const picked = pick.picked.filter((t) => t.kind === 'edge' && t.partId === partId).map((t) => (t.kind === 'edge' ? t.edgeIndex : -1));
        return (
          <EdgeSet
            key={partId}
            partId={partId}
            fileId={fileId}
            nodeKey={Number(nodeKey)}
            pick={pick}
            hoverIndex={hover && hover.partId === partId ? hover.edgeIndex : -1}
            pickedIndices={picked}
            draftEdges={draftEdges}
          />
        );
      })}
    </>
  );
}

function segPoints(pos: Float32Array, first: number, last: number): Vec3[] {
  const out: Vec3[] = [];
  for (let s = first; s <= last; s++) {
    const o = s * 6;
    if (o + 5 >= pos.length) break;
    out.push([pos[o], pos[o + 1], pos[o + 2]], [pos[o + 3], pos[o + 4], pos[o + 5]]);
  }
  return out;
}

const EdgeSet = memo(function EdgeSet({
  partId,
  fileId,
  nodeKey,
  pick,
  hoverIndex,
  pickedIndices,
  draftEdges,
}: {
  partId: string;
  fileId: string;
  nodeKey: number;
  pick: PickRequest;
  hoverIndex: number;
  pickedIndices: number[];
  draftEdges: import('@/core/types').EdgeSig[] | null;
}) {
  // Dosya durumu nesnesi her yeniden üretimde değişir → yeni kenarlar
  const status = useAssembly((s) => s.fileStatus[fileId]);
  const mesh = useMemo(() => (status ? edgesMesh(fileId, nodeKey) : undefined), [status, fileId, nodeKey]);
  const be = mesh?.brepEdges;
  const all = useMemo(() => {
    if (!be) return null;
    const pts: Vec3[] = [];
    be.ranges.forEach((r, i) => {
      if (pickableEdge(pick, partId, be.sigs[i])) pts.push(...segPoints(be.position, r.first, r.last));
    });
    return pts.length ? pts : null;
  }, [be, pick, partId]);
  const selected = useMemo(() => {
    const set = new Set(pickedIndices);
    if (draftEdges) for (const i of matchEdgeIndices(mesh, draftEdges)) set.add(i);
    return [...set];
  }, [pickedIndices.join(','), draftEdges, mesh]); // eslint-disable-line react-hooks/exhaustive-deps
  const selPts = useMemo(() => {
    if (!be || !selected.length) return null;
    const pts: Vec3[] = [];
    for (const i of selected) {
      const r = be.ranges[i];
      if (r) pts.push(...segPoints(be.position, r.first, r.last));
    }
    return pts.length ? pts : null;
  }, [be, selected]);
  const hovPts = useMemo(() => {
    const r = be && hoverIndex >= 0 ? be.ranges[hoverIndex] : undefined;
    if (!be || !r) return null;
    const pts = segPoints(be.position, r.first, r.last);
    return pts.length ? pts : null;
  }, [be, hoverIndex]);

  if (!be) return null;
  return (
    <BodyFrame partId={partId}>
      {all && <Line points={all} segments color={C_EDGE} lineWidth={2} transparent opacity={0.85} renderOrder={4} />}
      {selPts && <Line points={selPts} segments color={C_PICKED} lineWidth={4} renderOrder={5} />}
      {hovPts && <Line points={hovPts} segments color={C_HOVER} lineWidth={5} depthTest={false} renderOrder={6} />}
    </BodyFrame>
  );
});

// ---------------------------------------------------------------- Taslak görselleri

function DraftVisuals({ bodyId, draft, hover, picking }: { bodyId: string; draft: Feature; hover: Hover | null; picking: boolean }) {
  const { partId, status } = useBodyPart(bodyId);
  const body = useAssembly((s) => s.doc.bodies.find((b) => b.id === bodyId));
  const scale = useMemo(() => bodyScale(bodyId), [bodyId, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const center = useMemo<Vec3>(() => {
    const g = bodyMesh(bodyId)?.geometry;
    const bb = g?.boundingBox;
    if (!bb) return [0, 0, 0];
    return [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2];
  }, [bodyId, status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!partId) return null;

  let content: ReactNode = null;
  if (isProfileFeature(draft)) {
    const sk = sketchOf(body, draft.sketchId);
    if (sk) {
      content = (
        <>
          <RegionFills sketch={sk} profilePoints={draft.profilePoints} hoverIndex={!picking && hover?.kind === 'region' ? hover.index : -1} />
          {draft.type === 'revolve' && <RevolveAxis sketch={sk} lineId={draft.axisLineId} scale={scale} />}
        </>
      );
    }
  } else if (draft.type === 'hole') {
    content = <HoleMarks plane={draft.plane} points={draft.points} diameter={draft.diameter} ghost={hover?.kind === 'point' ? hover.p : null} />;
  } else if (draft.type === 'linearPattern') {
    const len1 = Math.max(Math.abs(draft.spacing1) * Math.max(1, draft.count1 - 1), scale * 0.4);
    const len2 = Math.max(Math.abs(draft.spacing2) * Math.max(1, draft.count2 - 1), scale * 0.4);
    content = (
      <>
        <Arrow from={center} dir={draft.dir1} length={len1} color={C_AXIS} />
        {draft.count2 > 1 && <Arrow from={center} dir={draft.dir2} length={len2} color="#3ea6ff" />}
      </>
    );
  } else if (draft.type === 'circularPattern') {
    content = <AxisLine origin={draft.axisOrigin} dir={draft.axisDir} length={scale * 1.4} />;
  } else if (draft.type === 'mirror') {
    content = <MirrorPlane plane={draft.plane} center={center} size={scale * 1.3} />;
  }
  if (!content) return null;
  return <BodyFrame partId={partId}>{content}</BodyFrame>;
}

/** Sketch'in kapalı bölgeleri: seçili olanlar turuncu, imleçteki parlak */
function RegionFills({ sketch, profilePoints, hoverIndex }: { sketch: SketchFeature; profilePoints: Vec2[]; hoverIndex: number }) {
  const mode = useModelingUi((s) => s.profileMode);
  const regions = sketchRegions(sketch);
  const geoms = useMemo(() => regions.map((r) => regionGeometry(r)), [regions]);
  useEffect(() => () => geoms.forEach((g) => g?.dispose()), [geoms]);
  const outlines = useMemo(() => regions.map((r) => regionOutline(r)), [regions]);
  const selected = useMemo(() => {
    const set = new Set<number>();
    if (mode === 'pick' || profilePoints.length) {
      for (const p of profilePoints) {
        const i = regionAt(regions, p);
        if (i >= 0) set.add(i);
      }
    } else {
      let sel: Region[] = [];
      try {
        sel = selectRegions(regions, []);
      } catch {
        sel = [];
      }
      regions.forEach((r, i) => {
        if (sel.includes(r)) set.add(i);
      });
    }
    return set;
  }, [regions, profilePoints, mode]);

  if (!regions.length) return null;
  return (
    <PlaneGroup plane={sketch.plane}>
      {regions.map((r, i) => {
        const g = geoms[i];
        const sel = selected.has(i);
        const hov = i === hoverIndex;
        return (
          <group key={i}>
            {g && (
              <mesh geometry={g} renderOrder={3} raycast={() => {}}>
                <meshBasicMaterial
                  color={sel ? C_REGION_SEL : C_REGION}
                  transparent
                  opacity={hov ? 0.55 : sel ? 0.38 : 0.14}
                  depthTest={false}
                  depthWrite={false}
                  side={DoubleSide}
                  toneMapped={false}
                />
              </mesh>
            )}
            {(sel || hov) &&
              outlines[i].map((pts, j) =>
                pts.length > 1 ? (
                  <Line key={j} points={pts} color={sel ? C_REGION_SEL : C_HOVER} lineWidth={hov ? 2.5 : 1.5} depthTest={false} renderOrder={4} />
                ) : null,
              )}
          </group>
        );
      })}
    </PlaneGroup>
  );
}

function RevolveAxis({ sketch, lineId, scale }: { sketch: SketchFeature; lineId: string; scale: number }) {
  const pts = useMemo(() => {
    const l = sketch.entities.find((e) => e.id === lineId && e.kind === 'line');
    if (!l || l.kind !== 'line') return null;
    const pm = pointMap(sketch);
    const a = pm.get(l.p1);
    const b = pm.get(l.p2);
    if (!a || !b) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const ext = scale * 0.5;
    const ux = dx / len;
    const uy = dy / len;
    return [planeTo3(sketch.plane, [a.x - ux * ext, a.y - uy * ext]), planeTo3(sketch.plane, [b.x + ux * ext, b.y + uy * ext])];
  }, [sketch, lineId, scale]);
  if (!pts) return null;
  return <Line points={pts} color={C_AXIS} lineWidth={2.5} dashed dashSize={3} gapSize={2} depthTest={false} renderOrder={6} />;
}

function circlePts(c: Vec2, r: number, n = 48): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t), 0]);
  }
  return out;
}

function HoleMarks({ plane, points, diameter, ghost }: { plane: PlaneDef; points: Vec2[]; diameter: number; ghost: Vec2 | null }) {
  const r = Math.max(diameter / 2, 0.5);
  return (
    <PlaneGroup plane={plane}>
      {points.map((p, i) => (
        <group key={i}>
          <Line points={circlePts(p, r)} color={C_HOLE} lineWidth={2} depthTest={false} renderOrder={6} />
          <Line
            points={[
              [p[0] - r * 0.4, p[1], 0],
              [p[0] + r * 0.4, p[1], 0],
              [p[0], p[1] - r * 0.4, 0],
              [p[0], p[1] + r * 0.4, 0],
            ]}
            segments
            color={C_HOLE}
            lineWidth={1.5}
            depthTest={false}
            renderOrder={6}
          />
        </group>
      ))}
      {ghost && <Line points={circlePts(ghost, r)} color={C_HOVER} lineWidth={2} dashed dashSize={1.5} gapSize={1} depthTest={false} renderOrder={7} />}
    </PlaneGroup>
  );
}

const Y_UP = new Vector3(0, 1, 0);

function Arrow({ from, dir, length, color }: { from: Vec3; dir: Vec3; length: number; color: string }) {
  const d = norm3(dir);
  const to: Vec3 = [from[0] + d[0] * length, from[1] + d[1] * length, from[2] + d[2] * length];
  const head = Math.max(length * 0.08, 1.5);
  const q = useMemo(() => new Quaternion().setFromUnitVectors(Y_UP, new Vector3(...d)), [d[0], d[1], d[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Line points={[from, to]} color={color} lineWidth={2.5} depthTest={false} renderOrder={6} />
      <mesh position={to} quaternion={q} renderOrder={6} raycast={() => {}}>
        <coneGeometry args={[head * 0.4, head, 16]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
      </mesh>
    </>
  );
}

function AxisLine({ origin, dir, length }: { origin: Vec3; dir: Vec3; length: number }) {
  const d = norm3(dir);
  const h = length / 2;
  const a: Vec3 = [origin[0] - d[0] * h, origin[1] - d[1] * h, origin[2] - d[2] * h];
  return (
    <>
      <Line points={[a, origin]} color={C_AXIS} lineWidth={2} dashed dashSize={3} gapSize={2} depthTest={false} renderOrder={6} />
      <Arrow from={origin} dir={d} length={h} color={C_AXIS} />
    </>
  );
}

function MirrorPlane({ plane, center, size }: { plane: PlaneDef; center: Vec3; size: number }) {
  // Görsel: gövde merkezinin düzleme izdüşümünde kare
  const n = norm3(plane.normal);
  const off = dot3(sub3(center, plane.origin), n);
  const c: Vec3 = [center[0] - off * n[0], center[1] - off * n[1], center[2] - off * n[2]];
  const shown = useMemo<PlaneDef>(() => ({ origin: c, xDir: plane.xDir, normal: n }), [c[0], c[1], c[2], plane.xDir, n[0], n[1], n[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = size / 2;
  return (
    <PlaneGroup plane={shown}>
      <mesh renderOrder={3} raycast={() => {}}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial color="#3ea6ff" transparent opacity={0.16} depthWrite={false} side={DoubleSide} toneMapped={false} />
      </mesh>
      <Line
        points={[
          [-h, -h, 0],
          [h, -h, 0],
          [h, h, 0],
          [-h, h, 0],
          [-h, -h, 0],
        ]}
        color="#3ea6ff"
        lineWidth={1.5}
        renderOrder={4}
      />
    </PlaneGroup>
  );
}
