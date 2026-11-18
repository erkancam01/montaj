// STUB — sketch çözücü ajanı gerçekleyecek (planegcs). Dışa aktarılan imzalar sözleşmedir.
import type { SkConstraint, SkConstraintType, SkEntity } from '../types';

export interface SketchSolveResult {
  /** Çözülmüş varlıklar (nokta konumları, yarıçaplar güncel). Çözülemezse giriş aynen döner. */
  entities: SkEntity[];
  /** ok: çözüldü · failed: çözülemedi */
  status: 'ok' | 'failed';
  /** Kalan serbestlik derecesi (0 = tam tanımlı) */
  dof: number;
  /** Çelişen kısıt id'leri */
  conflicting: string[];
  /** Gereksiz (fazla) kısıt id'leri */
  redundant: string[];
}

/** planegcs wasm'ını yükler (bir kez). Diğer fonksiyonlar bundan sonra senkron çalışır. */
export async function initSketchSolver(): Promise<void> {}

export function isSketchSolverReady(): boolean {
  return false;
}

/**
 * Sketch'i çözer. drag verilirse o nokta hedef konuma çekilir (sürükleme), diğerleri en az hareketle uyar.
 * Çözücü hazır değilse girişi aynen döndürür (status 'failed').
 */
export function solveSketch(
  entities: SkEntity[],
  constraints: SkConstraint[],
  _opts?: { drag?: { pointId: string; x: number; y: number } },
): SketchSolveResult {
  return { entities, status: 'failed', dof: -1, conflicting: [], redundant: [] };
}

/** Seçili varlıklara uygulanabilecek ilişki/ölçü tipleri (araç çubuğu için) */
export function applicableConstraints(_selected: SkEntity[]): SkConstraintType[] {
  return [];
}

/** Ölçü kısıtı için mevcut geometriden ölçülen değer (yeni ölçü eklerken varsayılan) */
export function measureConstraint(_type: SkConstraintType, _refs: string[], _entities: SkEntity[]): number | null {
  return null;
}

export const CONSTRAINT_LABELS: Partial<Record<SkConstraintType, string>> = {};
