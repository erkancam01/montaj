// Ayrıştırılmış CAD geometrisinin bellek içi önbelleği (kaydedilmez, açılışta STEP'ten yeniden üretilir).
import { EdgesGeometry, type BufferGeometry } from 'three';
import type { Vec3 } from '../types';

export interface ParsedMesh {
  /** Parça merkezine göre ötelenmiş (merkez = 0,0,0) geometri */
  geometry: BufferGeometry;
  /** sRGB 0..1, yoksa null */
  color: [number, number, number] | null;
  /** geometry'de 'color' (yüz renkleri, lineer) özniteliği var mı */
  hasVertexColors: boolean;
  /**
   * B-rep yüzeyleri: her biri geometrideki üçgen indeks aralığı (first..last, ikisi de dahil).
   * Üçgen t'nin köşeleri: index[3t..3t+2] (index yoksa 3t..3t+2).
   */
  faces: { first: number; last: number }[];
  /** getEdges() ile tembel üretilir */
  edges?: BufferGeometry;
}

export interface ParsedNode {
  /** nodes dizisindeki indeks (Part.nodeKey) */
  key: number;
  name: string;
  /** Üst montaj adları (kök → ebeveyn) */
  path: string[];
  /** Dosya koordinatında parça bounding box merkezi */
  center: Vec3;
  size: Vec3;
  meshes: ParsedMesh[];
}

export interface ParsedFile {
  nodes: ParsedNode[];
  /** Dosya koordinatında tüm dosyanın bounding box merkezi */
  center: Vec3;
  size: Vec3;
}

const cache = new Map<string, ParsedFile>();

export const geometryCache = {
  get: (fileId: string) => cache.get(fileId),
  set: (fileId: string, f: ParsedFile) => void cache.set(fileId, f),
  delete: (fileId: string) => void cache.delete(fileId),
  clear: () => cache.clear(),
};

export function getEdges(mesh: ParsedMesh): BufferGeometry {
  if (!mesh.edges) mesh.edges = new EdgesGeometry(mesh.geometry, 25);
  return mesh.edges;
}
