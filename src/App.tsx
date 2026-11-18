import { useEffect } from 'react';
import { Inspector } from './components/Inspector';
import { Overlays } from './components/Overlays';
import { PartTree } from './components/PartTree';
import { Toolbar } from './components/Toolbar';
import { Viewport } from './components/viewport/Viewport';
import { useShortcuts } from './hooks/useShortcuts';
import { restoreSession } from './lib/session';
import { useAssembly } from './store/useAssembly';

export function App() {
  useShortcuts();

  useEffect(() => {
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
