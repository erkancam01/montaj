# Kod yapısı

Kaynak kod dört katmana ayrılmıştır. Her katman yalnız **kendinden aşağıdakileri** kullanabilir:

```
ui        → ekran (React bileşenleri, stiller, simgeler, fare/dokunmatik)
  ↓
services  → dış dünya (modelleme çekirdeği worker'ı, STEP okuma/yazma, kayıt, dışa aktarma)
  ↓
state     → uygulama durumu (zustand store) ve onu değiştiren eylemler
  ↓
core      → saf hesap (tipler, matematik, mate çözücü, sketch çözücü, özellik tanımları) — React yok
```

`app/` uygulamayı başlatır (ana bileşen, kısayollar). `main.tsx` giriş noktasıdır.
Import'lar `@/` ile yazılır (`@/core/...`, `@/ui/...`): dosya taşınsa da diğer dosyalar etkilenmez.

## Klasörler

| Klasör | İçerik |
|---|---|
| `src/app/` | `App.tsx` (sayfa düzeni), `useShortcuts.ts` (montaj kısayolları), `setup.ts` |
| `src/core/types/` | Tüm veri tipleri: `index.ts` (Doc, Instance, Part, Mate, Group…), `modeling.ts` (sketch, özellikler, parametreler) |
| `src/core/features/registry.ts` | **Özellik tanımları** (ad, simge, varsayılanlar, parametre alanları, bağımlılık, araç çubuğu sırası) |
| `src/core/math/` | Dönüşüm matematiği (`math.ts`), ifade değerlendirici (`expr.ts`) |
| `src/core/assembly/` | Mate çözücü, mate tip kuralları, rijit gruplar, serbestlik derecesi |
| `src/core/geometry/` | Yüz tanıma (düzlem/silindir), geometri önbelleği |
| `src/core/modeling/` | Parametreler (`params.ts`), yüz kökeni / eşleme, dış referanslar, temel düzlemler, gövdenin ayrı katıları → montaj parçaları (`bodyParts.ts`) |
| `src/core/import/` | Dış dosya okuyucuları (saf): `dxf.ts` (DXF → 2B eğri, yerleşim, temizlik → sketch varlıkları) |
| `src/core/sketch/` | Sketch kısıt çözücü (planegcs), kapalı bölge bulma, 2B geometri |
| `src/state/` | Store (`useAssembly.ts`), montaj eylemleri, modelleme eylemleri, sketch oturumu, parça durumu |
| `src/services/kernel/` | Modelleme çekirdeği (replicad/OpenCascade worker): katı üretimi, mesh, STEP yazma |
| `src/services/io/` | STEP okuma, proje kaydı (IndexedDB / .zip), dışa aktarma, dosya indirme |
| `src/services/bodyManager.ts` | Çizilen parçaları değişince çekirdekte yeniden üretir, mate yüzlerini yeniden bulur |
| `src/ui/theme/` | **Tema**: `tokens.css` (tüm renk/boyut değişkenleri), `styles.css` (genel stiller) |
| `src/ui/shell/` | Ana iskelet: menü çubuğu (`MenuBar`), üst komut çubuğu (`Toolbar`, kipe göre sekmeler), sol ağaç (`PartTree`: montaj ağacı / parça kipi unsur ağacı), sağ panel (seçim yoksa gizli), Yeni / Yardım pencereleri, yol işareti, dosya işlemleri (`fileActions`) |
| `src/ui/commands/` | Komut eylemleri, sağ tık / S menüsü / bağlam kutusu, onay köşesi, klavye komutları |
| `src/ui/icons/` | Tüm simgeler |
| `src/ui/viewport/` | 3B sahne: kamera (fare şeması), parça çizimi, gizmo, sürükleme, görünüm küpü |
| `src/ui/sketch/` | Sketch çizim araçları, sketch katmanı, ölçü etiketleri |
| `src/ui/modeling/` | Özellik formları (`FeatureInspector.tsx`), özellik ağacı, sahneden yüz/kenar seçme |
| `src/ui/assembly/` | Mate ve grup panelleri |
| `src/ui/params/` | Parametreler penceresi, ifade alanı |
| `src/ui/library/` | Tasarım kütüphanesi paneli (sağ kenar), sahneye sürükle-bırak |
| `src/ui/mobile/` | Telefon düzeni (çekmeceler, alt sayfa) — `mobile.css` en son yüklenir |

## Neyi değiştirmek için nereye bakılır

