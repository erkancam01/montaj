// occt-import-js çalışma dosyalarını public/ klasörüne kopyalar.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'occt-import-js', 'dist');
const dst = join(root, 'public');
mkdirSync(dst, { recursive: true });
for (const f of ['occt-import-js.js', 'occt-import-js.wasm']) {
  copyFileSync(join(src, f), join(dst, f));
}
console.log('occt-import-js dosyaları public/ klasörüne kopyalandı.');
