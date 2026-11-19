// Dosya ekleme (araç çubuğu, boş durum kartı ve sürükle-bırak) için ortak giriş noktası.
import { formatFromName, isProjectZip } from '@/services/io/formats';
import { importFiles } from '@/services/io/session';
import { useAssembly } from '@/state/useAssembly';

export function isDocEmpty(): boolean {
  const { doc } = useAssembly.getState();
  return doc.instances.length === 0 && doc.files.length === 0;
}

/**
 * Desteklenmeyen dosyaları ayıklar; listede proje .zip'i varsa ve mevcut belge boş değilse
 * kullanıcıdan onay alır, sonra importFiles'ı çağırır.
 */
export async function importWithConfirm(files: File[]): Promise<void> {
  const { showToast } = useAssembly.getState();
  const supported = files.filter((f) => formatFromName(f.name) !== null || isProjectZip(f.name));
  const skipped = files.length - supported.length;
  if (skipped > 0) {
    showToast(
      supported.length
        ? `${skipped} dosya desteklenmeyen biçimde olduğu için atlandı`
        : 'Desteklenmeyen dosya türü. STEP, IGES, BREP veya proje .zip seçin.',
      'error',
    );
  }
  if (!supported.length) return;

  if (supported.some((f) => isProjectZip(f.name)) && !isDocEmpty()) {
    if (!window.confirm('Mevcut proje değiştirilecek. Devam edilsin mi?')) return;
  }

  try {
    await importFiles(supported);
  } catch (err) {
    console.error(err);
    showToast(`İçe aktarma başarısız: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}
