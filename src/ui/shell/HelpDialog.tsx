// Yardım penceresi (Yardım menüsü / F1): temel kullanım ve kısayollar. Eskiden sağ panelde duran metin.
import { useEffect } from 'react';
import { create } from 'zustand';
import '@/ui/params/params.css';
import '@/ui/shell/shell.css';

const useHelp = create<{ open: boolean }>()(() => ({ open: false }));

export function openHelp() {
  useHelp.setState({ open: true });
}

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+N', 'Yeni (parça / montaj)'],
  ['Ctrl+O', 'Dosya aç / içe aktar'],
  ['Ctrl+S', 'Projeyi kaydet (.zip)'],
  ['S', 'Kısayol menüsü (imleç yanında)'],
  ['Space', 'Görünüm menüsü'],
  ['Ctrl+1…7', 'Standart görünümler (Ön, Arka, Sol, Sağ, Üst, Alt, İzometrik)'],
  ['Ctrl+8', 'Seçime dik bak'],
  ['Enter', 'Son komutu tekrarla · açık komutu onayla'],
  ['Esc', 'Komuttan / seçimden çık'],
  ['Ctrl+tık', 'Seçime ekle / çıkar (Shift+tık da olur)'],
  ['Ctrl+G', 'Seçili parçaları grupla'],
  ['Ctrl+Shift+G', 'Grubu çöz'],
  ['W', 'Taşı'],
  ['E', 'Döndür'],
  ['M', 'Mate'],
  ['Q', 'Dünya / Yerel eksen'],
  ['F', 'Seçiliye odakla (yoksa tümü)'],
  ['G', 'Zemine oturt'],
  ['H', 'Gizle / göster'],
  ['Del', 'Sil'],
  ['Ctrl+D', 'Çoğalt'],
  ['Ctrl+Z', 'Geri al'],
  ['Ctrl+Y', 'Yinele'],
];

export function HelpDialog() {
  const open = useHelp((s) => s.open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        useHelp.setState({ open: false });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!open) return null;
  const close = () => useHelp.setState({ open: false });
  return (
    <div className="pd-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pd dlg-narrow" role="dialog" aria-modal="true" aria-label="Yardım">
        <div className="pd-head">
          <span className="pd-title">Yardım</span>
          <button type="button" className="pd-x" aria-label="Kapat" onClick={close}>
            ✕
          </button>
        </div>
        <div className="pd-body help">
          <div className="prop-title">Temel akış</div>
          <ol className="help-list">
            <li>
              <b>Dosya ▸ Yeni ▸ Parça</b>: soldaki ağaçta bir düzlem (Ön / Üst / Sağ) seçin, <b>Sketch</b>'e basın.
            </li>
            <li>Profili çizin, ölçülendirin; sağ üstteki ✓ ile sketch'ten çıkın.</li>
            <li>
              <b>Ekstrüzyon</b> (Unsurlar sekmesi): sketch kendiliğinden seçilir; mesafeyi girip ✓.
            </li>
            <li>
              Ağacın üstündeki <b>Montaja dön</b> ile montaja geçin. Başka parçaları <b>Ekle ▸ Bileşen</b> ile ekleyin.
            </li>
            <li>
              <b>Mate</b> (M): iki yüzey seçin, imleç yanındaki kutudan türü seçip ✓. Komut açık kalır; Enter ile bitirin.
            </li>
          </ol>
          <div className="prop-title">İpuçları</div>
          <ul className="help-list">
            <li>STEP, IGES veya BREP dosyalarını pencereye sürükleyebilirsiniz.</li>
            <li>Bir yüzeye tıklayınca imleç yanında küçük araç kutusu çıkar (Sketch, Mate, Gizle). Sağ tık bağlama göre menü açar.</li>
            <li>Bir parçayı düzenlemek için sahnede ya da ağaçta çift tıklayın.</li>
            <li>Birlikte kalması gereken parçaları Ctrl+G ile gruplayın; grup tek gövde gibi davranır.</li>
            <li>Sayı alanlarında ↑ / ↓ snap adımı kadar değiştirir; ifade (ör. FFH-40) yazılabilir.</li>
            <li>Proje tarayıcıda otomatik saklanır; başka bilgisayara taşımak için Dosya ▸ Kaydet (.zip).</li>
          </ul>
          <div className="prop-title">Kısayollar</div>
          <dl className="shortcut-list">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k} className="shortcut">
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