| Yapmak istediğin | Dosya |
|---|---|
| Arayüz renkleri, kenar yarıçapı, satır yüksekliği | `src/ui/theme/tokens.css` |
| 3B sahnedeki sketch çizgi renkleri | `src/ui/sketch/SketchLayer.tsx` (`SK_COLORS`) |
| Görünüm küpü | `src/ui/viewport/ViewCube.tsx` |
| Üst komut çubuğu, sekmeler, düğmeler | `src/ui/shell/Toolbar.tsx` |
| Sağ tık / S menüsü / bağlam kutusu girdileri | `src/ui/commands/menus.ts` |
| Menü çubuğu girdileri (Dosya · Düzenle · …) | `src/ui/shell/MenuBar.tsx` |
| Önce seç sonra komut (Sketch düzlemi, profil sketch'i), Yeni parça | `src/ui/commands/commands.ts` (`sketchCommand`, `preferredSketch`, `newPart`); seçim durumu `commandStore.ts` (`plane`, `face`, `sketchSel`) |
| Mate tür kutusu (imleç yanında) | `src/ui/assembly/MatePopup.tsx` |
| Bir özelliğin adı, varsayılan değerleri, tabloda görünen alanları, araç çubuğu açıklaması | `src/core/features/registry.ts` |
| Bir özelliğin ayar formu | `src/ui/modeling/FeatureInspector.tsx` |
| Bir özelliğin geometrisi (katı nasıl üretilir) | `src/services/kernel/build.ts` |
| Mate tipleri ve çözümü | `src/core/assembly/mateMeta.ts`, `mateSolver.ts` |
| Sketch araçları (çizgi, daire…) ve yakalama | `src/ui/sketch/tools.ts` |
| Sketch ilişkileri / ölçüleri (çözücü) | `src/core/sketch/solverCore.ts` |
| Parametre ifadeleri (birimler, fonksiyonlar) | `src/core/math/expr.ts` |
| Fare ve dokunmatik kamera kontrolü | `src/ui/viewport/CadControls.ts` |
| Parçayı fareyle döndürme / taşıma (sol / sağ sürükle) | `src/ui/viewport/DragController.tsx` |
| Bir gövdenin ayrı katılarının montajda ayrı parça olması ("Sonucu birleştir") | `src/services/kernel/build.ts` (`applyOp`), `src/core/modeling/bodyParts.ts` |
| Klavye kısayolları | `src/app/useShortcuts.ts`, `src/ui/hooks/useViewShortcuts.ts`, `src/ui/commands/useCommandKeys.ts` |
| Telefon düzeni | `src/ui/mobile/mobile.css`, `MobileDock.tsx` |
| Proje kaydı / açma | `src/services/io/session.ts`, `persistence.ts` |
| DXF içe aktarma (okuma / temizlik) | `src/core/import/dxf.ts` · pencere: `src/ui/sketch/DxfImportDialog.tsx` |
| Süpür geometrisi (yol zinciri, profil yerleşimi, köşeler) | `src/services/kernel/build.ts` (`doSweep`, `pathChain`) |
| Parça kütüphanesi (kayıt, klasör, küçük resim, .zip) | `src/services/io/library.ts`, `libraryThumb.ts` · durum `src/state/libraryStore.ts` · panel `src/ui/library/LibraryPanel.tsx` |
| STEP okuma / yazma | `src/services/io/stepLoader.ts`, `src/services/kernel/exportStep.ts` |

### Yeni özellik eklemek (ör. "Kabuk")

1. `src/core/types/modeling.ts` → tip (`ShellFeature`) ve `Feature` birleşimine ekle.
2. `src/core/features/registry.ts` → ad, simge, varsayılanlar, parametre alanları, bağımlılık; araç çubuğunda
   görünecekse `FEATURE_TOOLS`'a satır.
3. `src/services/kernel/build.ts` → geometri üretimi.
4. `src/ui/modeling/FeatureInspector.tsx` → ayar formu. (Simge yeni ise `src/ui/icons/featureIcons.tsx`.)

Araç çubuğu, menüler, ağaç, parametre tablosu ve silme/sıralama kuralları kayıt defterinden otomatik gelir.

## Testler

`npm run test:expr` (ifadeler) · `npm run test:mates` (mate çözücü) · `npm run test:origins` (yüz kökeni) ·
`npm run test:dxf` (DXF okuma; örnek dosya `scripts/fixtures/ornek-profil.dxf`) ·
`npx tsc --noEmit -p .` · `npm run build`
