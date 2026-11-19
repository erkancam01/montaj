// Temel çizim düzlemleri (gövde-yerel; sahne Z-yukarı)
import type { PlaneDef } from '@/core/types';

export const BASE_PLANES: Record<'XY' | 'XZ' | 'YZ', PlaneDef> = {
  XY: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
};
