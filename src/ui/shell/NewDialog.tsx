// "Yeni" penceresi (Dosya ▸ Yeni, Ctrl+N): Parça ya da Montaj. Belge tektir: Parça bu montajda yeni bir parça
// açar ve parça kipine girer; Montaj montaj kipine döner ve bileşen eklemek için dosya seçiciyi açar.
// İstenirse önce mevcut proje kapatılır.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useAssembly } from '@/state/useAssembly';
import { exitBody } from '@/state/modelingActions';
import { newPart, runCommand } from '@/ui/commands/commands';
import { CIcon } from '@/ui/icons/commandIcons';
import { IconMate } from '@/ui/icons/icons';
import { onNewProject, openFilePicker } from '@/ui/shell/fileActions';
import { isDocEmpty } from '@/ui/shell/importWithConfirm';
import '@/ui/params/params.css';
import '@/ui/shell/shell.css';

const useNewDialog = create<{ open: boolean }>()(() => ({ open: false }));

export function openNewDialog() {
  const s = useAssembly.getState();
  if (s.modeling.sketch) {
    s.showToast("Önce sketch'ten çıkın (✓) ya da iptal edin", 'error');
    return;
  }
  useNewDialog.setState({ open: true });
}

/** Yeni parça (boş parça kipi) */
export function startNewPart() {
  runCommand('newpart', 'Yeni parça', newPart);
}

/** Montaj: montaj kipine dön, bileşen ekle */
export function startAssembly() {
  if (useAssembly.getState().modeling.activeBodyId) exitBody();
  openFilePicker();
}

export function NewDialog() {
  const open = useNewDialog((s) => s.open);
  if (!open) return null;
  return <Dialog />;
}

function Dialog() {
  const [fresh, setFresh] = useState(false);
  const empty = isDocEmpty();
  const close = () => useNewDialog.setState({ open: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const go = async (what: 'part' | 'assembly') => {
    close();
    if (fresh && !empty && !(await onNewProject())) return;
    if (what === 'part') startNewPart();
    else startAssembly();
  };
  return (
    <div className="pd-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pd dlg-new" role="dialog" aria-modal="true" aria-label="Yeni">
        <div className="pd-head">
          <span className="pd-title">Yeni</span>
          <button type="button" className="pd-x" aria-label="Kapat" onClick={close}>
            ✕
          </button>
        </div>
        <div className="pd-body">
          <NewCards onPart={() => void go('part')} onAssembly={() => void go('assembly')} />
          {!empty && (
            <label className="pd-check">
              <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Önce mevcut projeyi kapat (boş proje)
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

/** Parça / Montaj kartları (Yeni penceresi ve boş belge karşılaması) */
export function NewCards({ onPart, onAssembly }: { onPart(): void; onAssembly(): void }) {
  return (
    <div className="new-cards">
      <button type="button" className="new-card" onClick={onPart}>
        <span className="new-card-icon">
          <CIcon name="newPart" size={40} />
        </span>
        <span className="new-card-title">Parça</span>
        <span className="new-card-text">Düzlem seçip sketch çizerek tek bir parça modelleyin.</span>
      </button>
      <button type="button" className="new-card" onClick={onAssembly}>
        <span className="new-card-icon">
          <IconMate size={40} />
        </span>
        <span className="new-card-title">Montaj</span>
        <span className="new-card-text">STEP / IGES dosyalarını ve çizdiğiniz parçaları mate ile bir araya getirin.</span>
      </button>
    </div>
  );
}
