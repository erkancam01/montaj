import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { Color, DoubleSide, LineBasicMaterial, MeshStandardMaterial, SRGBColorSpace, type Group } from 'three';
import { faceAtTriangle } from '../../lib/faceGeometry';
import { geometryCache, getEdges, type ParsedMesh } from '../../lib/geometryCache';
import { clickPart, pickFace } from '../../store/actions';
import { withFaceSig } from '../../modeling/bodyManager';
import { pickableFace } from '../../modeling/pick';
import { useAssembly, type AssemblyState } from '../../store/useAssembly';
import type { FaceRef, Part } from '../../types';
import { gizmoBusy, noRaycast } from './sceneRefs';
import { useRegistryRef } from './useRegistryRef';

const DEFAULT_COLOR = '#c9ced6';
const HIGHLIGHT = new Color('#2f6fed');
const BLACK = new Color(0x000000);
const HIGHLIGHT_INTENSITY = 0.45;

/** Tüm kenar çizgileri tek materyali paylaşır (dispose edilmez) */
const EDGE_MATERIAL = new LineBasicMaterial({ color: '#14171c' });

/** Parça mesh'lerinin userData'sı: tıklanan üçgenden FaceRef çıkarmak için */
interface MeshIdentity {
  partId: string;
  meshIndex: number;
}

/** Olaydaki üçgenin B-rep yüzeyi; tanınmazsa null */
function faceRefOf<E extends MouseEvent>(e: ThreeEvent<E>, meshes: ParsedMesh[] | undefined): FaceRef | null {
  const id = e.object.userData as Partial<MeshIdentity>;
  if (typeof id.partId !== 'string' || typeof id.meshIndex !== 'number') return null;
  const mesh = meshes?.[id.meshIndex];
  const tri = e.faceIndex;
  if (!mesh || tri == null || tri < 0) return null;
  const faceIndex = faceAtTriangle(mesh, tri);
  return faceIndex >= 0 ? { partId: id.partId, meshIndex: id.meshIndex, faceIndex } : null;
}

/** Seçim öğesi (parça / instance / grup) bu parçayı kapsıyor mu */
function covers(s: AssemblyState, item: { kind: string; id: string }, partId: string, instanceId: string): boolean {
  if (item.kind === 'part') return item.id === partId;
  if (item.kind === 'instance') return item.id === instanceId;
  if (item.kind === 'group') return !!s.doc.groups.find((g) => g.id === item.id)?.partIds.includes(partId);
  return false;
}

/**
 * Parça seçili vurgusu alır mı: birincil seçim ya da ek seçimlerden biri onu kapsıyorsa
 * (rigid.selectedPartIds ile aynı kural, tüm listeyi kurmadan).
 */
function isHighlighted(s: AssemblyState, partId: string, instanceId: string): boolean {
  const sel = s.selection;
  if (!sel) return false;
  if (covers(s, sel, partId, instanceId)) return true;
  return s.extraSel.some((e) => covers(s, e, partId, instanceId));
}

const sameFace = (x: FaceRef | null, y: FaceRef | null) =>
  x === y || (!!x && !!y && x.partId === y.partId && x.meshIndex === y.meshIndex && x.faceIndex === y.faceIndex);

function makeMaterial(m: ParsedMesh, color: string | null): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    metalness: 0.15,
    roughness: 0.55,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  if (color) {
    mat.color.set(color);
  } else if (m.hasVertexColors) {
    mat.vertexColors = true;
    mat.color.set(0xffffff);
  } else if (m.color) {
    mat.color.setRGB(m.color[0], m.color[1], m.color[2], SRGBColorSpace);
  } else {
    mat.color.set(DEFAULT_COLOR);
  }
  return mat;
}

interface PartNodeProps {
  part: Part;
  /** Ebeveyn instance görünür mü */
  instanceVisible: boolean;
}

/** Parça grubu: dönüşüm + registry kaydı. Görünmezse mesh'ler hiç render edilmez. */
export const PartNode = memo(function PartNode({ part, instanceVisible }: PartNodeProps) {
  const ref = useRegistryRef<Group>(part.id);
  const show = instanceVisible && part.visible;
  return (
    <group ref={ref} name={part.name} position={part.position} quaternion={part.quaternion} visible={part.visible}>
      {show && (
        <PartMeshes
          partId={part.id}
          instanceId={part.instanceId}
          fileId={part.fileId}
          nodeKey={part.nodeKey}
          color={part.color}
        />
      )}
    </group>
  );
});

