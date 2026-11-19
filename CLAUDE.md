# STEP Montaj — proje notları (Claude için)

Tarayıcıda çalışan, sunucusuz STEP montaj + parametrik parça modelleme uygulaması. Kullanıcı Türkçe konuşur,
yıllarca SolidWorks 2022 kullanmıştır: arayüz ve davranış kararlarında SolidWorks alışkanlıkları esas alınır
(birebir kopya değil; SolidWorks adı/logo/ikonları kullanılmaz).

## Çalıştırma
- `npm install` (postinstall `scripts/copy-occt.mjs` occt-import-js dosyalarını `public/`'e kopyalar)
- `npm run dev` → http://localhost:5173 (`.claude/launch.json`: "step-montaj")
- `npm run build` (tsc + vite build) · `npx tsc --noEmit -p .` · `npm run test:mates` (mate çözücü testleri) · `npm run test:origins` (yüz kökeni / topolojik ad testleri)

## Yığın
Vite 8, React 19, TypeScript, three r187, @react-three/fiber 9, drei 10, zustand 5, idb-keyval, jszip,
occt-import-js (STEP okuma, `public/` altında klasik worker), replicad + replicad-opencascadejs (modelleme
çekirdeği, ~22 MB wasm, modül worker, tembel yüklenir), @salusoft89/planegcs (sketch kısıt çözücü).
Sahne Z-yukarı (`src/setup.ts`), birim mm. Proje tarayıcıda IndexedDB'de otomatik saklanır; taşımak için
"Projeyi kaydet (.zip)".

## Mimari (önemli dosyalar)
- `src/types.ts`, `src/modeling/types.ts`: Doc { files, instances, parts, mates, groups, bodies }.
  Instance (dünya dönüşümü) → Part (instance'a göre yerel). `Part.fixed` = sabit (f).
- `src/store/useAssembly.ts`: zustand; commit → pruneBodies/cleanupGroups → mate çözümü. updateLive (canlı sürükleme).
- `src/lib/mateSolver.ts`: gövde bazlı Gauss–Seidel; sabit parçalar hiç taşınmaz; sürüklenen gövde "held".
  `src/lib/dof.ts` serbestlik, `src/lib/partStatus.ts` (f)/(-) işaretleri.
- `src/lib/rigid.ts`: rijit gruplar. `src/lib/faceGeometry.ts`: yüz tanıma (düzlem/silindir).
- `src/modeling/`: actions (gövde/sketch/özellik oturumları), bodyManager (çekirdekte yeniden üretim, yüz
  kökeni + imzayla yeniden eşleme; faceOrigin = topolojik ad: özellik+sketch eğrisi/kapak, faceMatch), externalRefs/refLocks (başka parçalardan canlı projeksiyon, bağlı gövde kilidi).
- `src/kernel/`: replicad worker (build, mesh, STEP export). `src/sketch/`: planegcs çözücü, bölgeler, oturum.
- Arayüz: `src/components/Toolbar.tsx` (sekmeli komut çubuğu), `src/components/command/` (komut paneli, onay
  köşesi, bağlam kutusu, sağ tık ve S menüsü), `PartTree.tsx` (tek tasarım ağacı),
  `viewport/CadControls.ts` (SolidWorks fare şeması), `viewport/DragController.tsx` (sol-sürükle taşı,
  sağ-sürükle döndür, mate'e göre kısıtlı), `src/lib/viewCommands.ts` + `hooks/useViewShortcuts.ts` (Ctrl+1…8, Space).

- Parametreler: `src/lib/expr.ts` (güvenli ifade değerlendirici), `src/modeling/params.ts` (applyParameters: her
  commit'te ifadeli sketch ölçüleri `SkConstraint.expr`, özellik alanları `Feature.exprs`, mate `offsetExpr/angleExpr`
  hesaplanır; değişen sketch başsız çözülür), `src/components/params/` (ParamsDialog, ExprField). `npm run test:expr`.
  Model parametreleri: ölçülerde `SkConstraint.name`, özellik alanlarında `Feature.pnames` (assignModelNames her
  commit'te d1, d2… atar); `modelParams(doc)`, `allParamLikes(doc)` (kullanıcı + model adları tek ifade grafiği),
  `updateModelParam` (tablodan değişiklik; ölçüde sketch hemen çözülür).

## Çalışma kuralları
- Kullanıcı her şeyin tek sohbette yürümesini istiyor: ayrı Claude oturumu açma; paralel iş gerekiyorsa bu
  sohbetin içinden alt ajan (Agent, worktree izolasyonu) kullan, sonra birleştir.
- Değişiklikten sonra `npx tsc --noEmit -p .` + önizleme tarayıcısında dene.
- Commit mesajını PowerShell'de dosyadan ver (`git commit -F dosya`); Türkçe karakter/tırnaklar komut satırında bozuluyor.
- Kullanıcının STEP dosyalarını (ör. `*.STEP` kökte) git'e ekleme.

## Bilinen eksikler / sıradaki fikirler
- Sketch: trim, teğet yay, spline yok.
- Sabite bağlı zincirde uçtaki parça sürüklenince aradaki serbest parça birlikte gelmiyor.
- Ctrl+1…8 normal Chrome sekmesinde tarayıcı tarafından yakalanabilir (Space menüsü yedek).
- `invertWheel` ayarı kalıcı değil.
