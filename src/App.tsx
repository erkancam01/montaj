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

  return (
    <div className="app">
      <Toolbar />
      <PartTree />
      <main className="viewport-box">
        <Viewport />
        <Overlays />
      </main>
      <Inspector />
    </div>
  );
}
