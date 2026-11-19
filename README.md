# STEP Montaj

Tarayıcıda çalışan, sunucusuz STEP/IGES/BREP montaj ve parametrik parça modelleme uygulaması.

## Çalıştırma

```
npm install
npm run dev
```

Tarayıcıda http://localhost:5173 adresini açın.

## Derleme

```
npm run build
```

Çıktı `dist/` klasörüne yazılır. Herhangi bir statik sunucuda barındırılabilir.
Modelleme çekirdeği (OpenCascade, ~22 MB) yalnız modellemeye ya da STEP dışa aktarmaya
ilk girildiğinde arka planda yüklenir.

## Arayüz

- Üstte menü çubuğu: **Dosya · Düzenle · Görünüm · Ekle · Araçlar · Yardım** (dar ekranda ☰). Ctrl+S kaydet (.zip),
  Ctrl+O aç, F1 yardım. **Dosya ▸ Yeni** (Ctrl+N): **Parça** ya da **Montaj**.
- Komut sekmeleri kipe göre: montajda Montaj / Sketch / Değerlendir, parça düzenlenirken Unsurlar / Sketch / Değerlendir.
- Komut açıkken ayarları solda (ağacın yerinde), onay/iptal sağ üst köşede (✓ / ✕, Enter / Esc).
- Sağ panel yalnız bir şey seçiliyken açılır.
- Önce seç, sonra komut: düzlemi ya da yüzeyi seçip **Sketch**; sketch'i seçip **Ekstrüzyon**.

## Montaj

- STEP/IGES/BREP dosyalarını pencereye sürükleyin ya da **Bileşen ekle** (Ekle ▸ Bileşen ▸ Dosyadan).
- Parçaları gizmo ile taşıyın/döndürün (W/E), **Zemine oturt** (G). Fareyle: parçaya sol basıp sürükle =
  döndür (kendi merkezi etrafında), sağ basıp sürükle = taşı; mate'li parça yalnız serbest yönlerinde hareket eder.
- **DXF içe aktar** (Sketch sekmesi, sketch açıkken): profil kesitini sabit geometri olarak sketch'e alır.
  Katman, birim, döndürme, ayna ve yerleşim seçilir; çizimde birden çok profil varsa önizlemede tıklayarak
  istenen profil seçilir. Açık uçlar birleştirilir, kesişen çizgiler bölünür, kopyalar silinir; dosyadaki birim
  ölçülere uymuyorsa mm önerilir. Dolu/boş ayrımı tek-çift kuralıyla yapılır (her çizgi metal ile havayı ayırır).
  DWG'yi önce AutoCAD'de DXF olarak kaydedin.
- **Süpür** (Unsurlar sekmesi): profil sketch'ini bir yol sketch'i (çizgi/yay zinciri) boyunca süpürür.
  "Yolun başına" yerleşimde profil otomatik yola dik konur; kapalı yolda (ör. FFB × FFH dikdörtgen) köşeleri
  gönyeli bir kasa çıkar (düz kenarlarda her kenar uzatılıp açıortaydan kesilir). Döndür 180° ile profil yolun
  içine alınır; "Sonucu birleştir" kapalıysa her çıta montajda ayrı parça olur.
- Extrude/Revolve'da **Sonucu birleştir** kapalıysa yeni katı ayrı kalır ve montajda ayrı parça olur
  (birbirine değmeyen bölgeler de ayrı parça olur).
- **Mate (M)**: önce yerinde kalacak referans yüzeye, sonra hareket edecek parçanın yüzeyine tıklayın.
  İmleç yanında tür kutusu açılır: Çakışık (+mesafe), Eşmerkezli, Paralel, Dik, Açı, Hizalamayı çevir; ✓ ekler ve
  komut açık kalır (sıradaki iki yüzey), ✕ geri alır. Komutu sol paneldeki ✓ ya da Enter bitirir.
- **Rijit grup**: Ctrl+tık ile parçaları seçip **Grupla** (Ctrl+G). Grup tek gövde gibi taşınır ve mate'lerde birlikte hareket eder.

## Parametrik modelleme

1. **Dosya ▸ Yeni ▸ Parça** (ya da Montaj sekmesinde **Yeni parça**): parça kipine girilir. Soldaki ağaçta
   **Ön / Üst / Sağ Düzlem**'i seçip **Sketch**'e basın (çift tık da olur). Seçim yoksa Sketch üç düzlemi sahnede
   gösterir; birine ya da herhangi bir düz yüzeye tıklayın.
2. **Sketch**: Çizgi (L), Dikdörtgen (R), Daire (C), Yay (A), Nokta (P), Ölçü (D), Projeksiyon (J), Yardımcı (X).
   - Çizerken sayı yazarak uzunluk/yarıçap girilebilir (Tab: ikinci değer, Enter: onay).
   - İlişkiler: seçime göre araç çubuğunda çıkar (yatay, dikey, çakışık, paralel, dik, eşit, teğet, sabit…).
   - Ölçü etiketine çift tıklayarak değeri değiştirin. "Tam tanımlı" olunca geometri beyaz görünür.
   - Fare: sol çizim/seçim, orta döndür, sağ kaydır, tekerlek yakınlaştır. **Bitir** (Enter) / **İptal**.
3. **Unsurlar**: Extrude, Kesme, Revolve, Radyus, Pah, Delik (basit / havşa başı / havşa),
   Doğrusal desen, Dairesel desen, Ayna. Ağaçta seçili sketch (yoksa az önce çizilen) kendiliğinden kullanılır;
   görünüm önizleme için izometriğe döner. Değerler canlı önizlenir; ✓ ile eklenir.
