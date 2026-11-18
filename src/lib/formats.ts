import type { CadFormat } from '../types';

export const CAD_EXTENSIONS = ['.step', '.stp', '.iges', '.igs', '.brep', '.brp'];
/** Dosya seçici accept değeri (CAD + proje zip) */
export const ACCEPT_ATTR = [...CAD_EXTENSIONS, '.zip'].join(',');

export function formatFromName(name: string): CadFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith('.step') || n.endsWith('.stp')) return 'step';
  if (n.endsWith('.iges') || n.endsWith('.igs')) return 'iges';
  if (n.endsWith('.brep') || n.endsWith('.brp')) return 'brep';
  return null;
}

export const isProjectZip = (name: string) => name.toLowerCase().endsWith('.zip');
