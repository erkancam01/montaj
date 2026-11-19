// İfade değerlendirici testleri: npm run test:expr
import { evalExpr, evalParams, exprRefs, isPlainNumber, renameInExpr, validParamName } from '../src/lib/expr';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    ok++;
    console.log(`OK   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${extra}`);
  }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const V = (o: Record<string, number>) => new Map(Object.entries(o));

check('öncelik', near(evalExpr('2+3*4', V({})), 14));
check('parantez', near(evalExpr('(2+3)*4', V({})), 20));
check('üs sağdan', near(evalExpr('2^3^2', V({})), 512));
check('tekli eksi', near(evalExpr('-2^2', V({})), -4));
check('birim mm', near(evalExpr('10 mm', V({})), 10));
check('birim cm', near(evalExpr('1.5 cm', V({})), 15));
check('birim m', near(evalExpr('1.2m', V({})), 1200));
check('birim in', near(evalExpr('1 in', V({})), 25.4));
check('rad→deg', near(evalExpr('pi rad', V({})), 180));
check('fonksiyon', near(evalExpr('max(1, 5, 3) + min(2,4)', V({})), 7));
check('sin derece', near(evalExpr('sin(30)', V({})), 0.5));
check('parametre', near(evalExpr('FFH - 2*KA', V({ FFH: 1200, KA: 60 })), 1080));
check('türkçe ad', near(evalExpr('Yükseklik/2', V({ Yükseklik: 900 })), 450));
check('ondalık virgül', near(evalExpr('12,5', V({})), 12.5));
check('virgül fonksiyonda ayırıcı', near(evalExpr('max(1,2)', V({})), 2));

let threw = '';
try {
  evalExpr('FFX + 1', V({}));
} catch (e) {
  threw = String(e);
}
check('bilinmeyen ad hatası', threw.includes('Bilinmeyen ad'), threw);
threw = '';
try {
  evalExpr('2 +', V({}));
} catch (e) {
  threw = String(e);
}
check('sözdizimi hatası', threw.length > 0, threw);

const r = evalParams([
  { name: 'FFH', expr: '1200 mm' },
  { name: 'KA', expr: '60' },
  { name: 'ICH', expr: 'FFH - 2*KA' },
  { name: 'A', expr: 'B + 1' },
  { name: 'B', expr: 'A + 1' },
  { name: 'C', expr: 'Yok * 2' },
  { name: 'D', expr: 'ICH / 2' },
]);
check('param zinciri', r.values.get('ICH') === 1080 && r.values.get('D') === 540);
check('döngü hatası', (r.errors.get('A') ?? '').includes('Döngü'), r.errors.get('A'));
check('döngü B de hatalı', r.errors.has('B'));
check('bilinmeyen param hatası', (r.errors.get('C') ?? '').includes('Bilinmeyen'), r.errors.get('C'));

const r2 = evalParams([
  { name: 'X', expr: '1' },
  { name: 'X', expr: '2' },
]);
check('çift ad hatası', r2.errors.has('X'));

check('refs', exprRefs('FFH - 2*KA + max(B, 3) mm').sort().join(',') === 'B,FFH,KA');
check('rename', renameInExpr('FFH - 2*FFH2 + FFH', 'FFH', 'Yuk') === 'Yuk - 2*FFH2 + Yuk');
check('plain number', isPlainNumber('12.5') && isPlainNumber('-3') && isPlainNumber('12,5') && !isPlainNumber('FFH'));
check('ad geçerli', validParamName('FFH') === null && validParamName('Yükseklik_2') === null);
check('ad geçersiz', validParamName('2X') !== null && validParamName('max') !== null && validParamName('a b') !== null);

console.log(`\n${ok} geçti, ${fail} kaldı`);
if (fail) process.exit(1);
