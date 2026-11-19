import { useCallback } from 'react';
import type { Object3D } from 'three';
import { objectRegistry } from '@/ui/viewport/registry';

/** Nesneyi id ile objectRegistry'ye kaydeden ref callback (unmount'ta siler) */
export function useRegistryRef<T extends Object3D>(id: string) {
  return useCallback(
    (obj: T | null) => {
      if (!obj) return;
      objectRegistry.set(id, obj);
      return () => {
        if (objectRegistry.get(id) === obj) objectRegistry.delete(id);
      };
    },
    [id],
  );
}
