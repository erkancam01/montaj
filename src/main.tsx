import '@/app/setup';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import '@/ui/theme/tokens.css';
import '@/ui/theme/styles.css';
// Dar ekran düzeni en son: diğer tüm stilleri < 900 px'te ezer
import '@/ui/mobile/mobile.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
