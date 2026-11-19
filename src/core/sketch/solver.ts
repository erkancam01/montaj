// Sketch kısıt çözücü (planegcs = FreeCAD GCS, wasm). Dışa aktarılan imzalar sözleşmedir.
// Asıl gerçekleme ./solver/core.ts içindedir (Node'da test edilebilsin diye wasm yolu enjekte edilir).
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { SkConstraint, SkConstraintType, SkEntity } from '@/core/types';
import { LABELS, applicable, initWithPath, isReady, measure, solve } from '@/core/sketch/solverCore';

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
export async function initSketchSolver(): Promise<void> {
  await initWithPath(wasmUrl);
}

export function isSketchSolverReady(): boolean {
  return isReady();
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
  return solve(entities, constraints, _opts);
}

/** Seçili varlıklara uygulanabilecek ilişki/ölçü tipleri (araç çubuğu için) */
export function applicableConstraints(_selected: SkEntity[]): SkConstraintType[] {
  return applicable(_selected);
}

/** Ölçü kısıtı için mevcut geometriden ölçülen değer (yeni ölçü eklerken varsayılan) */
export function measureConstraint(_type: SkConstraintType, _refs: string[], _entities: SkEntity[]): number | null {
  return measure(_type, _refs, _entities);
}

export const CONSTRAINT_LABELS: Partial<Record<SkConstraintType, string>> = LABELS;
