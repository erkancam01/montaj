import { memo, useCallback } from 'react';
import type { Group } from 'three';
import { useShallow } from 'zustand/react/shallow';
import { useAssembly } from '../../store/useAssembly';
import type { Instance } from '../../types';
import { PartNode } from './PartNode';
import { sceneRefs } from './sceneRefs';
import { useRegistryRef } from './useRegistryRef';
import { ScenePointer } from '../command/ScenePointer';

/** Belgedeki tüm instance'lar; kök grup sceneRefs.root'ta tutulur */
export function SceneContent() {
  const instances = useAssembly((s) => s.doc.instances);
  const rootRef = useCallback((g: Group | null) => {
    if (!g) return;
    sceneRefs.root = g;
    return () => {
      if (sceneRefs.root === g) sceneRefs.root = null;
    };
  }, []);

  return (
    <group ref={rootRef} name="Montaj">
      {instances.map((inst) => (
        <InstanceNode key={inst.id} inst={inst} />
      ))}
      <ScenePointer />
    </group>
  );
}

const InstanceNode = memo(function InstanceNode({ inst }: { inst: Instance }) {
  const ref = useRegistryRef<Group>(inst.id);
  const ready = useAssembly((s) => s.fileStatus[inst.fileId]?.status === 'ready');
  // Parça nesneleri yalnızca değiştiklerinde yeni referans alır → sığ karşılaştırma yeterli
  const parts = useAssembly(useShallow((s) => s.doc.parts.filter((p) => p.instanceId === inst.id)));

  return (
    <group ref={ref} name={inst.name} position={inst.position} quaternion={inst.quaternion} visible={inst.visible}>
      {ready && parts.map((p) => <PartNode key={p.id} part={p} instanceVisible={inst.visible} />)}
    </group>
  );
});
