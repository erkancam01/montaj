import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DoubleSide, LessEqualDepth, Mesh, MeshBasicMaterial } from 'three';
import { faceHighlightGeometry, getFaceGeom } from '@/core/geometry/faceGeometry';
import { geometryCache } from '@/core/geometry/geometryCache';
import { objectRegistry } from '@/ui/viewport/registry';
import { pickableFace } from '@/ui/modeling/pick';
import { useAssembly, type AssemblyState } from '@/state/useAssembly';
import type { FaceGeom, FaceRef } from '@/core/types';
import { noRaycast } from '@/ui/viewport/sceneRefs';

const GREEN = '#30a46c';
const ORANGE = '#f5a524';
const RED = '#e5484d';
const HOVER_COLORS: Record<FaceGeom['kind'], string> = { plane: '#3ea6ff', cylinder: ORANGE, other: RED };

const HOVER_OPACITY = 0.35;
const PICK_BLUE = '#3ea6ff';
const PICK_BAD_OPACITY = 0.18;
const PENDING_OPACITY = 0.6;
const MATE_OPACITY = 0.5;

interface HighlightSpec extends FaceRef {
  key: string;
  color: string;
  opacity: number;
}

/**
 * Çizilecek yüzey vurguları; seçici her store değişiminde çalıştığı için JSON dizgesi döner
 * (dizge aynıysa bileşen yeniden render olmaz). Öncelik: referans yüzey > imleç > seçili mate.
 */
function highlightKey(s: AssemblyState): string {
  const out: HighlightSpec[] = [];
  const push = (ref: FaceRef | null | undefined, color: string, opacity: number) => {
    if (!ref) return;
    const key = `${ref.partId}/${ref.meshIndex}/${ref.faceIndex}`;
    if (out.some((h) => h.key === key)) return;
    out.push({ key, partId: ref.partId, meshIndex: ref.meshIndex, faceIndex: ref.faceIndex, color, opacity });
  };

  push(s.pendingFace, GREEN, PENDING_OPACITY);

  // Modelleme yüzey seçim isteği: seçilenler yeşil, imleçteki uygunsa mavi, değilse soluk kırmızı
  const pick = s.modeling.pick;
  if (pick && pick.kinds.includes('face') && !s.modeling.sketch) {
    for (const t of pick.picked) if (t.kind === 'face') push(t.ref, GREEN, PENDING_OPACITY);
    const h = s.hoverFace;
    if (h) push(h, pickableFace(pick, h) ? PICK_BLUE : RED, pickableFace(pick, h) ? HOVER_OPACITY : PICK_BAD_OPACITY);
  }

  const hover = s.ui.tool === 'mate' ? s.hoverFace : null;
  if (hover) {
    const part = s.doc.parts.find((p) => p.id === hover.partId);
    const g = part ? getFaceGeom(part, hover.meshIndex, hover.faceIndex) : null;
    if (g) push(hover, HOVER_COLORS[g.kind], HOVER_OPACITY);
  }

  const mate = s.mateSelection ? s.doc.mates.find((m) => m.id === s.mateSelection) : undefined;
  if (mate) {
    push(mate.a, GREEN, MATE_OPACITY);
    push(mate.b, s.mateStatus[mate.id]?.state === 'error' ? RED : ORANGE, MATE_OPACITY);
  }

  return out.length ? JSON.stringify(out) : '';
}

/** Renk/opaklık başına tek paylaşılan materyal (dispose edilmez, birkaç kombinasyon var) */
const materials = new Map<string, MeshBasicMaterial>();
function overlayMaterial(color: string, opacity: number): MeshBasicMaterial {
  const k = `${color}/${opacity}`;
  let m = materials.get(k);
  if (!m) {
    m = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: DoubleSide,
      depthWrite: false,
      depthFunc: LessEqualDepth,
      // Parça materyali +1 ile geri itiliyor; örtü öne çekilir → z-fighting yok, arkadaki yüzler yine gizli
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });
    materials.set(k, m);
  }
  return m;
}

/** Seçili mate'in yüzeyleri, mate aracındaki referans yüzey ve imlecin altındaki yüzey */
export function FaceHighlights() {
  const key = useAssembly(highlightKey);
  const specs = useMemo<HighlightSpec[]>(() => (key ? (JSON.parse(key) as HighlightSpec[]) : []), [key]);
  return (
    <>
      {specs.map((h) => (
        <FaceOverlay
          key={h.key}
          partId={h.partId}
          meshIndex={h.meshIndex}
          faceIndex={h.faceIndex}
          color={h.color}
          opacity={h.opacity}
        />
      ))}
    </>
  );
}

interface FaceOverlayProps extends FaceRef {
  color: string;
  opacity: number;
}

/**
 * Yüzeyin üstüne yarı saydam örtü. Geometri parça-yerel olduğundan parça grubunun
 * (objectRegistry) çocuğu olarak imperatif eklenir; parça taşınınca birlikte hareket eder.
 * Grup yeniden oluşursa (geri alma, dosya yeniden yükleme) her karede kontrol edilip yeni gruba taşınır.
 */
const FaceOverlay = memo(function FaceOverlay({ partId, meshIndex, faceIndex, color, opacity }: FaceOverlayProps) {
  const fileId = useAssembly((s) => s.doc.parts.find((p) => p.id === partId)?.fileId);
  const nodeKey = useAssembly((s) => s.doc.parts.find((p) => p.id === partId)?.nodeKey);
  const ready = useAssembly((s) => (fileId ? s.fileStatus[fileId]?.status === 'ready' : false));

  const geometry = useMemo(() => {
    if (!ready || fileId === undefined || nodeKey === undefined) return null;
    const mesh = geometryCache.get(fileId)?.nodes[nodeKey]?.meshes[meshIndex];
    return mesh ? faceHighlightGeometry(mesh, faceIndex) : null;
  }, [ready, fileId, nodeKey, meshIndex, faceIndex]);

  const [overlay] = useState(() => {
    const m = new Mesh();
    m.name = 'Yüzey vurgusu';
    m.raycast = noRaycast;
    m.renderOrder = 1;
    m.userData.noExport = true;
    return m;
  });

  useLayoutEffect(() => {
    if (geometry) overlay.geometry = geometry;
    overlay.material = overlayMaterial(color, opacity);
  }, [overlay, geometry, color, opacity]);

  useEffect(() => () => void overlay.removeFromParent(), [overlay]);

  // Geometri paylaşılan önbellekten gelir (faceGeometry yönetir); burada dispose edilmez.
  useFrame(() => {
    const group = geometry ? (objectRegistry.get(partId) ?? null) : null;
    if (overlay.parent === group) return;
    overlay.removeFromParent();
    group?.add(overlay);
  });

  return null;
});

/** Mate aracında imleç bir yüzeyin üstündeyken artı imleci */
export function MateCursor() {
  const el = useThree((s) => s.gl.domElement);
  const active = useAssembly(
    (s) => (s.ui.tool === 'mate' || !!s.modeling.pick?.kinds.includes('face')) && s.hoverFace !== null && !s.modeling.sketch,
  );
  useEffect(() => {
    if (!active) return;
    el.style.cursor = 'crosshair';
    return () => {
      el.style.cursor = '';
    };
  }, [el, active]);
  return null;
}
