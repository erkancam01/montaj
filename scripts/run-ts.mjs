// TypeScript betiğini Vite SSR ile çalıştırır: node scripts/run-ts.mjs scripts/mate-tests.ts
import { createServer } from 'vite';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Kullanım: node scripts/run-ts.mjs <dosya.ts>');
  process.exit(2);
}
const server = await createServer({
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let code = 0;
try {
  await server.ssrLoadModule(resolve(file));
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await server.close();
}
process.exit(process.exitCode ?? code);
