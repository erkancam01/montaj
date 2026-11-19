// Ortak veri tipleri. Tüm birimler milimetre, sahne Z-yukarı.

export type Vec3 = [number, number, number];
/** Three.js sırası: [x, y, z, w] */
export type Quat = [number, number, number, number];

export interface Transform {
  position: Vec3;
  quaternion: Quat;
}

/** Yüklenen kaynak CAD dosyası. Blob'u IndexedDB'de `file:<id>` anahtarıyla durur. */
export interface SourceFileMeta {
  id: string;
  name: string;
  size: number;
}

/**
 * Bir kaynak dosyanın sahnedeki örneği (üst seviye grup).
 * position/quaternion dünya koordinatındadır. Pivot = dosyanın bounding box merkezi.
 */
export interface Instance extends Transform {
  id: string;
  fileId: string;
  name: string;
  /** "Sıfırla" için ilk dönüşüm */
  origin: Transform;
  visible: boolean;
}

/**
 * Bir örneğin içindeki, mesh taşıyan STEP düğümü.
 * position/quaternion, ebeveyn Instance'a göre yereldir. Pivot = parçanın bounding box merkezi.
 * nodeKey = geometryCache'teki ParsedFile.nodes indeksi.
 */
export interface Part extends Transform {
  id: string;
  instanceId: string;
  fileId: string;
  nodeKey: number;
  name: string;
  origin: Transform;
  visible: boolean;
  /** Kullanıcı rengi (#rrggbb). null = STEP'teki renk. */
  color: string | null;
  /**
   * Sabit parça: mate çözücü ve fareyle/gizmoyla taşıma onu hiç hareket ettirmez.
   * Gruptaki bir üye sabitse grubun tamamı sabittir. Eski kayıtlarda yoktur: normalizeDoc ilk instance'ı sabitler.
   */
  fixed?: boolean;
}

/** Kaydedilen/geri alınabilen proje belgesi. */
export interface Doc {
  files: SourceFileMeta[];
  instances: Instance[];
  parts: Part[];
  /** Eski kayıtlarda olmayabilir; store.replaceDoc boş diziyle tamamlar. */
  mates: Mate[];
  /** Rijit gruplar. Eski kayıtlarda olmayabilir; store.replaceDoc boş diziyle tamamlar. */
  groups: Group[];
  /** Uygulamada çizilen parametrik gövdeler. Eski kayıtlarda olmayabilir; replaceDoc boş diziyle tamamlar. */
  bodies: Body[];
  /** Kullanıcı parametreleri (Parametreler tablosu). Eski kayıtlarda yok. */
  parameters?: Param[];
}

import type { Body, Param } from './modeling/types';
export * from './modeling/types';

// ---------------------------------------------------------------- Rijit gruplar

/**
 * Tek gövde gibi davranan parça kümesi (farklı dosyalardan da olabilir).
 * Bir parça en fazla bir grupta olur; grupta en az 2 parça bulunur.
 * Grup, gizmoyla ya da bir mate tarafından taşınınca tüm üyeler aynı dünya dönüşümüyle (rijit) taşınır.
 * Grup çerçevesi (pivot) ayrıca saklanmaz; ilk üyeye (anchor = partIds[0]) bağlıdır:
 *   grupDünya = partWorld(anchor) ∘ frame
 */
export interface Group {
  id: string;
  name: string;
  partIds: string[];
  /** Grup çerçevesi, anchor parçanın yerel koordinatında */
  frame: Transform;
}

// ---------------------------------------------------------------- Mate'ler

export type MateType = 'coincident' | 'concentric' | 'parallel' | 'perpendicular' | 'angle';

/**
 * Bir parçanın tek bir B-rep yüzeyi.
 * meshIndex = ParsedNode.meshes indeksi, faceIndex = ParsedMesh.faces indeksi.
 */
