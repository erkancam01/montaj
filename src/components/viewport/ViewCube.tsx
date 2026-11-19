// Görünüm küpü (sağ alt): yüze tıkla = standart görünüm, kenar/köşeye tıkla = ara (eğik) görünüm.
// drei GizmoViewcube Y-yukarı varsayar; sahne Z-yukarı olduğundan küp X ekseni etrafında +90° döndürülür:
// böylece yüz yazıları dik durur ve sıralama [Sağ, Sol, Üst, Alt, Ön, Arka] doğru yüzlere düşer.
import { GizmoHelper, GizmoViewcube } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { Euler, Quaternion, Vector3 } from 'three';
import { useEffect } from 'react';
import { viewFromDirection } from '../../lib/viewCommands';
import { setViewCubeMargin } from './sceneRefs';

const ROT = new Euler(Math.PI / 2, 0, 0);
const FACES = ['SAĞ', 'SOL', 'ÜST', 'ALT', 'ÖN', 'ARKA'];
const noRaycast = () => null;

function onCubeClick(e: ThreeEvent<MouseEvent>): null {
  e.stopPropagation();
  // Kenar/köşe parçaları küp merkezinden uzakta konumlanır; yüz tıklamasında yüz normali kullanılır
  const local = e.object.position.lengthSq() > 1e-6 ? e.object.position.clone() : e.face?.normal.clone();
  if (!local) return null;
  viewFromDirection(local.applyEuler(ROT));
  return null;
}

export function ViewCube({ narrow }: { narrow: boolean }) {
  const m = narrow ? 66 : 92;
  const s = narrow ? 1.05 : 1.45;
  useEffect(() => {
    setViewCubeMargin(m);
    return () => setViewCubeMargin(0);
  }, [m]);
  return (
    <GizmoHelper alignment="bottom-right" margin={[m, m]}>
      <group scale={s}>
        <group rotation={ROT}>
          <GizmoViewcube
            faces={FACES}
            color="#3a4250"
            hoverColor="#6b9bff"
            textColor="#f1f4f8"
            strokeColor="#9aa6b5"
            opacity={0.97}
            font="bold 26px Segoe UI, Inter, Arial, sans-serif"
            onClick={onCubeClick}
          />
        </group>
        <Axes />
      </group>
    </GizmoHelper>
  );
}

const AXES: [Vector3, string][] = [
  [new Vector3(1, 0, 0), '#e5484d'],
  [new Vector3(0, 1, 0), '#30a46c'],
  [new Vector3(0, 0, 1), '#3e7bfa'],
];
const LEN = 1.45;

/** Küpün sol-ön-alt köşesinden çıkan renkli eksenler (X kırmızı, Y yeşil, Z mavi; dünya, Z-yukarı) */
function Axes() {
  return (
    // GizmoViewcube küpü kendi içinde 60 kat ölçeklenir; eksenler aynı ölçekte
    <group position={[-30, -30, -30]} scale={60}>
      {AXES.map(([d, c], i) => (
        <mesh
          key={i}
          position={d.clone().multiplyScalar(LEN / 2)}
          quaternion={new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d)}
          raycast={noRaycast}
          renderOrder={10}
        >
          <cylinderGeometry args={[0.03, 0.03, LEN, 8]} />
          <meshBasicMaterial color={c} toneMapped={false} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}
