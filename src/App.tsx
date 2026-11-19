import { useEffect } from 'react';
import { Inspector } from './components/Inspector';
import { Overlays } from './components/Overlays';
import { PartTree } from './components/PartTree';
import { Toolbar } from './components/Toolbar';
import { Viewport } from './components/viewport/Viewport';
import { useShortcuts } from './hooks/useShortcuts';
import { useCommandKeys } from './components/command/useCommandKeys';
import { restoreSession } from './lib/session';
import { useAssembly } from './store/useAssembly';
import { startBodyManager } from './modeling/bodyManager';
import { ParamsDialog } from './components/params/ParamsDialog';
import { useCommandKind } from './components/command/CommandPanel';
import { DrawerBackdrop, MobileDock } from './components/mobile/MobileDock';
import { useMobileUi } from './components/mobile/mobileStore';

export function App() {
  useShortcuts();
  useCommandKeys();

  useEffect(() => {
    startBodyManager();
    restoreSession().catch((err: unknown) => {
      console.error(err);
      useAssembly.getState().showToast('Kayıtlı proje yüklenemedi', 'error');
    });
  }, []);

  // Dar ekran düzeni (mobile.css) bu niteliklere göre çekmece / komut sayfası gösterir
  const drawer = useMobileUi((s) => s.drawer);
  const sheetMin = useMobileUi((s) => s.sheetMin);
  const cmd = useCommandKind();

  return (
    <div className="app" data-drawer={drawer ?? undefined} data-cmd={cmd ?? undefined} data-sheet={cmd && sheetMin ? 'min' : undefined}>
      <Toolbar />
      <PartTree />
      <main className="viewport-box">
        <Viewport />
        <Overlays />
        <MobileDock />
      </main>
      <Inspector />
      <DrawerBackdrop />
      <ParamsDialog />
    </div>
  );
}
