import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  plugins: [react()],
  // "@/..." = src/... (katmanlar arası import'lar dosya konumundan bağımsız)
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173 },
  // Çekirdek worker'ı (replicad/OpenCascade) ES modülü olarak paketlenir; wasm ?url ile asset olur.
  worker: { format: 'es' },
});