interface PartMeshesProps {
  partId: string;
  instanceId: string;
  fileId: string;
  nodeKey: number;
  color: string | null;
}

/** Yalnızca ilkel prop'lar alır: sürükleme sırasında (dönüşüm değişince) yeniden render olmaz */
const PartMeshes = memo(function PartMeshes({ partId, instanceId, fileId, nodeKey, color }: PartMeshesProps) {
  const meshes = geometryCache.get(fileId)?.nodes[nodeKey]?.meshes;
  // Boolean seçici: yalnızca bu parçanın seçili/değil durumu değişince render olur
  const highlighted = useAssembly((s) => isHighlighted(s, partId, instanceId));
  const showEdges = useAssembly((s) => s.ui.showEdges);
  // Hover işleyicileri yalnızca mate aracında bağlanır: aksi hâlde R3F her fare hareketinde raycast yapardı
  // Yüzey hover'ı: mate aracında ya da modelleme yüzey seçim isteğinde
  const mateTool = useAssembly((s) => s.ui.tool === 'mate' || !!s.modeling.pick?.kinds.includes('face'));

  const materials = useMemo(() => (meshes ?? []).map((m) => makeMaterial(m, color)), [meshes, color]);
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  useLayoutEffect(() => {
    for (const m of materials) {
      m.emissive.copy(highlighted ? HIGHLIGHT : BLACK);
      m.emissiveIntensity = highlighted ? HIGHLIGHT_INTENSITY : 0;
    }
  }, [materials, highlighted]);

  const identities = useMemo<MeshIdentity[]>(
    () => (meshes ?? []).map((_, meshIndex) => ({ partId, meshIndex })),
    [meshes, partId],
  );

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > 4) return; // orbit sürüklemesi
      e.stopPropagation();
      if (gizmoBusy()) return;
      const st = useAssembly.getState();
      // Sketch oturumunda tıklamalar sketch katmanına aittir
      if (st.modeling.sketch) return;
      const pick = st.modeling.pick;
      if (pick) {
        // Modelleme seçim isteği: yalnız uygun yüzeyler seçilir; parça seçilmez
        if (pick.kinds.includes('face')) {
          const ref = faceRefOf(e, meshes);
          if (ref && pickableFace(pick, ref)) st.addPicked({ kind: 'face', ref: withFaceSig(ref) });
        }
        return;
      }
      if (st.ui.tool === 'mate') {
        // Mate aracında parça seçilmez; yüzey tanınmazsa tıklama etkisiz
        const ref = faceRefOf(e, meshes);
        if (ref) pickFace(ref);
        return;
      }
      // Grup / instance / selectMode kuralları clickPart'ta; Ctrl/Cmd/Shift ek seçime ekler/çıkarır
      const n = e.nativeEvent;
      clickPart(partId, { additive: n.ctrlKey || n.metaKey || n.shiftKey });
    },
    [partId, meshes],
  );

  const onPointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation(); // yalnızca en öndeki yüzey
      const st = useAssembly.getState();
      if (st.ui.tool !== 'mate' && !st.modeling.pick?.kinds.includes('face')) return;
      const ref = faceRefOf(e, meshes);
      if (!sameFace(ref, st.hoverFace)) st.setHoverFace(ref);
    },
    [meshes],
  );

  const onPointerOut = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const st = useAssembly.getState();
      const h = st.hoverFace;
      const id = e.object.userData as Partial<MeshIdentity>;
      if (h && h.partId === partId && h.meshIndex === id.meshIndex) st.setHoverFace(null);
    },
    [partId],
  );

  // Parça gizlenir/silinirse üstündeki hover'ı bırak
  useEffect(
    () => () => {
      const st = useAssembly.getState();
      if (st.hoverFace?.partId === partId) st.setHoverFace(null);
    },
    [partId],
  );

  if (!meshes) return null;
  return (
    <>
      {meshes.map((m, i) => (
        <Fragment key={i}>
          <mesh
            geometry={m.geometry}
            material={materials[i]}
            userData={identities[i]}
            onClick={onClick}
            onPointerMove={mateTool ? onPointerMove : undefined}
            onPointerOut={mateTool ? onPointerOut : undefined}
            dispose={null}
          />
          {showEdges && <lineSegments geometry={getEdges(m)} material={EDGE_MATERIAL} raycast={noRaycast} dispose={null} />}
        </Fragment>
      ))}
    </>
  );
});
