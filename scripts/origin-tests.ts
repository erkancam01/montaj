// Yüz kökeni (topolojik adlandırma) testleri. Çalıştırma: node scripts/run-ts.mjs scripts/origin-tests.ts
// Çekirdek kullanılmaz: yüz geometrisi listesi sentetik verilir (getFaceGeom çıktısı biçiminde).
import { computeFaceOrigins, originCandidates, sameOrigin } from '../src/modeling/faceOrigin';
import { faceScore } from '../src/modeling/faceMatch';
import type { ExtrudeFeature, FaceGeom, FaceOrigin, Feature, PlaneDef, RevolveFeature, SketchFeature, SkEntity, Vec3 } from '../src/types';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, info = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`);
}
const fmt = (o: FaceOrigin | undefined) => (o ? `${o.featureId}/${o.entityId ?? o.cap}` : '—');

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

/** Eksene hizalı dikdörtgen: 4 nokta + 4 çizgi (alt, sağ, üst, sol) */
function rect(pre: string, x0: number, y0: number, x1: number, y1: number, construction = false): SkEntity[] {
  const p = (i: number, x: number, y: number): SkEntity => ({ id: `${pre}p${i}`, kind: 'point', x, y });
  const l = (n: string, a: number, b: number): SkEntity => ({ id: `${pre}${n}`, kind: 'line', p1: `${pre}p${a}`, p2: `${pre}p${b}`, construction });
  return [p(0, x0, y0), p(1, x1, y0), p(2, x1, y1), p(3, x0, y1), l('B', 0, 1), l('R', 1, 2), l('T', 2, 3), l('L', 3, 0)];
}
function sketch(id: string, entities: SkEntity[], plane: PlaneDef = XY): SketchFeature {
  return { id, name: id, suppressed: false, type: 'sketch', plane, entities, constraints: [] };
}
function extrude(id: string, sketchId: string, distance: number, extra: Partial<ExtrudeFeature> = {}): ExtrudeFeature {
  return {
    id, name: id, suppressed: false, type: 'extrude', sketchId, profilePoints: [], extent: 'oneSide', distance, distance2: 0,
    reverse: false, throughAll: false, operation: 'add', ...extra,
  };
}
const plane = (point: Vec3, normal: Vec3): FaceGeom => ({ kind: 'plane', point, normal });
const cyl = (point: Vec3, axis: Vec3, radius: number): FaceGeom => ({ kind: 'cylinder', point, axis, radius });

/** Eksene hizalı dikdörtgen prizmanın yan yüzleri (dış: normal dışarı; hole=true: delik duvarları, normal içeri) */
function boxSides(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, hole = false): FaceGeom[] {
  const s = hole ? -1 : 1;
  const zm = (z0 + z1) / 2, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
  return [
    plane([xm, y0, zm], [0, -s, 0]),
    plane([x1, ym, zm], [s, 0, 0]),
    plane([xm, y1, zm], [0, s, 0]),
    plane([x0, ym, zm], [-s, 0, 0]),
  ];
}

// ---------------------------------------------------------------- 1. kutu
{
  const fs: Feature[] = [sketch('S1', rect('a', -50, -30, 50, 30)), extrude('E1', 'S1', 20)];
  const faces = [...boxSides(-50, -30, 50, 30, 0, 20), plane([0, 0, 0], [0, 0, -1]), plane([0, 0, 20], [0, 0, 1])];
  const o = computeFaceOrigins(fs, faces, 120);
  check('kutu: 4 yan yüz çizgilerine', ['aB', 'aR', 'aT', 'aL'].every((id, i) => o[i]?.featureId === 'E1' && o[i]?.entityId === id), o.map(fmt).join(' '));
  check('kutu: alt kapak start, üst kapak end', o[4]?.cap === 'start' && o[5]?.cap === 'end', `${fmt(o[4])} ${fmt(o[5])}`);
}

// ---------------------------------------------------------------- 2. çerçeve (dış + iç dikdörtgen)
function frameCase(ow: number, oh: number, iw: number, ih: number, t: number) {
  const fs: Feature[] = [
    sketch('S1', [...rect('o', -ow / 2, -oh / 2, ow / 2, oh / 2), ...rect('i', -iw / 2, -ih / 2, iw / 2, ih / 2)]),
    extrude('E1', 'S1', t),
  ];
  const faces = [
    ...boxSides(-ow / 2, -oh / 2, ow / 2, oh / 2, 0, t),
    ...boxSides(-iw / 2, -ih / 2, iw / 2, ih / 2, 0, t, true),
    plane([0, 0, 0], [0, 0, -1]),
    plane([0, 0, t], [0, 0, 1]),
  ];
  return { fs, faces, o: computeFaceOrigins(fs, faces, Math.hypot(ow, oh, t)) };
}
{
  const { o } = frameCase(900, 1200, 780, 1080, 60);
  const want = ['oB', 'oR', 'oT', 'oL', 'iB', 'iR', 'iT', 'iL'];
  check('çerçeve: 8 yan yüz farklı kökenli', want.every((id, i) => o[i]?.entityId === id), o.map(fmt).join(' '));
  // Aynı yöne bakan yüzler: dış alt (−y, y=-600) ve iç üst (−y, y=540)
  check('çerçeve: aynı yönlü dış alt / iç üst ayrışır', !sameOrigin(o[0], o[6]) && o[0]?.entityId === 'oB' && o[6]?.entityId === 'iT');
  check('çerçeve: kapaklar', o[8]?.cap === 'start' && o[9]?.cap === 'end');
  const uniq = new Set(o.map(fmt));
  check('çerçeve: tüm kökenler benzersiz', uniq.size === o.length && !uniq.has('—'));
}

// ---------------------------------------------------------------- 3. yükseklik değişimi: aynı kökenler
{
  const before = frameCase(900, 1200, 780, 1080, 60);
  const after = frameCase(900, 1500, 780, 1380, 60);
  const ok = before.o.every((x, i) => sameOrigin(x, after.o[i]));
  check('yükseklik değişti: aynı yüzler aynı kökende', ok, after.o.map(fmt).join(' '));
  // Mate: iç üst yüz (indeks 6). Yeni geometride kökenle tek aday, doğru yüz.
  const ref = before.o[6]!;
  const cands = originCandidates([after.o], ref);
  check('yükseklik değişti: iç üst yüz tek aday', cands.length === 1 && cands[0].faceIndex === 6);
  // İç yan yüz (iR, indeks 5)
  const c2 = originCandidates([after.o], before.o[5]!);
  check('yükseklik değişti: iç sağ yüz tek aday', c2.length === 1 && c2[0].faceIndex === 5);
  // Kalınlık değişimi: end kapağı yeni ofsette bulunur
  const thick = frameCase(900, 1200, 780, 1080, 90);
  check('kalınlık değişti: üst kapak end', thick.o[9]?.cap === 'end' && thick.o[8]?.cap === 'start');
}

// ---------------------------------------------------------------- 4. daire delik (tüm gövde boyunca kesme)
{
  const holeSk: SkEntity[] = [{ id: 'hc', kind: 'point', x: 10, y: 5 }, { id: 'circ', kind: 'circle', c: 'hc', r: 5 }];
  const fs: Feature[] = [
    sketch('S1', rect('a', -50, -30, 50, 30)),
    extrude('E1', 'S1', 20),
    sketch('S2', holeSk, { origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] }),
    extrude('C1', 'S2', 0, { throughAll: true, reverse: true, operation: 'cut' }),
  ];
  const faces = [...boxSides(-50, -30, 50, 30, 0, 20), plane([0, 0, 0], [0, 0, -1]), plane([0.4, 0.2, 20], [0, 0, 1]), cyl([10, 5, 10], [0, 0, 1], 5.0004)];
  const o = computeFaceOrigins(fs, faces, 120);
  check('delik: silindir daireye', o[6]?.featureId === 'C1' && o[6]?.entityId === 'circ', fmt(o[6]));
  // Üst yüz: kesmenin start kapağı (z=20) da aynı düzlemde; profil kutusu dışında merkez → E1 end kalır
  check('delik: üst yüz kutunun end kapağı', o[5]?.featureId === 'E1' && o[5]?.cap === 'end', fmt(o[5]));
  check('delik: yan yüzler E1', o.slice(0, 4).every((x) => x?.featureId === 'E1'));
  // Merkezi delik kutusunun içine düşen üst yüz de kutunun end kapağı kalır (kesmenin start kapağı değil)
  const o3 = computeFaceOrigins(fs, [plane([9.8, 4.9, 20], [0, 0, 1])], 120);
  check('delik: delik kutusundaki üst yüz yine E1 end', o3[0]?.featureId === 'E1' && o3[0]?.cap === 'end', fmt(o3[0]));
  // Farklı yarıçap → köken yok
  const o2 = computeFaceOrigins(fs, [cyl([10, 5, 10], [0, 0, 1], 7)], 120);
  check('delik: yarıçap uyumsuz → köken yok', o2[0] === undefined);
}

// ---------------------------------------------------------------- 5. kesmeyle bölünmüş yan yüz → iki aday
{
  const fs: Feature[] = [
    sketch('S1', rect('a', -50, -30, 50, 30)),
    extrude('E1', 'S1', 20),
    sketch('S2', rect('c', 0, 20, 20, 40)),
    extrude('C1', 'S2', 0, { throughAll: true, extent: 'symmetric', operation: 'cut' }),
  ];
  // +y yan yüzü (y=30) x∈[-50,0] ve x∈[20,50] parçalarına bölündü
  const faces = [
    plane([-25, 30, 10], [0, 1, 0]),
    plane([35, 30, 10], [0, 1, 0]),
    plane([10, 20, 10], [0, 1, 0]), // kesme cebinin tabanı (y=20)
    plane([0, 25, 10], [1, 0, 0]), // cebin sol duvarı (x=0)
  ];
  const o = computeFaceOrigins(fs, faces, 120);
  check('bölünmüş yüz: iki parça aynı köken', o[0]?.entityId === 'aT' && sameOrigin(o[0], o[1]), `${fmt(o[0])} ${fmt(o[1])}`);
  check('bölünmüş yüz: cep yüzleri kesmeye', o[2]?.featureId === 'C1' && o[2]?.entityId === 'cB' && o[3]?.entityId === 'cL', `${fmt(o[2])} ${fmt(o[3])}`);
  const cands = originCandidates([o], o[0]!);
  check('bölünmüş yüz: iki aday', cands.length === 2);
  // Eski imza: bölünmeden önceki tüm yüz (merkez x=0, alan 2000). İmza+alan ile sol parça seçilir.
  const sig = plane([0, 30, 10], [0, 1, 0]);
  const s0 = faceScore(sig, 2000, faces[0], 1000, 120)!;
  const s1 = faceScore(sig, 2000, faces[1], 600, 120)!;
  check('bölünmüş yüz: imza+alan sol parçayı seçer', s0 < s1, `${s0.toFixed(1)} < ${s1.toFixed(1)}`);
}

// ---------------------------------------------------------------- 6. simetrik / iki yönlü kapaklar
{
  const fs: Feature[] = [sketch('S1', rect('a', -5, -5, 5, 5)), extrude('E1', 'S1', 20, { extent: 'symmetric' })];
  const o = computeFaceOrigins(fs, [plane([0, 0, -10], [0, 0, -1]), plane([0, 0, 10], [0, 0, 1]), plane([0, 0, 0], [0, 0, 1])], 30);
  check('simetrik: −d/2 start, +d/2 end, ortada köken yok', o[0]?.cap === 'start' && o[1]?.cap === 'end' && o[2] === undefined);
  const fs2: Feature[] = [sketch('S1', rect('a', -5, -5, 5, 5)), extrude('E1', 'S1', 20, { extent: 'twoSides', distance2: 5, reverse: true })];
  const o2 = computeFaceOrigins(fs2, [plane([0, 0, -20], [0, 0, -1]), plane([0, 0, 5], [0, 0, 1])], 30);
  check('iki yönlü ters: distance tarafı end, distance2 tarafı start', o2[0]?.cap === 'end' && o2[1]?.cap === 'start');
}

// ---------------------------------------------------------------- 7. revolve
{
  // XZ düzlemi: sketch x → dünya x, sketch y → dünya z
  const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const ents: SkEntity[] = [
    ...rect('r', 10, 0, 20, 30),
    { id: 'ax0', kind: 'point', x: 0, y: 0 },
    { id: 'ax1', kind: 'point', x: 0, y: 10 },
    { id: 'axis', kind: 'line', p1: 'ax0', p2: 'ax1', construction: true },
  ];
  const rv: RevolveFeature = { id: 'R1', name: 'R1', suppressed: false, type: 'revolve', sketchId: 'S1', profilePoints: [], axisLineId: 'axis', angle: 360, reverse: false, operation: 'add' };
  const fs: Feature[] = [sketch('S1', ents, XZ), rv];
  const faces = [cyl([0, 0, 15], [0, 0, 1], 20), cyl([0, 0, 15], [0, 0, 1], 10), plane([0, 0, 0], [0, 0, -1]), plane([0, 0, 30], [0, 0, 1])];
  const o = computeFaceOrigins(fs, faces, 50);
  check('revolve: dış/iç silindir eksene paralel çizgilere', o[0]?.entityId === 'rR' && o[1]?.entityId === 'rL', `${fmt(o[0])} ${fmt(o[1])}`);
  check('revolve: alt/üst düzlem eksene dik çizgilere', o[2]?.entityId === 'rB' && o[3]?.entityId === 'rT', `${fmt(o[2])} ${fmt(o[3])}`);
}

// ---------------------------------------------------------------- 8. sonraki özellik / bastırma / kullanılmayan bölge
{
  // İki dikdörtgen yan yana aynı sketch'te; extrude yalnız sol bölgeyi kullanır
  const fs: Feature[] = [
    sketch('S1', [...rect('a', 0, 0, 10, 10), ...rect('b', 20, 0, 30, 10)]),
    extrude('E1', 'S1', 5, { profilePoints: [[5, 5]] }),
  ];
  const o = computeFaceOrigins(fs, [plane([20, 5, 2.5], [-1, 0, 0]), plane([10, 5, 2.5], [1, 0, 0])], 30);
  check('kullanılmayan bölgenin çizgisi aday değil', o[0] === undefined && o[1]?.entityId === 'aR', `${fmt(o[0])} ${fmt(o[1])}`);
  const sup: Feature[] = [fs[0], { ...(fs[1] as ExtrudeFeature), suppressed: true }];
  check('bastırılmış özellik köken vermez', computeFaceOrigins(sup, [plane([10, 5, 2.5], [1, 0, 0])], 30)[0] === undefined);
  check('üretilemeyen özellik köken vermez', computeFaceOrigins(fs, [plane([10, 5, 2.5], [1, 0, 0])], 30, { E1: 'hata' })[0] === undefined);
  // Sonraki kesme aynı düzlemde yan yüz üretir → en son özellik kazanır
  const fs3: Feature[] = [
    sketch('S1', rect('a', 0, 0, 10, 10)),
    extrude('E1', 'S1', 5),
    sketch('S2', rect('c', 4, 6, 10, 10)),
    extrude('C1', 'S2', 2, { reverse: true, operation: 'cut', distance: 2 }),
  ];
  // S2 z=0'da; C1 ters yönde → [-2,0] aralığı kutu dışında; yan yüz z=2.5 → C1 aralığı dışı, E1 kalır
  const o3 = computeFaceOrigins(fs3, [plane([10, 5, 2.5], [1, 0, 0])], 30);
  check('aralık dışı sonraki özellik yüzü almaz', o3[0]?.featureId === 'E1', fmt(o3[0]));
  const fs4: Feature[] = [fs3[0], fs3[1], { ...(sketch('S2', rect('c', 4, 6, 10, 10), { origin: [0, 0, 5], xDir: [1, 0, 0], normal: [0, 0, 1] })) }, extrude('C1', 'S2', 2, { reverse: true, operation: 'cut' })];
  // Cep: x=10 düzleminde z∈[3,5] parçası C1'e (en son), alt kalan parça (z∈[0,3]) yine E1
  const o4 = computeFaceOrigins(fs4, [plane([10, 8, 4], [1, 0, 0]), plane([10, 5, 1.5], [1, 0, 0])], 30);
  check('aynı düzlemde sonraki kesme kazanır', o4[0]?.featureId === 'C1' && o4[0]?.entityId === 'cR' && o4[1]?.featureId === 'E1', `${fmt(o4[0])} ${fmt(o4[1])}`);
}

// ---------------------------------------------------------------- 9. çıkıntı (boss) ve cep kapakları
{
  const top: PlaneDef = { origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const fs: Feature[] = [
    sketch('S1', rect('a', -50, -30, 50, 30)),
    extrude('E1', 'S1', 20),
    sketch('S2', rect('b', -10, -10, 10, 10), top),
    extrude('E2', 'S2', 15),
    sketch('S3', rect('p', 20, -10, 40, 10), top),
    extrude('C1', 'S3', 8, { reverse: true, operation: 'cut' }),
  ];
  const faces = [plane([0, 0, 20], [0, 0, 1]), plane([0, 0, 35], [0, 0, 1]), plane([30, 0, 12], [0, 0, 1]), plane([10, 0, 27.5], [1, 0, 0])];
  const o = computeFaceOrigins(fs, faces, 120);
  check('çıkıntı: taban yüzü kutunun end kapağı', o[0]?.featureId === 'E1' && o[0]?.cap === 'end', fmt(o[0]));
  check('çıkıntı: üst yüz E2 end', o[1]?.featureId === 'E2' && o[1]?.cap === 'end', fmt(o[1]));
  check('cep: taban C1 end', o[2]?.featureId === 'C1' && o[2]?.cap === 'end', fmt(o[2]));
  check('çıkıntı: yan yüz E2 çizgisine', o[3]?.featureId === 'E2' && o[3]?.entityId === 'bR', fmt(o[3]));
}

console.log(`\n${passed} geçti, ${failed} kaldı`);
if (failed) process.exitCode = 1;
