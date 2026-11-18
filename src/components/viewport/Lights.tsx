import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3, type DirectionalLight } from 'three';

/** Hemisfer + ortam + kamerayı takip eden yönlü ışık (ağdan HDR yüklenmez) */
export function Lights() {
  const dir = useRef<DirectionalLight>(null);

  useFrame(({ camera, controls }) => {
    const light = dir.current;
    if (!light) return;
    light.position.copy(camera.position);
    const t = (controls as unknown as { target?: unknown } | null)?.target;
    if (t instanceof Vector3) light.target.position.copy(t);
    light.target.updateMatrixWorld();
  });

  return (
    <>
      <hemisphereLight args={['#ffffff', '#3a3f47', 0.9]} position={[0, 0, 1]} />
      <ambientLight intensity={0.35} />
      <directionalLight ref={dir} intensity={1.8} />
    </>
  );
}
