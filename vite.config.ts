import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  // Çekirdek worker'ı (replicad/OpenCascade) ES modülü olarak paketlenir; wasm ?url ile asset olur.
  worker: { format: 'es' },
});
