// Dar ekranda sahnenin sol ve sağ kenarındaki çekmece düğmeleri ("Ağaç", "Özellikler") ve çekmece açıkken
// dışına dokununca kapatan perde. Masaüstünde CSS ile gizlidir (mobile.css, main.tsx'te en son yüklenir).
import { useEffect } from 'react';
import { useAssembly } from '../../store/useAssembly';
import { useCommandKind } from '../command/CommandPanel';
import { useMobileUi, type MobileDrawer } from './mobileStore';

function toggle(d: Exclude<MobileDrawer, null>) {
  const st = useMobileUi.getState();
  st.set({ drawer: st.drawer === d ? null : d });
}

const TreeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="2" y="2.5" width="5" height="4" rx="0.8" />
    <rect x="9" y="7" width="7" height="3.5" rx="0.8" />
    <rect x="9" y="12" width="7" height="3.5" rx="0.8" />
    <path d="M4.5 6.5V14h4.5M4.5 9h4.5" />
  </svg>
);

const PropsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M3 4.5h12M3 9h12M3 13.5h12" />
    <circle cx="6" cy="4.5" r="1.6" fill="var(--panel)" />
    <circle cx="12" cy="9" r="1.6" fill="var(--panel)" />
    <circle cx="8" cy="13.5" r="1.6" fill="var(--panel)" />
  </svg>
);

export function MobileDock() {
  const drawer = useMobileUi((s) => s.drawer);
  const cmd = useCommandKind();
  const hasSel = useAssembly((s) => !!s.selection || !!s.mateSelection);

  // Komut açılınca sol çekmece komut sayfasına dönüşür; açık ağaç çekmecesi kapanır, sayfa tam açılır
  useEffect(() => {
    if (!cmd) return;
    const st = useMobileUi.getState();
    st.set({ sheetMin: false, drawer: st.drawer === 'tree' ? null : st.drawer });
  }, [cmd]);

  return (
    <>
      {!cmd && (
        <button
          type="button"
          className={`mdock-btn left ${drawer === 'tree' ? 'on' : ''}`}
          aria-expanded={drawer === 'tree'}
          aria-label="Tasarım ağacı"
          onClick={() => toggle('tree')}
        >
          <TreeIcon />
          <span>Ağaç</span>
        </button>
      )}
      <button
        type="button"
        className={`mdock-btn right ${drawer === 'props' ? 'on' : ''}`}
        aria-expanded={drawer === 'props'}
        aria-label="Seçili nesnenin özellikleri"
        onClick={() => toggle('props')}
      >
        <PropsIcon />
        <span>Özellik</span>
        {hasSel && <i className="mdock-dot" aria-hidden="true" />}
      </button>
    </>
  );
}

/** Çekmece açıkken sahneyi örten perde: dokununca çekmeceyi kapatır */
export function DrawerBackdrop() {
  const drawer = useMobileUi((s) => s.drawer);
  if (!drawer) return null;
  return (
    <div
      className="mdrawer-backdrop"
      aria-hidden="true"
      onPointerDown={(e) => {
        e.preventDefault();
        useMobileUi.getState().set({ drawer: null });
      }}
    />
  );
}
