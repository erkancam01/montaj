// Mate çözücü + serbestlik analizi testleri. Çalıştırma: node scripts/run-ts.mjs scripts/mate-tests.ts
import { Quaternion, Vector3 } from 'three';
import { solveMates, type SolveOptions } from '../src/core/assembly/mateSolver';
import { partDofStates } from '../src/core/assembly/dof';
import type { Doc, FaceGeom, Instance, Mate, MateType, Part, Quat, Vec3 } from '../src/core/types';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, info = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`);
}

const ID: Quat = [0, 0, 0, 1];
const inst: Instance = { id: 'I', fileId: 'f', name: 'I', position: [0, 0, 0], quaternion: ID, origin: { position: [0, 0, 0], quaternion: ID }, visible: true };

function part(id: string, position: Vec3, quaternion: Quat = ID, fixed?: boolean): Part {
  const p: Part = { id, instanceId: 'I', fileId: 'f', nodeKey: 0, name: id, position, quaternion, origin: { position, quaternion }, visible: true, color: null };
  if (fixed !== undefined) p.fixed = fixed;
  return p;
}

/** Parça-yerel yüzeyler: faceIndex → geometri */
const FACES: FaceGeom[] = [
  { kind: 'cylinder', point: [0, 0, 0], axis: [0, 0, 1], radius: 5 }, // 0: z ekseni
  { kind: 'plane', point: [0, 0, 0], normal: [0, 0, 1] }, // 1: üst (+z)
  { kind: 'plane', point: [0, 0, 0], normal: [0, 0, -1] }, // 2: alt (−z)
  { kind: 'plane', point: [10, 0, 0], normal: [1, 0, 0] }, // 3: +x yüzü
];
const geomOf: SolveOptions['geomOf'] = (_p, _m, f) => FACES[f] ?? null;

function mate(id: string, type: MateType, a: string, fa: number, b: string, fb: number, extra: Partial<Mate> = {}): Mate {
  return {
    id,
    name: id,
    type,
    a: { partId: a, meshIndex: 0, faceIndex: fa },
    b: { partId: b, meshIndex: 0, faceIndex: fb },
    offset: 0,
    angle: 90,
    flip: false,
    suppressed: false,
    ...extra,
  };
}

function doc(parts: Part[], mates: Mate[]): Doc {
  return { files: [], instances: [inst], parts, mates, groups: [], bodies: [] };
}

const q = (axis: Vec3, deg: number): Quat => {
  const r = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180);
  return [r.x, r.y, r.z, r.w];
};
const mul = (a: Quat, b: Quat): Quat => {
  const r = new Quaternion(...a).multiply(new Quaternion(...b));
  return [r.x, r.y, r.z, r.w];
};
const get = (d: Doc, id: string) => d.parts.find((p) => p.id === id)!;
const axisOf = (p: Part) => new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...p.quaternion));
const xOf = (p: Part) => new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...p.quaternion));
const angZ = (p: Part) => {
  const x = xOf(p);
  return (Math.atan2(x.y, x.x) * 180) / Math.PI;
};
const near = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;
const fmt = (v: number[]) => v.map((x) => x.toFixed(4)).join(', ');

/** Sürükleme benzetimi: B'yi hedef dönüşüme koy, B tutulu olarak çöz */
function drag(base: Doc, id: string, position: Vec3, quaternion: Quat, held = true): Doc {
  const next = { ...base, parts: base.parts.map((p) => (p.id === id ? { ...p, position, quaternion } : p)) };
  return solveMates(base, next, { held: held ? [id] : undefined, geomOf }).doc;
}

// 1) Serbest gövde: mate yok → hedefe aynen gider
{
  const d0 = doc([part('A', [0, 0, 0], ID, true), part('B', [0, 0, 20])], []);
  const target = q([1, 1, 0], 25);
  const r = drag(d0, 'B', [5, 6, 7], target);
  const b = get(r, 'B');
  check('serbest gövde hedefe gider', near(b.position[0], 5) && near(b.position[2], 7) && near(b.quaternion[3], target[3]));
}

// 2) Eşmerkezli: eksen etrafında dönme + eksen boyunca kayma kalır
const concentric = doc([part('A', [0, 0, 0], ID, true), part('B', [0, 0, 20])], [mate('c', 'concentric', 'A', 0, 'B', 0)]);
{
  const target = mul(q([1, 0, 0], 10), q([0, 0, 1], 30));
  const r = drag(concentric, 'B', [5, 3, 27], target);
  const b = get(r, 'B');
  const ax = axisOf(b);
  check(
    'eşmerkezli: eksene dik kayma düzeltilir, eksen boyunca kayma kalır',
    near(b.position[0], 0) && near(b.position[1], 0) && Math.abs(b.position[2] - 20) > 3,
    `pos=${fmt(b.position)}`,
  );
  check('eşmerkezli: eksen hizalı', near(ax.z, 1, 1e-6), `axis=${fmt([ax.x, ax.y, ax.z])}`);
  check('eşmerkezli: eksen etrafında dönme kalır', near(angZ(b), 30, 1.5), `açı=${angZ(b).toFixed(2)}`);
  check('eşmerkezli: sabit A kıpırdamaz', get(r, 'A') === get(concentric, 'A'));
}

// 3) Eşmerkezli + çakışık: yalnız dönme
const concCoinc = doc(
  [part('A', [0, 0, 0], ID, true), part('B', [0, 0, 0])],
  [mate('c', 'concentric', 'A', 0, 'B', 0), mate('k', 'coincident', 'A', 1, 'B', 2)],
);
{
  const target = mul(q([0, 1, 0], 8), q([0, 0, 1], -40));
  const r = drag(concCoinc, 'B', [4, -2, 9], target);
  const b = get(r, 'B');
  check('eşmerkezli+çakışık: konum değişmez', near(b.position[0], 0) && near(b.position[1], 0) && near(b.position[2], 0), `pos=${fmt(b.position)}`);
  check('eşmerkezli+çakışık: eksen etrafında dönme kalır', near(angZ(b), -40, 1.5), `açı=${angZ(b).toFixed(2)}`);
}

// 4) Tam tanımlı (eşmerkezli + çakışık + paralel): kıpırdamaz
const full = doc(
  [part('A', [0, 0, 0], ID, true), part('B', [0, 0, 0])],
  [mate('c', 'concentric', 'A', 0, 'B', 0), mate('k', 'coincident', 'A', 1, 'B', 2), mate('p', 'parallel', 'A', 3, 'B', 3)],
);
{
  const r = drag(full, 'B', [4, -2, 9], mul(q([0, 1, 0], 8), q([0, 0, 1], -40)));
  const b = get(r, 'B');
  check('tam tanımlı: kıpırdamaz', near(b.position[0], 0) && near(b.position[2], 0) && near(Math.abs(b.quaternion[3]), 1, 1e-6), `pos=${fmt(b.position)} q=${fmt(b.quaternion)}`);
}

// 5) Sabit parça b tarafında olsa da hareket etmez; a tarafı yer değiştirir
{
  const d0 = doc([part('A', [0, 0, 0], ID, true), part('B', [7, 7, 7])], [mate('c', 'concentric', 'B', 0, 'A', 0)]);
  const r = solveMates(d0, { ...d0, mates: [...d0.mates] }, { geomOf }).doc;
  const a = get(r, 'A');
  const b = get(r, 'B');
  check('sabit b tarafında: sabit kıpırdamaz', a === get(d0, 'A'));
  check('sabit b tarafında: diğer parça eksene gelir', near(b.position[0], 0) && near(b.position[1], 0) && near(b.position[2], 7), `pos=${fmt(b.position)}`);
}

// 6) Sabite bağlı olmayan serbest parça, tutulan parçayı izler (yön a=C → b=B olsa bile)
{
  const d0 = doc(
    [part('A', [100, 0, 0], ID, true), part('B', [0, 0, 0]), part('C', [0, 0, 30])],
    [mate('c', 'concentric', 'C', 0, 'B', 0)],
  );
  const r = drag(d0, 'B', [10, 0, 0], ID);
  check('serbest bağlı parça tutulanı izler', near(get(r, 'B').position[0], 10) && near(get(r, 'C').position[0], 10) && near(get(r, 'C').position[2], 30), `B=${fmt(get(r, 'B').position)} C=${fmt(get(r, 'C').position)}`);
  // tutma yoksa eski davranış: b (B) a'ya (C) geri çekilir
  const r2 = drag(d0, 'B', [10, 0, 0], ID, false);
  check('tutma yoksa eski yön (a referans)', near(get(r2, 'B').position[0], 0) && near(get(r2, 'C').position[0], 0), `B=${fmt(get(r2, 'B').position)}`);
}

// 7) Zincir: sabit A — B (eşmerkezli) — C (eşmerkezli, a=C). B sürüklenince C de gelir (C sabite yalnız B üzerinden bağlı)
{
  const d0 = doc(
    [part('A', [0, 0, 0], ID, true), part('B', [0, 0, 20]), part('C', [0, 0, 40])],
    [mate('ab', 'concentric', 'A', 0, 'B', 0), mate('cb', 'concentric', 'C', 0, 'B', 0)],
  );
  const r = drag(d0, 'B', [3, 0, 30], ID);
  const b = get(r, 'B');
  const c = get(r, 'C');
  check('zincir: B eksende kayar', near(b.position[0], 0) && near(b.position[2], 30), `B=${fmt(b.position)}`);
  check('zincir: C, B ile gelir', near(c.position[0], 0) && near(c.position[2], 50), `C=${fmt(c.position)}`);
}

// 8) Eski proje (mate'ler sağlanmış): çözüm belgeyi değiştirmez
{
  const r1 = solveMates(concCoinc, concCoinc, { geomOf });
  const noFixed = { ...concCoinc, parts: concCoinc.parts.map((p) => ({ ...p, fixed: undefined })) };
  const r2 = solveMates(noFixed, noFixed, { geomOf });
  check('sağlanmış mate: belge aynı (sabitli)', r1.doc === concCoinc && Object.values(r1.status).every((s) => s.state === 'ok'));
  check('sağlanmış mate: belge aynı (sabitsiz)', r2.doc === noFixed && Object.values(r2.status).every((s) => s.state === 'ok'));
}

// 9) Serbestlik işaretleri
{
  const free = doc([part('A', [0, 0, 0], ID, true), part('B', [0, 0, 0])], []);
  const s0 = partDofStates(free, geomOf);
  const s1 = partDofStates(concentric, geomOf);
  const s2 = partDofStates(concCoinc, geomOf);
  const s3 = partDofStates(full, geomOf);
  check('dof: sabit → fixed', s0.get('A') === 'fixed');
  check('dof: mate yok → under', s0.get('B') === 'under');
  check('dof: eşmerkezli → under', s1.get('B') === 'under');
  check('dof: eşmerkezli+çakışık → under', s2.get('B') === 'under');
  check('dof: +paralel → full', s3.get('B') === 'full', String(s3.get('B')));
  const noRoot = { ...full, parts: full.parts.map((p) => ({ ...p, fixed: false })) };
  check('dof: sabit yoksa → under', partDofStates(noRoot, geomOf).get('B') === 'under');
}

// 10) Eski çözücüyle karşılaştırma (sabit/tutma yok → sonuç aynı); scripts/old-solver.ts varsa
try {
  const old = (await import('./old-solver' as string)) as { solveMates: (p: Doc, n: Doc) => { doc: Doc } };
  (globalThis as { __geomOf?: unknown }).__geomOf = geomOf;
  let same = true;
  const rnd = (() => {
    let s = 12345;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  })();
  for (let t = 0; t < 30; t++) {
    const parts = ['P', 'Q', 'R'].map((id, i) => part(id, [rnd() * 50, rnd() * 50, rnd() * 50 + i], q([rnd(), rnd(), rnd() + 0.01], rnd() * 90)));
    const mates = [mate('m1', 'concentric', 'P', 0, 'Q', 0), mate('m2', 'coincident', 'Q', 1, 'R', 2, { offset: 3 }), mate('m3', 'parallel', 'P', 3, 'R', 3)];
    const prev = doc(parts, mates);
    const next = { ...prev, parts: prev.parts.map((p) => (p.id === 'P' ? { ...p, position: [1, 2, 3] as Vec3 } : p)) };
    const a = old.solveMates(prev, next).doc;
    const b = solveMates(prev, next, { geomOf }).doc;
    for (const p of a.parts) {
      const o = b.parts.find((x) => x.id === p.id)!;
      const dd = Math.max(...p.position.map((v, i) => Math.abs(v - o.position[i])), ...p.quaternion.map((v, i) => Math.abs(v - o.quaternion[i])));
      if (dd > 1e-9) same = false;
    }
  }
  check('eski çözücüyle aynı sonuç (sabit/tutma yok, 30 rastgele senaryo)', same);
} catch (e) {
  console.log('(eski çözücü karşılaştırması atlandı:', e instanceof Error ? e.message : e, ')');
}

console.log(`\n${passed} geçti, ${failed} kaldı`);
if (failed) process.exit(1);
