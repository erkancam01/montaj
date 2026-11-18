import { Grid } from '@react-three/drei';
import { DoubleSide } from 'three';
import { useAssembly } from '../../store/useAssembly';
import { noRaycast } from './sceneRefs';

/**
 * XY düzleminde sonsuz ızgara. drei Grid'i XZ düzleminde çizer (position.xzy);
 * X ekseni etrafında +90° döndürünce düzlem normali +Z olur.
 */
export function SceneGrid() {
  const cell = useAssembly((s) => s.gridCell);
  return (
    <Grid
      rotation={[Math.PI / 2, 0, 0]}
      args={[2, 2]}
      infiniteGrid
      followCamera
      cellSize={cell}
      sectionSize={cell * 10}
      fadeDistance={cell * 400}
      fadeStrength={1.5}
      cellThickness={0.6}
      sectionThickness={1}
      cellColor="#363c45"
      sectionColor="#525c6b"
      side={DoubleSide}
      raycast={noRaycast}
    />
  );
}
