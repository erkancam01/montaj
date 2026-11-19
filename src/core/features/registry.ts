// ================================================================ Özellik kayıt defteri
//
// Bir özellik tipinin (Extrude, Radyus, Delik…) uygulama genelindeki TÜM tanımı burada:
//   label     → ağaçta / panelde görünen ad
//   icon      → simge adı (ui/icons/featureIcons.tsx içindeki çizimin anahtarı)
//   defaults  → "yeni özellik" taslağının varsayılan değerleri
//   fields    → Parametreler tablosunda listelenen sayısal alanlar (model parametreleri d1, d2…)
//   uses      → bağlı olduğu diğer özellikler (silme / sıralama bağımlılığı)
// Araç çubuğu ve menülerdeki özellik komutları da FEATURE_TOOLS listesinden üretilir.
//
// YENİ ÖZELLİK EKLERKEN: (1) core/types/modeling.ts'e tipini ekle, (2) buraya tanımını ekle,
// (3) services/kernel/build.ts'e geometri üretimini, (4) ui/modeling/FeatureInspector.tsx'e formunu ekle.
// Başka bir yere dokunmak gerekmez.
import { BASE_PLANES } from '@/core/modeling/planes';
import type { Body, Feature, FeatureType, ParamUnit } from '@/core/types';

/** Özellik simgesi anahtarı (ui/icons/featureIcons PATHS anahtarlarıyla aynı) */
export type FeatureIconKey = FeatureType | 'cut';

/** Araç çubuğundaki özellik komutu: tipler + "Kesme" (operation: cut olan extrude) */
export type FeatureTool = Exclude<FeatureType, 'sketch'> | 'cut';

/** Komutun çalışması için gövdede gerekenler */
export type ToolNeeds = 'sketch' | 'solid' | 'sketch+solid';

export interface ParamField {
  field: string;
  label: string;
  unit: ParamUnit;
}

type FeatureOf<T extends FeatureType> = Extract<Feature, { type: T }>;
/** Taslak gövdesi: id / ad / bastırma / tip ortak alanları hariç */
type Body_<T extends FeatureType> = Omit<FeatureOf<T>, 'id' | 'name' | 'suppressed' | 'type' | 'exprs' | 'pnames'>;

interface FeatureDef<T extends FeatureType> {
  label: string;
  icon: FeatureIconKey;
  /** Varsayılan taslak (sketchId = gövdenin son sketch'i) */
  defaults?: (ctx: { sketchId: string }) => Body_<T>;
  fields: (f: FeatureOf<T>) => ParamField[];
  uses: (f: FeatureOf<T>) => string[];
}

const mm = (field: string, label: string): ParamField => ({ field, label, unit: 'mm' });
const deg = (field: string, label: string): ParamField => ({ field, label, unit: 'deg' });
const qty = (field: string, label: string): ParamField => ({ field, label, unit: 'adet' });

export const FEATURES: { [T in FeatureType]: FeatureDef<T> } = {
  sketch: {
    label: 'Sketch',
    icon: 'sketch',
    fields: () => [], // sketch ölçüleri ayrıca (her ölçü kısıtı bir model parametresidir)
    uses: () => [],
  },
  extrude: {
    label: 'Extrude',
    icon: 'extrude',
    defaults: ({ sketchId }) => ({
      sketchId,
      profilePoints: [],
      extent: 'oneSide',
      distance: 10,
      distance2: 10,
      reverse: false,
      throughAll: false,
      operation: 'add',
      merge: true,
    }),
    fields: (f) => (f.throughAll ? [] : f.extent === 'twoSides' ? [mm('distance', 'Mesafe'), mm('distance2', 'Mesafe 2')] : [mm('distance', 'Mesafe')]),
    uses: (f) => [f.sketchId],
  },
  revolve: {
    label: 'Revolve',
    icon: 'revolve',
    defaults: ({ sketchId }) => ({ sketchId, profilePoints: [], axisLineId: '', angle: 360, reverse: false, operation: 'add', merge: true }),
    fields: () => [deg('angle', 'Açı')],
    uses: (f) => [f.sketchId],
  },
  fillet: {
    label: 'Radyus',
    icon: 'fillet',
    defaults: () => ({ edges: [], radius: 2 }),
    fields: () => [mm('radius', 'Yarıçap')],
    uses: () => [],
  },
  chamfer: {
    label: 'Pah',
    icon: 'chamfer',
    defaults: () => ({ edges: [], distance: 1 }),
    fields: () => [mm('distance', 'Pah')],
    uses: () => [],
  },
  hole: {
    label: 'Delik',
    icon: 'hole',
    defaults: () => ({
      plane: BASE_PLANES.XY,
      points: [],
      holeType: 'simple',
      diameter: 6,
      depth: 10,
      throughAll: true,
      cbDiameter: 11,
      cbDepth: 6,
      csDiameter: 12,
      csAngle: 90,
    }),
    fields: (f) => {
      const out = [mm('diameter', 'Çap')];
      if (!f.throughAll) out.push(mm('depth', 'Derinlik'));
      if (f.holeType === 'counterbore') out.push(mm('cbDiameter', 'Havşa başı çapı'), mm('cbDepth', 'Havşa başı derinliği'));
      if (f.holeType === 'countersink') out.push(mm('csDiameter', 'Havşa çapı'), deg('csAngle', 'Havşa açısı'));
      return out;
    },
    uses: () => [],
  },
  linearPattern: {
    label: 'Doğrusal desen',
    icon: 'linearPattern',
    defaults: () => ({ featureIds: [], dir1: [1, 0, 0], count1: 3, spacing1: 20, dir2: [0, 1, 0], count2: 1, spacing2: 20 }),
    fields: (f) => {
      const out = [qty('count1', 'Adet 1'), mm('spacing1', 'Aralık 1')];
      if (f.count2 > 1) out.push(qty('count2', 'Adet 2'), mm('spacing2', 'Aralık 2'));
      return out;
    },
    uses: (f) => f.featureIds,
  },
  circularPattern: {
    label: 'Dairesel desen',
    icon: 'circularPattern',
    defaults: () => ({ featureIds: [], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], count: 4, angle: 360 }),
    fields: () => [qty('count', 'Adet'), deg('angle', 'Toplam açı')],
    uses: (f) => f.featureIds,
  },
  mirror: {
    label: 'Ayna',
    icon: 'mirror',
    defaults: () => ({ featureIds: [], plane: BASE_PLANES.YZ }),
    fields: () => [],
    uses: (f) => f.featureIds,
  },
};

