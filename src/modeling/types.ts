// ================================================================ Parametrik modelleme tipleri
//
// Uygulamada çizilen parçalar "gövde" (Body) olarak saklanır. Her gövdenin montajda bir Instance'ı
// (fileId = bodyFileId(body.id)) ve tek bir Part'ı (nodeKey 0, yerel dönüşüm = birim) vardır; yerleşim
// Instance dönüşümüdür. Özellikler (features) gövde-yerel koordinatta tanımlıdır, birim mm.
// Gövde geometrisi her özellik değişiminde çekirdekte (replicad, Web Worker) yeniden üretilir ve
// geometryCache'e fileId = bodyFileId(id) ile ParsedFile olarak yazılır
// (tek node, key 0, center [0,0,0], geometri ÖTELENMEZ: mesh koordinatı = gövde-yerel koordinat).
import type { FaceRef, Vec3 } from '../types';

/** Gövde-yerel düzlem. xDir ve normal birim ve dik; yDir = normal × xDir. */
export interface PlaneDef {
  origin: Vec3;
  xDir: Vec3;
  normal: Vec3;
}

export type Vec2 = [number, number];

// ---------------------------------------------------------------- Sketch

export interface SkPoint {
  id: string;
  kind: 'point';
  x: number;
  y: number;
  /** Bir eğrinin uç/merkez noktası değil, bağımsız (yardımcı) nokta */
  standalone?: boolean;
  /** Projeksiyonla gelen (dış referans) geometri: SkProjection id. Çözücüde sabittir. */
  ext?: string;
}
export interface SkLine {
  id: string;
  kind: 'line';
  p1: string;
  p2: string;
  construction?: boolean;
  /** Projeksiyonla gelen (dış referans) geometri: SkProjection id */
  ext?: string;
}
export interface SkCircle {
  id: string;
  kind: 'circle';
  /** merkez nokta id */
  c: string;
  r: number;
  construction?: boolean;
  /** Projeksiyonla gelen (dış referans) geometri: SkProjection id */
  ext?: string;
}
/** Merkez c etrafında start'tan end'e SAAT YÖNÜ TERSİNE (ccw) yay. start/end/c nokta id'leri. */
export interface SkArc {
  id: string;
  kind: 'arc';
  c: string;
  start: string;
  end: string;
  r: number;
  construction?: boolean;
  /** Projeksiyonla gelen (dış referans) geometri: SkProjection id */
  ext?: string;
}
export type SkEntity = SkPoint | SkLine | SkCircle | SkArc;
export type SkCurve = SkLine | SkCircle | SkArc;

export type SkConstraintType =
  | 'coincident' // [nokta, nokta]
  | 'horizontal' // [çizgi] ya da [nokta, nokta]
  | 'vertical' // [çizgi] ya da [nokta, nokta]
  | 'parallel' // [çizgi, çizgi]
  | 'perpendicular' // [çizgi, çizgi]
  | 'equal' // [çizgi, çizgi] uzunluk ya da [daire/yay, daire/yay] yarıçap
  | 'tangent' // [çizgi|yay|daire, yay|daire]
  | 'fix' // [nokta]
  | 'pointOnLine' // [nokta, çizgi]
  | 'pointOnCircle' // [nokta, daire/yay]
  | 'midpoint' // [nokta, çizgi]
  | 'concentric' // [daire/yay, daire/yay]
  // --- ölçüler (value zorunlu; mm ya da derece)
  | 'distance' // [nokta, nokta] · [nokta, çizgi] · [çizgi] (uzunluk)
  | 'distanceX' // [nokta, nokta] · [nokta] (orijinden)
  | 'distanceY'
  | 'radius' // [daire/yay]
  | 'diameter' // [daire/yay]
  | 'angle'; // [çizgi, çizgi] derece

export interface SkConstraint {
  id: string;
  type: SkConstraintType;
  refs: string[];
  /** Ölçü değeri (mm / derece). Ölçü olmayanlarda yok. */
  value?: number;
  /** Ölçü etiketinin sketch-2B konumu (yalnız görsel) */
  label?: Vec2;
  /** Ölçü ifadesi (ör. "FFH - 2*KA"); value son hesaplanan değerdir */
  expr?: string;
}

