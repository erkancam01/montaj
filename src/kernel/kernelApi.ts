// STUB — çekirdek ajanı gerçekleyecek (replicad, Web Worker). Dışa aktarılan imzalar sözleşmedir.
import type { Body, EdgeSig, Transform } from '../types';

/** Gövdenin tessellation'ı (gövde-yerel, mm). Yapı ParsedMesh ile uyumlu. */
export interface BodyMesh {
  position: Float32Array;
  normal: Float32Array;
  index: Uint32Array;
  /** B-rep yüz başına üçgen aralığı (first..last dahil) */
  faces: { first: number; last: number }[];
  /** B-rep kenarları: LineSegments köşeleri, kenar başına parça aralığı ve imza */
  edges: { position: Float32Array; ranges: { first: number; last: number }[]; sigs: EdgeSig[] };
}

export interface BodyBuildResult {
  /** Katı yoksa (yalnız sketch'ler) null */
  mesh: BodyMesh | null;
  /** featureId → hata (Türkçe). Hatalı özellik atlanır, sonrakiler denenir. */
  featureErrors: Record<string, string>;
}

/** Gövdeyi özellik geçmişinden yeniden üretir. Bastırılmış (suppressed) özellikler atlanır. */
export async function buildBody(_body: Body): Promise<BodyBuildResult> {
  return { mesh: null, featureErrors: {} };
}

/** Çekirdeği arka planda önceden yükler (modelleme moduna girince çağrılır) */
export function warmupKernel(): void {}

/** STEP'e yazılacak montaj öğesi */
export type ExportItem =
  | {
      kind: 'body';
      name: string;
      /** sRGB #rrggbb ya da null */
      color: string | null;
      body: Body;
      /** gövde-yerel → dünya */
      world: Transform;
    }
  | {
      kind: 'import';
      name: string;
      color: string | null;
      fileId: string;
      fileName: string;
      /**
       * Parçanın kaynak dosyadaki kimliği: occt-import-js düğümünün dosya koordinatındaki
       * bounding box merkezi ve boyutu. Çekirdek, STEP'i B-rep olarak okuyup bu kutuya uyan katıyı bulur.
       */
      nodeCenter: [number, number, number];
      nodeSize: [number, number, number];
      /** dosya koordinatı → dünya ( = partWorld ∘ öteleme(-nodeCenter) ) */
      world: Transform;
    };

/**
 * Montajı tek bir STEP dosyası olarak dışa aktarır (mm).
 * blobs: fileId → orijinal STEP dosyası (import öğeleri için).
 * Eşleşmeyen import parçaları atlanır; uyarılar döner.
 */
export async function exportAssemblySTEP(
  _items: ExportItem[],
  _blobs: Record<string, Blob>,
): Promise<{ blob: Blob; warnings: string[] }> {
  return { blob: new Blob(), warnings: ['Çekirdek henüz hazır değil'] };
}
