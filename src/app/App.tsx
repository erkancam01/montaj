import { useEffect } from 'react';
import { Inspector, useInspectorHasContent } from '@/ui/shell/Inspector';
import { Overlays } from '@/ui/shell/Overlays';
import { PartTree } from '@/ui/shell/PartTree';
import { Toolbar } from '@/ui/shell/Toolbar';
import { Viewport } from '@/ui/viewport/Viewport';
import { useShortcuts } from '@/app/useShortcuts';
import { useCommandKeys } from '@/ui/commands/useCommandKeys';
import { restoreSession } from '@/services/io/session';
import { useAssembly } from '@/state/useAssembly';
import { startBodyManager } from '@/services/bodyManager';
import { ParamsDialog } from '@/ui/params/ParamsDialog';
import { NewDialog } from '@/ui/shell/NewDialog';
import { HelpDialog } from '@/ui/shell/HelpDialog';
import { useCommandKind } from '@/ui/commands/CommandPanel';
import { DrawerBackdrop, MobileDock } from '@/ui/mobile/MobileDock';
import { useMobileUi } from '@/ui/mobile/mobileStore';
import { LibraryDock } from '@/ui/library/LibraryPanel';
import { LibraryViewportDrop } from '@/ui/library/LibraryViewportDrop';

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
  const insp = useInspectorHasContent();

  return (
    <div className="app" data-drawer={drawer ?? undefined} data-cmd={cmd ?? undefined} data-sheet={cmd && sheetMin ? 'min' : undefined} data-insp={insp ? undefined : 'off'}>
      <Toolbar />
      <PartTree />
      <main className="viewport-box">
        <Viewport />
        <Overlays />
        <LibraryViewportDrop />
        <LibraryDock />
        <MobileDock />
      </main>
      <Inspector />
      <DrawerBackdrop />
      <ParamsDialog />
      <NewDialog />
      <HelpDialog />
    </div>
  );
}
