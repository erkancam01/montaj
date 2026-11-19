// Temel düzlemler (Ön / Üst / Sağ) sahnede: parça kipinde ağaçta seçilen düzlem vurgulanır; Sketch komutu düzlem
// beklerken üçü de yarı saydam ve tıklanabilir gösterilir. Düzlemler gövde-yerel (parçanın çerçevesinde).
import { Html, Line } from '@react-three/drei';
import { useMemo, useState } from 'react';
import { DoubleSide, Matrix4, Quaternion, Vector3 } from 'three';
import { useShallow } from 'zustand/react/shallow';
import { BASE_PLANES } from '@/core/modeling/planes';
import { bodyFrame } from '@/state/modelingActions';
import { useAssembly } from '@/state/useAssembly';
import { pickBasePlane } from '@/ui/commands/commands';
import { useCommandUi, type BasePlaneKey } from '@/ui/commands/commandStore';
import { sceneSphere } from '@/ui/viewport/viewCommands';

export const PLANE_LABELS: Record<BasePlaneKey, string> = { XZ: 'Ön', XY: 'Üst', YZ: 'Sağ' };
const KEYS: BasePlaneKey[] = ['XZ', 'XY', 'YZ'];
const FILL = '#4a8af4';
const SEL = '#ffb547';

/** Düzlemin dönüşü: yerel XY → düzlem (x = xDir, z = normal) */
function planeQuat(k: BasePlaneKey): Quaternion {
  const p = BASE_PLANES[k];
  const x = new Vector3(...p.xDir);
  const z = new Vector3(...p.normal);
  const y = z.clone().cross(x);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

export function BasePlanes() {
  const { partMode, bodyId, sketchOpen, featureOpen } = useAssembly(useShallow((s) => ({
    partMode: !!s.modeling.activeBodyId,
    bodyId: s.modeling.activeBodyId,
    sketchOpen: !!s.modeling.sketch,
    featureOpen: !!s.modeling.feature,
  })));
  // Gövde taşınınca düzlemler de gelsin
  useAssembly((s) => (bodyId ? s.doc.instances.find((i) => i.fileId === `body:${bodyId}`)?.position.join(',') : ''));
  const plane = useCommandUi((s) => s.plane);
  const picking = useCommandUi((s) => s.planePick);
  const showAll = useCommandUi((s) => s.showPlanes);
  const [hover, setHover] = useState<BasePlaneKey | null>(null);
  const docKey = useAssembly((s) => s.doc.parts.length);

  // Boyut: sahnenin sınır küresine göre (boş sahnede 100 mm)
  const size = useMemo(() => {
    const sp = sceneSphere();
    return Math.max(60, Math.min(2000, sp ? sp.radius * 0.6 : 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, picking, partMode]);

  if (sketchOpen || featureOpen) return null;
  if (!picking && !(partMode && (showAll || plane))) return null;
  const frame = bodyId ? bodyFrame(bodyId) : null;
  const shown = picking || showAll ? KEYS : KEYS.filter((k) => k === plane);
  const h = size / 2;
  const edge: [number, number, number][] = [
    [-h, -h, 0],
    [h, -h, 0],
    [h, h, 0],
    [-h, h, 0],
    [-h, -h, 0],
  ];

  return (
    <group position={frame?.position ?? [0, 0, 0]} quaternion={frame?.quaternion ?? [0, 0, 0, 1]}>
      {shown.map((k) => {
        const sel = plane === k || hover === k;
        return (
          <group key={k} quaternion={planeQuat(k)}>
            <mesh
              renderOrder={5}
              onPointerOver={
                picking
                  ? (e) => {
                      e.stopPropagation();
                      setHover(k);
                    }
                  : undefined
              }
              onPointerOut={picking ? () => setHover((x) => (x === k ? null : x)) : undefined}
              onClick={
                picking
                  ? (e) => {
                      e.stopPropagation();
                      setHover(null);
                      pickBasePlane(k);
                    }
                  : undefined
              }
              raycast={picking ? undefined : () => null}
            >
              <planeGeometry args={[size, size]} />
              <meshBasicMaterial color={sel ? SEL : FILL} transparent opacity={sel ? 0.14 : 0.07} side={DoubleSide} depthWrite={false} />
            </mesh>
            <Line points={edge} color={sel ? SEL : FILL} lineWidth={sel ? 2 : 1} transparent opacity={0.85} depthWrite={false} />
            <Html position={[-h, h, 0]} style={{ pointerEvents: 'none' }} zIndexRange={[5, 0]}>
              <span className={`plane-label ${sel ? 'sel' : ''}`}>{PLANE_LABELS[k]}</span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