4. **Tam parametrik**: soldaki özellik ağacında bir özelliğe çift tıklayıp (sketch dahil) değiştirin;
   parça ve ona bağlı mate'ler yeniden oluşur. Özellikler bastırılabilir, sıralanabilir, silinebilir.
5. Ağacın üstündeki **◀ Montaja dön** (ya da sol alttaki "Montaj ▸ Parça" yol işareti) ile montaja dönün; çizilen
   parça normal parça gibi mate/grup/gizmo ile kullanılır. Yeniden düzenlemek için çift tık ya da **Parçayı düzenle**.
   Hiç unsur eklenmeden bırakılan yeni parça silinir.

## Başka parçaları referans alma

- **Parçanın yüzeyine çiz**: parça kipinde STEP parçasının ya da başka bir çizilmiş parçanın düz yüzüne tıklayıp
  **Sketch**'e basın (ya da Sketch'in düzlem bekleme kipinde o yüze tıklayın). Sketch o yüze **bağlanır**: kaynak
  taşınır ya da (çizilmiş parçaysa) yeniden üretilirse düzlem de onunla gider.
- **Projeksiyon (J)**: sketch'teyken aracı seçip başka bir parçanın düz yüzüne tıklayın; dış hat ve delikler
  çizgi/yay/daire olarak (mor) gelir. Silindir yüze (delik duvarı) tıklamak daireyi, çizilmiş parçalarda bir
  kenara tıklamak o kenarı aktarır. Yalnız sketch düzlemine paralel yüz/kenarlar aktarılır.
  Aktarılan geometri sabittir (sürüklenmez); kendi çizgilerinizi ona ilişki/ölçüyle bağlayın, kaynak
  değişince onlar da gelir. Seçip Del ile tüm projeksiyon silinir; X ile yardımcı geometri yapılır.
- **Bağlı parça kilitlidir**: konumunu referansından alır, gizmo/mate ile taşınamaz. Özellik ağacının altındaki
  **Bağlantıyı kopar** referansları sabit kopyaya çevirir ve kilidi kaldırır.
- Parçanın kendi yüzünden alınan referanslar ve döngü oluşturacak referanslar sabit kopya olarak alınır.

## Parametreler

- **Parametreler (ƒx)** (Unsurlar sekmesi ya da Araçlar menüsü): Ad, Birim, İfade, Değer, Yorum tablosu.
  İfadeler sayı, birim (`mm cm m in deg`), `+ - * / ^`, `min max abs sqrt round sin cos…` ve diğer parametre
  adlarını kullanabilir (ör. `FFH - 2*KA`). Döngü ve bilinmeyen adlar kırmızı gösterilir.
- Bağlamak için sketch ölçüsüne (etikete çift tık ya da sol paneldeki liste), özellik değerine (extrude mesafesi,
  desen adedi…) ya da mate mesafe/açısına sayı yerine parametre adı ya da ifade yazın. `=AD` yazmak, mevcut değerle
  yeni parametre oluşturup bağlar. Bağlı alanlarda **ƒx** işareti görünür.
- Tabloda bir değeri değiştirince bağlı sketch'ler yeniden çözülür, parçalar yeniden oluşur ve mate'ler yüzü
  kökeniyle (hangi özellik + hangi sketch çizgisi) yeniden bularak yerinde kalır. Tek geri al adımıdır.
- CSV (Excel için `;`) ve JSON içe/dışa aktarma; İptal, pencere açıldığından beri yapılanları geri alır.
- **Model parametreleri:** sketch ölçüleri ve özellik değerleri (extrude mesafesi, radyus, delik çapı, desen
  adedi…) tabloda otomatik listelenir ve `d1, d2…` adını alır (parçaya göre gruplu). Değeri ya da ifadeyi
  tablodan değiştirin; parça yeniden oluşur, mate'ler ve montaj güncellenir. Adı değiştirip ifadelerde
  kullanabilirsiniz (ör. `d2 = d1 / 2`).

## Dışa aktarma

- **STEP**: tüm görünür montaj (çizilen parçalar + içe aktarılan parçaların gerçek CAD geometrisi) tek dosya.
- **GLB**, **PNG**, proje paketi (**.zip**).

## Kısayollar (montaj)

| Tuş | İşlev |
|---|---|
| W / E | Taşı / Döndür |
| Q | Dünya / Yerel eksen |
| M | Mate aracı |
| F | Seçiliye odakla |
| G | Zemine oturt |
| H | Gizle / Göster |
| Ctrl+tık | Seçime ekle / çıkar |
| Ctrl+G / Ctrl+Shift+G | Grupla / Grubu çöz |
| Ctrl+D | Çoğalt |
| Del | Sil |
| Ctrl+Z / Ctrl+Y | Geri al / Yinele |
| Esc | Seçimi kaldır |

## Bilinen sınırlamalar

- Parçanın kendi yüzüne açılan sketch düzlemi sabit koordinat olarak kaydedilir: alttaki özellik değişip yüz
  yer değiştirirse sketch eski konumunda kalır. (Başka parçaların yüzlerine açılan sketch'ler bağlıdır.)
- Projeksiyonun şekli kaynakta değişirse (ör. kaynak parçaya yeni delik eklendi) eşleşme bozulur; son hâli
  korunur ve özellik ağacında ⚠ gösterilir. Projeksiyonu silip yeniden aktarın.
- Bağlı parça kaynak sürüklenirken değil, bırakıldığında güncellenir.
- Radyus/pah kenarları ve çizilen parçalardaki mate yüzleri geometrik imzayla yeniden eşlenir; çok büyük
  topoloji değişikliklerinde yanlış kenar/yüz seçilebilir (özellik ağacında uyarı gösterilir).
- Sketch'te kesişen eğriler otomatik bölünmez (trim yok); 3 noktalı yay, teğet yay, spline yok.