// ---------------------------------------------------------------- Özellikler

interface FeatureBase {
  id: string;
  name: string;
  suppressed: boolean;
  /**
   * İfadeli sayısal alanlar: alan adı → ifade (ör. { distance: 'FFH - 40' }). Alanın kendisi her zaman
   * son hesaplanan sayıyı tutar; parametreler değişince applyParameters yeniden yazar.
   */
  exprs?: Record<string, string>;
}

// ---------------------------------------------------------------- Kullanıcı parametreleri

export type ParamUnit = 'mm' | 'deg' | 'adet' | '';

/** Parametre tablosu satırı. Değer saklanmaz: ifadeden hesaplanır (src/lib/expr.ts). */
export interface Param {
  id: string;
  name: string;
  unit: ParamUnit;
  expr: string;
  comment?: string;
  fav?: boolean;
}

/**
 * Başka bir parçaya (STEP ya da başka gövde) canlı referans. face: kaynak yüz (gövde kaynaklarında sig ile
 * yeniden eşlenir). edge: gövde kaynağında tek B-rep kenarı (imzasıyla eşlenir).
 */
export interface ExtRef {
  face?: FaceRef;
  edge?: { partId: string; sig: EdgeSig };
}

/** Sketch'e projeksiyonla aktarılan dış geometri. entityIds: üretilen eğri ve noktalar (sıralı). */
export interface SkProjection {
  id: string;
  source: ExtRef;
  entityIds: string[];
  /** Son yeniden hesaplamada kaynak bulunamadı ya da şekil uyuşmadı; son değerler korunuyor */
  broken?: boolean;
  /** Sabit kopya: kaynak izlenmez (gövdenin kendi yüzü ya da "Bağlantıyı kopar" sonrası) */
  frozen?: boolean;
}

/** Sketch orijini (0,0) = plane.origin; sketch x ekseni = plane.xDir */
export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  plane: PlaneDef;
  entities: SkEntity[];
  constraints: SkConstraint[];
  /**
   * Düzlem başka bir parçanın yüzüne bağlı: local = kaynak parçanın yerel çerçevesindeki düzlem.
   * Her yeniden üretimde plane = gövde⁻¹ ∘ kaynakDünya ∘ local olarak yenilenir.
   */
  planeRef?: { ref: FaceRef; local: PlaneDef; broken?: boolean };
  /** Başka parçalardan projeksiyonlar (canlı) */
  projections?: SkProjection[];
}

/** add: gövdeye ekle (gövde boşsa ilk katıyı oluşturur) · cut: gövdeden çıkar */
export type BoolOp = 'add' | 'cut';

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  sketchId: string;
  /**
   * Hangi kapalı bölgeler: her nokta (sketch-2B) içine düştüğü en küçük bölgeyi seçer.
   * Boş dizi = çift derinlikli tüm bölgeler (dış konturlar delikleriyle + adacıklar).
   */
  profilePoints: Vec2[];
  /** oneSide: normal yönünde distance · symmetric: iki yöne distance/2 · twoSides: normal yönünde distance, ters yönde distance2 */
  extent: 'oneSide' | 'symmetric' | 'twoSides';
  distance: number;
  distance2: number;
  /** oneSide/twoSides yönünü tersine çevirir */
  reverse: boolean;
  /** Tüm gövde boyunca (distance yok sayılır; reverse/symmetric dikkate alınır) */
  throughAll: boolean;
  operation: BoolOp;
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  sketchId: string;
  profilePoints: Vec2[];
  /** Eksen: sketch'teki bir çizgi (yardımcı çizgi olabilir) */
  axisLineId: string;
  /** derece, (0, 360] */
  angle: number;
  reverse: boolean;
  operation: BoolOp;
}

/** Bir B-rep kenarının geometrik imzası (gövde-yerel). Yeniden üretimde en yakın kenarla eşleşir. */
export interface EdgeSig {
  kind: 'line' | 'circle' | 'other';
  /** kenar üzerindeki orta nokta */
  mid: Vec3;
  length: number;
  /** line: yön (birim) */
  dir?: Vec3;
  /** circle: merkez, eksen (birim), yarıçap */
  center?: Vec3;
  axis?: Vec3;
  radius?: number;
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  edges: EdgeSig[];
  radius: number;
}
export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  edges: EdgeSig[];
  distance: number;
}

