# STEP Montaj — proje notları (Claude için)

Tarayıcıda çalışan, sunucusuz STEP montaj + parametrik parça modelleme uygulaması. Kullanıcı Türkçe konuşur,
yıllarca SolidWorks 2022 kullanmıştır: arayüz ve davranış kararlarında SolidWorks alışkanlıkları esas alınır
(birebir kopya değil; SolidWorks adı/logo/ikonları kullanılmaz).

## Çalıştırma
- `npm install` (postinstall `scripts/copy-occt.mjs` occt-import-js dosyalarını `public/`'e kopyalar)
- `npm run dev` → http://localhost:5173 (`.claude/launch.json`: "step-montaj")
- `npm run build` (tsc + vite build) · `npx tsc --noEmit -p .` · `npm run test:expr` · `npm run test:mates` · `npm run test:origins` · `npm run test:dxf`

## Yığın
Vite 8, React 19, TypeScript, three r187, @react-three/fiber 9, drei 10, zustand 5, idb-keyval, jszip,
occt-import-js (STEP okuma, `public/` altında klasik worker), replicad + replicad-opencascadejs (modelleme
çekirdeği, ~22 MB wasm, modül worker, tembel yüklenir), @salusoft89/planegcs (sketch kısıt çözücü).
Sahne Z-yukarı (`src/app/setup.ts`), birim mm. Proje tarayıcıda IndexedDB'de otomatik saklanır; taşımak için
"Projeyi kaydet (.zip)".

## Mimari
Katmanlar ve "neyi nerede değiştiririm" tablosu: **`ARCHITECTURE.md`** (önce onu oku). Özet:
`core` (saf hesap, React yok) ← `state` (zustand store + eylemler) ← `services` (çekirdek worker, IO, bodyManager) ←
`ui` (React). Bir katman yalnız altındakileri import eder; import'lar `@/` ile (`@/core/...`). Yeni dosya eklerken
doğru katmana koy; `core` içine React/store/ui, `state`/`services` içine ui import'u girmemeli.

- Veri modeli `src/core/types/` (Doc { files, instances, parts, mates, groups, bodies, parameters }).
  Instance (dünya dönüşümü) → Part (instance'a göre yerel). `Part.fixed` = sabit (f).
- Özellik tanımları TEK yerde: `src/core/features/registry.ts` (ad, simge, varsayılanlar, parametre alanları,
  bağımlılık, araç çubuğu sırası). Geometri: `src/services/kernel/build.ts`; form: `src/ui/modeling/FeatureInspector.tsx`.
- Tema TEK yerde: `src/ui/theme/tokens.css` (CSS değişkenleri). Yeni stil yazarken sabit renk değil `var(--…)` kullan.
- Store `src/state/useAssembly.ts`: commit → pruneBodies/cleanupGroups → applyParameters → mate çözümü; updateLive.
- Mate çözücü `src/core/assembly/mateSolver.ts` (gövde bazlı Gauss–Seidel; sabitler hiç taşınmaz; sürüklenen "held").
- Parametreler: `src/core/math/expr.ts` (ifade), `src/core/modeling/params.ts` (applyParameters, model parametreleri
  d1, d2… = `SkConstraint.name` / `Feature.pnames`; `modelParams`, `allParamLikes`, `updateModelParam`),
  arayüz `src/ui/params/`.
- Yüz kökeni (topolojik ad) `src/core/modeling/faceOrigin.ts` + `faceMatch.ts`; yeniden eşleme `src/services/bodyManager.ts`.

## Çalışma kuralları
- Kullanıcı her şeyin tek sohbette yürümesini istiyor: ayrı Claude oturumu açma; paralel iş gerekiyorsa bu
  sohbetin içinden alt ajan (Agent, worktree izolasyonu) kullan, sonra birleştir.
- Değişiklikten sonra `npx tsc --noEmit -p .` + önizleme tarayıcısında dene.
- Commit mesajını PowerShell'de dosyadan ver (`git commit -F dosya`); Türkçe karakter/tırnaklar komut satırında bozuluyor.
- Kullanıcının STEP dosyalarını (ör. `*.STEP` kökte) git'e ekleme.

## Bilinen eksikler / sıradaki fikirler
- Sketch: trim, teğet yay, spline yok (DXF spline/elips kısa çizgilerle yaklaşık gelir).
- DXF ile gelen profil sabit geometridir (ext): taşımak için silip yeniden içe aktar. DWG okunmuyor.
- Süpür: yol tek düzlemsel sketch zinciri. Düz kenarlı yol + gönyeli köşe → `miterBars` (kenar başına çıta,
  açıortaydan kesim); yay içeren ya da yuvarlak köşeli yol → OCC pipe shell. Kesim listesi yok.
- Bölge bulma (`core/sketch/profiles.ts`): köprü kenarlar atılır, kendine değen döngüler bölünür, dolu/boş
  komşu yüzlerde dönüşümlü (tek-çift kuralı). Geçersiz delikli yüzde kernel `regionSolid` katı Boolean'a düşer.
- Sabite bağlı zincirde uçtaki parça sürüklenince aradaki serbest parça birlikte gelmiyor.
- Gövdenin ek katıları (ayrı parçalar) montajda taşınmışsa, gövde düzenlenirken sketch'ler asıl parçanın
  çerçevesinde kalır; ek katı yeniden oluşursa (ör. önizlemede "Sonucu birleştir" açılıp kapanınca) konumu/mate'leri sıfırlanır.
- Ctrl+1…8 normal Chrome sekmesinde tarayıcı tarafından yakalanabilir (Space menüsü yedek).
- `invertWheel` ayarı kalıcı değil.
