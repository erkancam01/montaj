// Dosya işlemleri: dosya seçici, yeni proje, kaydet (.zip), dışa aktar (STEP / GLB / PNG).
// Menü çubuğu, komut çubuğu ve kısayollar ortak kullanır.
import { downloadBlob } from '@/services/io/download';
import { exportProjectZip, newProject } from '@/services/io/session';
import { viewerApi } from '@/services/viewerApi';
import { exportAssemblyAsStep } from '@/services/io/exportAssemblyStep';
import { useAssembly } from '@/state/useAssembly';
import { isDocEmpty } from '@/ui/shell/importWithConfirm';

/** Dosya seçiciyi açar (Toolbar içindeki FilePickerHost dinler) */
export function openFilePicker() {
  window.dispatchEvent(new Event('app:add-files'));
}

export async function runExport(make: () => Promise<Blob | null>, filename: string, emptyMsg: string) {
  const { showToast } = useAssembly.getState();
  try {
    const blob = await make();
    if (!blob || blob.size === 0) {
      showToast(emptyMsg, 'error');
      return;
    }
    downloadBlob(blob, filename);
  } catch (err) {
    console.error(err);
    showToast(`Dışa aktarma başarısız: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

export async function exportStep() {
  const { showToast } = useAssembly.getState();
  try {
    const { blob, warnings } = await exportAssemblyAsStep();
    downloadBlob(blob, 'montaj.step');
    if (warnings.length) {
      const more = warnings.length > 2 ? ` (+${warnings.length - 2} uyarı)` : '';
      showToast(`STEP uyarıları: ${warnings.slice(0, 2).join(' · ')}${more}`, 'error');
      console.warn('STEP dışa aktarma uyarıları', warnings);
    }
  } catch (err) {
    console.error(err);
    showToast(`STEP dışa aktarma başarısız: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/** Belgeyi temizler (dolu belgede onay ister); vazgeçilirse false */
export async function onNewProject(): Promise<boolean> {
  if (!isDocEmpty() && !window.confirm('Mevcut proje kapatılacak (kaydedilmemiş değişiklikler kaybolur). Devam edilsin mi?')) return false;
  try {
    await newProject();
    return true;
  } catch (err) {
    console.error(err);
    useAssembly.getState().showToast('Yeni proje oluşturulamadı', 'error');
    return false;
  }
}

let saving = false;

export async function saveProjectZip() {
  if (saving) return;
  if (isDocEmpty()) {
    useAssembly.getState().showToast('Kaydedilecek proje içeriği yok');
    return;
  }
  saving = true;
  try {
    await runExport(exportProjectZip, 'montaj-proje.zip', 'Kaydedilecek proje içeriği yok');
  } finally {
    saving = false;
  }
}

export const exportGlb = () => runExport(() => viewerApi.exportGLB(), 'montaj.glb', 'Dışa aktarılacak görünür parça yok');
export const exportPng = () => runExport(() => viewerApi.screenshot(), 'montaj.png', 'Ekran görüntüsü alınamadı');