export interface HoleFeature extends FeatureBase {
  type: 'hole';
  /** Delik açılan yüzeyin düzlemi; normal malzemeden DIŞARI bakar, delik -normal yönünde açılır */
  plane: PlaneDef;
  /** Delik merkezleri (düzlem-2B) */
  points: Vec2[];
  holeType: 'simple' | 'counterbore' | 'countersink';
  diameter: number;
  depth: number;
  throughAll: boolean;
  /** havşa başı (counterbore) */
  cbDiameter: number;
  cbDepth: number;
  /** havşa (countersink) */
  csDiameter: number;
  /** derece (ör. 90) */
  csAngle: number;
}

/** Desen/ayna: listedeki özelliklerin "araç" katılarını (extrude/revolve/hole) dönüştürüp aynı işlemle tekrar uygular */
export interface LinearPatternFeature extends FeatureBase {
  type: 'linearPattern';
  featureIds: string[];
  dir1: Vec3;
  count1: number;
  spacing1: number;
  /** count2 > 1 ise ikinci yön */
  dir2: Vec3;
  count2: number;
  spacing2: number;
}
export interface CircularPatternFeature extends FeatureBase {
  type: 'circularPattern';
  featureIds: string[];
  axisOrigin: Vec3;
  axisDir: Vec3;
  count: number;
  /** toplam açı (derece); 360 ise kopyalar eşit aralıklı */
  angle: number;
}
/** featureIds boşsa o ana kadarki tüm gövde aynalanıp birleştirilir */
export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  featureIds: string[];
  plane: PlaneDef;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | HoleFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature;
export type FeatureType = Feature['type'];

export interface Body {
  id: string;
  name: string;
  /** Sıralı özellik geçmişi */
  features: Feature[];
}

/** Gövdenin montajdaki sanal dosya kimliği */
export const bodyFileId = (bodyId: string) => `body:${bodyId}`;
export const isBodyFileId = (fileId: string) => fileId.startsWith('body:');
export const bodyIdOfFile = (fileId: string) => fileId.slice(5);

/** Yeniden üretim durumu (kaydedilmez) */
export interface BodyBuildStatus {
  state: 'building' | 'ok' | 'error';
  /** featureId → hata mesajı */
  featureErrors: Record<string, string>;
  message?: string;
}

/** Modelleme modunda sahnede seçilebilen hedefler */
export type PickTarget =
  | { kind: 'face'; ref: FaceRef }
  | { kind: 'edge'; partId: string; edgeIndex: number; sig: EdgeSig };

/**
 * Özellik paneli sahneden seçim isteyince store.modeling.pick dolar; sahne yalnız uygun hedefleri
 * seçtirir ve seçilenleri picked'e ekler (multi=false ise yerine koyar). İsteği açan bileşen picked'i okur.
 */
export interface PickRequest {
  /** İsteği tanımlayan anahtar (ör. 'fillet-edges', 'sketch-plane') */
  key: string;
  kinds: ('face' | 'edge')[];
  /** face: 'plane' | 'cylinder' · edge: 'line' | 'circle' süzgeci */
  filter?: ('plane' | 'cylinder' | 'line' | 'circle')[];
  /** Yalnız bu gövdenin hedefleri (ör. radyus kenarları) */
  bodyId?: string;
  multi: boolean;
  prompt: string;
  picked: PickTarget[];
}

/** Sketch düzenleme oturumu: taslak geçmişe yazılmaz; bitirince özelliğe işlenir */
export interface SketchSession {
  bodyId: string;
  featureId: string;
  isNew: boolean;
  data: SketchFeature;
}

/** Özellik oluşturma/düzenleme oturumu: taslak canlı önizlenir; Uygula ile geçmişe yazılır */
export interface FeatureSession {
  bodyId: string;
  isNew: boolean;
  draft: Feature;
}

export interface ModelingState {
  /** Özellik ağacı gösterilen (düzenlenen) gövde */
  activeBodyId: string | null;
  sketch: SketchSession | null;
  feature: FeatureSession | null;
  pick: PickRequest | null;
  /** bodyId → yeniden üretim durumu */
  build: Record<string, BodyBuildStatus>;
}
