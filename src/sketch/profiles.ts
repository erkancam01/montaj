// STUB — çekirdek ajanı gerçekleyecek. Saf fonksiyonlar (hem ana iş parçacığında hem worker'da kullanılır).
import type { SkEntity, Vec2 } from '../types';

export type Seg =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  /** a'dan b'ye; ccw=true saat yönü tersi. a0/a1 radyan. */
  | { kind: 'arc'; c: Vec2; r: number; a0: number; a1: number; ccw: boolean; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number };

/** Kapalı döngü: parçalar uç uca sıralı (daire tek parça) */
export interface Loop {
  segs: Seg[];
  /** işaretli alan (ccw pozitif) */
  area: number;
}

/** Kapalı bölge = dış döngü eksi doğrudan içindeki döngüler */
export interface Region {
  outer: Loop;
  holes: Loop[];
  /** iç içe derinlik (0 = en dış) */
  depth: number;
  /** bölgenin içinde kalan bir nokta */
  sample: Vec2;
  /** net alan (mm²) */
  area: number;
}

/** Yardımcı (construction) olmayan eğrilerden kapalı bölgeleri bulur. */
export function findRegions(_entities: SkEntity[]): Region[] {
  return [];
}

/** profilePoints'e göre bölge seçimi (boş → çift derinlikli tüm bölgeler) */
export function selectRegions(regions: Region[], _profilePoints: Vec2[]): Region[] {
  return regions.filter((r) => r.depth % 2 === 0);
}

/** Nokta bölgenin içinde mi (dış döngü içinde, deliklerin dışında) */
export function regionContains(_region: Region, _p: Vec2): boolean {
  return false;
}