/** Komut çubuğu sırası (araya ayırıcı: 3. ve 6. öğeden önce) */
export const FEATURE_TOOLS: { tool: FeatureTool; label: string; icon: FeatureIconKey; needs: ToolNeeds; title: string }[] = [
  { tool: 'extrude', label: 'Extrude', icon: 'extrude', needs: 'sketch', title: 'Sketch profilini doğrusal uzatarak katı ekle' },
  { tool: 'cut', label: 'Kesme', icon: 'cut', needs: 'sketch+solid', title: 'Sketch profilini uzatıp gövdeden çıkar' },
  { tool: 'revolve', label: 'Revolve', icon: 'revolve', needs: 'sketch', title: 'Sketch profilini bir eksen etrafında döndür' },
  { tool: 'fillet', label: FEATURES.fillet.label, icon: 'fillet', needs: 'solid', title: 'Seçilen kenarları yuvarlat' },
  { tool: 'chamfer', label: FEATURES.chamfer.label, icon: 'chamfer', needs: 'solid', title: 'Seçilen kenarlara pah kır' },
  { tool: 'hole', label: FEATURES.hole.label, icon: 'hole', needs: 'solid', title: 'Düz bir yüzeye delik aç' },
  { tool: 'linearPattern', label: FEATURES.linearPattern.label, icon: 'linearPattern', needs: 'solid', title: 'Özellikleri bir yön boyunca çoğalt' },
  { tool: 'circularPattern', label: FEATURES.circularPattern.label, icon: 'circularPattern', needs: 'solid', title: 'Özellikleri bir eksen etrafında çoğalt' },
  { tool: 'mirror', label: FEATURES.mirror.label, icon: 'mirror', needs: 'solid', title: 'Özellikleri ya da gövdeyi bir düzleme göre aynala' },
];

/** Tip → ad (eski kullanım; tek tek özellik için featureLabel tercih edin) */
export const FEATURE_LABELS = Object.fromEntries(Object.entries(FEATURES).map(([k, d]) => [k, d.label])) as Record<FeatureType, string>;

const def = <T extends FeatureType>(f: FeatureOf<T>) => FEATURES[f.type as T] as unknown as FeatureDef<T>;

/** Özelliğin görünen tür adı (kesme işlemi ayrı adla) */
export function featureLabel(f: { type: FeatureType; operation?: string }): string {
  if (f.type === 'extrude' && f.operation === 'cut') return 'Kesme';
  if (f.type === 'revolve' && f.operation === 'cut') return 'Revolve (kes)';
  return FEATURES[f.type].label;
}

/** Özelliğin simge anahtarı (kesme extrude'u ayrı simgeyle) */
export function featureIcon(f: { type: FeatureType; operation?: string }): FeatureIconKey {
  if (f.type === 'extrude' && f.operation === 'cut') return 'cut';
  return FEATURES[f.type].icon;
}

/** Varsayılan taslak gövdesi (id / ad / bastırma ortak alanlarını çağıran ekler) */
export function featureDefaults<T extends Exclude<FeatureType, 'sketch'>>(type: T, sketchId: string): Body_<T> & { type: T } {
  const d = FEATURES[type] as unknown as FeatureDef<T>;
  return { type, ...d.defaults!({ sketchId }) };
}

/** Parametreler tablosunda listelenen sayısal alanlar */
export function featureFields(f: Feature): ParamField[] {
  return def(f).fields(f as never);
}

/** Özelliğin doğrudan bağlı olduğu özellik id'leri */
export function featureUses(f: Feature): string[] {
  return def(f).uses(f as never).filter(Boolean);
}

/** Bir özelliğe (dolaylı da olsa) bağlı özellikler: silinince / sırası değişince etkilenenler */
export function dependentsOf(body: Body, featureId: string): string[] {
  const out = new Set<string>();
  const visit = (id: string) => {
    for (const f of body.features) {
      if (out.has(f.id) || !featureUses(f).includes(id)) continue;
      out.add(f.id);
      visit(f.id);
    }
  };
  visit(featureId);
  return [...out];
}
