// DXF içe aktarma testleri. Çalıştırma: node scripts/run-ts.mjs scripts/dxf-tests.ts
// Örnek profil DXF'i (scripts/fixtures/ornek-profil.dxf) burada üretilir; tarayıcıda denemek için de kullanılır.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dxfToSketch, parseDxf, placeDxf, primBounds } from '../src/core/import/dxf';
import { findRegions } from '../src/core/sketch/profiles';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, info = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`);
}
const near = (a: number, b: number, t = 1e-6) => Math.abs(a - b) <= t;

// ---------------------------------------------------------------- örnek DXF üretimi

function dxf(header: string[], blocks: string[], entities: string[]): string {
  return [
    '0', 'SECTION', '2', 'HEADER', ...header, '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\r\n');
}
const line = (x1: number, y1: number, x2: number, y2: number, layer = 'PROFIL') =>
  ['0', 'LINE', '8', layer, '10', `${x1}`, '20', `${y1}`, '30', '0', '11', `${x2}`, '21', `${y2}`, '31', '0'];
const circle = (x: number, y: number, r: number, layer = 'PROFIL') => ['0', 'CIRCLE', '8', layer, '10', `${x}`, '20', `${y}`, '30', '0', '40', `${r}`];
/** Köşeleri r yarıçaplı yuvarlatılmış dikdörtgen (LWPOLYLINE, bulge) */
function roundedRect(x0: number, y0: number, w: number, h: number, r: number, layer = 'PROFIL'): string[] {
  const b = `${Math.tan(Math.PI / 8)}`; // 90° yay
  const v: [number, number, string][] = [
    [x0 + r, y0, '0'], [x0 + w - r, y0, b],
    [x0 + w, y0 + r, '0'], [x0 + w, y0 + h - r, b],
    [x0 + w - r, y0 + h, '0'], [x0 + r, y0 + h, b],
    [x0, y0 + h - r, '0'], [x0, y0 + r, b],
  ];
  return ['0', 'LWPOLYLINE', '8', layer, '90', `${v.length}`, '70', '1', ...v.flatMap(([x, y, bb]) => ['10', `${x}`, '20', `${y}`, '42', bb])];
}

// 50×30 profil, 2 mm yuvarlatılmış dış köşe; iç odacık 40×20 (çizgilerle, biri bölünmüş + bir kopya + 0.004 mm açıklık);
// vida kanalı Ø3 daire (blok içinde, INSERT ile); yazı (atlanır); ölçü katmanında bir çizgi
const sample = dxf(
  ['9', '$INSUNITS', '70', '4'],
  ['0', 'BLOCK', '8', '0', '2', 'VIDA', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'VIDA', ...circle(0, 0, 1.5, '0'), '0', 'ENDBLK', '8', '0'],
  [
    ...roundedRect(0, 0, 50, 30, 2),
    ...line(5, 5, 25, 5), ...line(25, 5, 45, 5), // alt kenar ikiye bölünmüş
    ...line(45, 5, 45, 25), ...line(45, 25, 5, 25),
    ...line(5, 25, 5, 5.004), // 0.004 mm açıklık → birleştirilmeli
    ...line(45, 5, 45, 25), // kopya
    ...line(15, 25, 15, 15), ...line(35, 25, 35, 15), ...line(15, 15, 35, 15), // üst kenara T ile değen iç cep
    '0', 'INSERT', '8', 'PROFIL', '2', 'VIDA', '10', '25', '20', '27.5', '30', '0',
    '0', 'TEXT', '8', 'YAZI', '10', '0', '20', '-5', '40', '2.5', '1', 'ORNEK PROFIL',
    ...line(0, -10, 50, -10, 'OLCU'),
  ],
);
mkdirSync('scripts/fixtures', { recursive: true });
writeFileSync('scripts/fixtures/ornek-profil.dxf', sample);

// ---------------------------------------------------------------- testler

const d = parseDxf(sample);
check('birim mm', d.unitMm === 1, String(d.unitMm));
check('katmanlar', d.layers.join(',') === 'OLCU,PROFIL', d.layers.join(','));
check('yazı atlandı', d.skipped['TEXT'] === 1);
check('LWPOLYLINE: 4 çizgi + 4 yay', d.prims.filter((p) => p.kind === 'arc').length === 4);
check('blok dairesi INSERT ile geldi', d.prims.some((p) => p.kind === 'circle' && near(p.c[0], 25) && near(p.c[1], 27.5) && near(p.r, 1.5)));

const placed = placeDxf(d, { scale: 1, layers: ['PROFIL'], rotate: 0, mirror: false, anchor: 'minCorner', offset: [0, 0] });
const bb = primBounds(placed)!;
check('sol alt köşe orijinde', near(bb.min[0], 0) && near(bb.min[1], 0) && near(bb.max[0], 50) && near(bb.max[1], 30), JSON.stringify(bb));
let n = 0;
const r = dxfToSketch(placed, 'dxf1', (p) => `${p}${++n}`);
check('kopya silindi', r.stats.duplicates === 1, JSON.stringify(r.stats));
check('T-kesişim bölündü', r.stats.split >= 1, JSON.stringify(r.stats));
check('açıklık birleşti', r.stats.snapped >= 1, JSON.stringify(r.stats));
check('tümü sabit (ext)', r.entities.every((e) => e.ext === 'dxf1'));
const regions = findRegions(r.entities);
// Bölgeler: profil gövdesi (dış − odacık − vida), iç cep (odacığın üst kısmı ikiye ayrılır), vida dairesi içi
const outer = regions.find((g) => g.depth === 0);
check('dış bölge bulundu (delikli)', !!outer && outer.holes.length >= 1, regions.map((g) => `${g.depth}:${g.holes.length}:${g.area.toFixed(1)}`).join(' '));
const fullArea = 50 * 30 - (4 - Math.PI) * 4; // köşeleri yuvarlatılmış
const inner = 40 * 20;
const screw = Math.PI * 2.25;
check('dış bölge alanı', !!outer && near(outer.area, fullArea - inner - screw, 0.05), outer?.area.toFixed(3));

// Ölçek + dönüş + merkez yerleşimi
const inch = placeDxf(d, { scale: 25.4, layers: ['PROFIL'], rotate: 90, mirror: false, anchor: 'center', offset: [10, 0] });
const ib = primBounds(inch)!;
check('inç + 90° + merkez', near(ib.max[0] - ib.min[0], 30 * 25.4, 1e-6) && near((ib.min[0] + ib.max[0]) / 2, 10, 1e-6), JSON.stringify(ib));
const mir = placeDxf(d, { scale: 1, layers: ['PROFIL'], rotate: 0, mirror: true, anchor: 'origin', offset: [0, 0] });
const mb = primBounds(mir)!;
check('ayna', near(mb.min[0], -50) && near(mb.max[0], 0), JSON.stringify(mb));
const mr = dxfToSketch(mir, 'm', (p) => `${p}${++n}`);
const mOuter = findRegions(mr.entities).find((g) => g.depth === 0);
check('aynada da aynı alan', !!mOuter && near(mOuter.area, fullArea - inner - screw, 0.05), mOuter?.area.toFixed(3));

// Bulge yönü: negatif bulge (cw) yarım daire
const cw = parseDxf(dxf([], [], ['0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '0', '10', '0', '20', '0', '42', '-1', '10', '10', '20', '0']));
const a = cw.prims[0];
check('negatif bulge (cw): yay gidiş yönünün solunda (üstte)', a.kind === 'arc' && near(a.c[0], 5) && near(a.a0, 0, 1e-9) && near(a.a1, Math.PI, 1e-9), JSON.stringify(a));

// Geçersiz dosya
let err = '';
try {
  parseDxf('merhaba');
} catch (e) {
  err = (e as Error).message;
}
check('geçersiz dosya hatası', err.includes('DXF'));

console.log(`\n${passed} geçti, ${failed} kaldı`);
if (failed) process.exit(1);