export interface FaceRef {
  partId: string;
  meshIndex: number;
  faceIndex: number;
  /**
   * Parametrik gövde yüzeylerinde: yüzeyin parça-yerel geometrisi (oluşturma anındaki).
   * Gövde yeniden üretilince indeksler değişebilir; bodyManager bu imzayla en uygun yüzü bulup
   * meshIndex/faceIndex'i günceller.
   */
  sig?: FaceGeom;
  /** sig ile birlikte: yüzey alanı (mm²); benzer yönlü yüzler arasında doğru olanı seçmek için */
  sigArea?: number;
}

/**
 * Kalıcı mate. Varsayılan: a = referans (yerinde kalır), b = hareketli. Çözücü sabit parçalar, sürüklenen
 * (tutulan) gövde ve sabite olan mate uzaklığına göre yönü tersine çevirebilir (bkz. mateSolver).
 *
 * Yön kuralları (d = düzlemde dış normal, silindirde eksen):
 * - coincident: flip=false → n_b = -n_a (yüzler karşı karşıya), flip=true → n_b = +n_a.
 *   Konum: (p_b - p_a)·n_a = offset (mm). Sadece düzlem–düzlem.
 * - concentric: eksenler aynı doğru üzerinde. flip=false → d_b = +d_a, true → -d_a. Sadece silindir–silindir.
 * - parallel: flip=false → d_b = +d_a, true → -d_a. Konum serbest.
 * - perpendicular: d_b ⟂ d_a. flip etkisiz. Konum serbest.
 * - angle: d_a ile d_b arası açı = angle (derece); flip=true → 180 - angle. Konum serbest.
 */
export interface Mate {
  id: string;
  name: string;
  type: MateType;
  a: FaceRef;
  b: FaceRef;
  /** mm, yalnızca coincident */
  offset: number;
  /** derece, yalnızca angle */
  angle: number;
  /** offset / angle ifadeleri (parametre tablosuna bağlı) */
  offsetExpr?: string;
  angleExpr?: string;
  flip: boolean;
  /** Bastırılmış mate çözülmez */
  suppressed: boolean;
}

/** Bir yüzeyin tanınan geometrisi (parça-yerel ya da dünya koordinatında). Vektörler birim uzunlukta. */
export type FaceGeom =
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  | { kind: 'cylinder'; point: Vec3; axis: Vec3; radius: number }
  | { kind: 'other' };

export interface MateStatus {
  /** ok: sağlandı · error: çelişkili/döngü · pending: geometri henüz yüklenmedi · suppressed: bastırılmış */
  state: 'ok' | 'error' | 'pending' | 'suppressed';
  message?: string;
}

/** Dönüşümü doğrudan saklanan nesne türleri */
export type ObjKind = 'instance' | 'part';
export type SelKind = ObjKind | 'group';
export type Selection = { kind: SelKind; id: string } | null;
/** Ctrl/Shift+tık ile birincil seçime eklenen öğeler (yalnız parça ya da grup) */
export type ExtraSel = { kind: 'part' | 'group'; id: string };

export type CadFormat = 'step' | 'iges' | 'brep';

export interface FileStatus {
  status: 'loading' | 'ready' | 'error';
  error?: string;
}

export interface Job {
  id: string;
  name: string;
  status: 'loading' | 'error';
  error?: string;
}

export interface UiState {
  mode: 'translate' | 'rotate';
  space: 'world' | 'local';
  snap: boolean;
  /** mm */
  snapMove: number;
  /** derece */
  snapAngle: number;
  /** Sahnede tıklayınca parça mı, tüm dosya örneği mi seçilsin (gruptaki parça → grup seçilir) */
  selectMode: ObjKind;
  showEdges: boolean;
  /** select: normal seçim/gizmo · mate: yüzey seçerek mate kurma */
  tool: 'select' | 'mate';
  /** Fare tekerleği yakınlaştırma yönünü ters çevir (SolidWorks: ileri = uzaklaş) */
  invertWheel: boolean;
}
