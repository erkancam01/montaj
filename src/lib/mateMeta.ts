// Mate tipleri hakkında ortak bilgi: etiketler, uyumluluk, varsayılan tip.
import type { FaceGeom, MateType } from '../types';

export const MATE_TYPES: MateType[] = ['coincident', 'concentric', 'parallel', 'perpendicular', 'angle'];

export const MATE_LABELS: Record<MateType, string> = {
  coincident: 'Çakışık',
  concentric: 'Eşmerkezli',
  parallel: 'Paralel',
  perpendicular: 'Dik',
  angle: 'Açı',
};

export const MATE_HINTS: Record<MateType, string> = {
  coincident: 'İki düz yüzey karşı karşıya oturur (mesafe ile boşluk verilebilir).',
  concentric: 'İki silindirik yüzey aynı eksene gelir (delik–mil).',
  parallel: 'Yüzey normalleri / eksenler paralel olur, konum serbest kalır.',
  perpendicular: 'Yüzey normalleri / eksenler birbirine dik olur, konum serbest kalır.',
  angle: 'Yüzey normalleri / eksenler arasında belirli bir açı olur.',
};

export const FACE_KIND_LABELS: Record<FaceGeom['kind'], string> = {
  plane: 'Düzlem',
  cylinder: 'Silindir',
  other: 'Desteklenmeyen yüzey',
};

const directional = (g: FaceGeom) => g.kind === 'plane' || g.kind === 'cylinder';

/** Bu iki yüzey arasında bu tip mate kurulabilir mi */
export function mateCompatible(type: MateType, a: FaceGeom, b: FaceGeom): boolean {
  switch (type) {
    case 'coincident':
      return a.kind === 'plane' && b.kind === 'plane';
    case 'concentric':
      return a.kind === 'cylinder' && b.kind === 'cylinder';
    default:
      return directional(a) && directional(b);
  }
}

export function compatibleTypes(a: FaceGeom, b: FaceGeom): MateType[] {
  return MATE_TYPES.filter((t) => mateCompatible(t, a, b));
}

/** Yeni mate için varsayılan tip; uygun değilse null */
export function suggestMateType(a: FaceGeom, b: FaceGeom): MateType | null {
  if (a.kind === 'plane' && b.kind === 'plane') return 'coincident';
  if (a.kind === 'cylinder' && b.kind === 'cylinder') return 'concentric';
  if (directional(a) && directional(b)) return 'parallel';
  return null;
}
