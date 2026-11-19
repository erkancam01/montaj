// Montajı tek STEP dosyasına yazma (worker'dan bağımsız; setOC() önceden çağrılmış olmalı).
import { cast, exportSTEP, getOC, importSTEP, iterTopo, makeCompound, type AnyShape } from 'replicad';
import type { Transform, Vec3 } from '@/core/types';
import { buildShape } from '@/services/kernel/build';
import type { ExportItem } from '@/services/kernel/kernelApi';

/** Aday katı: kaynak STEP içindeki bir parça ve kutusu */
interface Candidate {
  shape: AnyShape;
  center: Vec3;
  size: Vec3;
  used: boolean;
}

/** Şekli dönüşümle konumlar (orijinali tüketmez) */
export function placeShape<T extends AnyShape>(shape: T, t: Transform): T {
  let s = shape.clone() as T;
  const [x, y, z, w] = t.quaternion;
  const sinHalf = Math.hypot(x, y, z);
  if (sinHalf > 1e-12) {
    const angle = (2 * Math.atan2(sinHalf, w) * 180) / Math.PI;
    s = s.rotate(angle, [0, 0, 0], [x / sinHalf, y / sinHalf, z / sinHalf]) as T;
  }
  const p = t.position;
  if (p[0] || p[1] || p[2]) s = s.translate(p) as T;
  return s;
}

/** Sıkı (geometrik) sınırlayıcı kutu; mümkünse BRepBndLib.AddOptimal */
function tightBox(shape: AnyShape): { center: Vec3; size: Vec3 } {
  let min: Vec3;
  let max: Vec3;
  try {
    const oc = getOC() as unknown as Record<string, any>;
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.AddOptimal(shape.wrapped, box, false, false);
    const a = box.CornerMin();
    const b = box.CornerMax();
    min = [a.X(), a.Y(), a.Z()];
    max = [b.X(), b.Y(), b.Z()];
    box.delete();
  } catch {
    [min, max] = shape.boundingBox.bounds as [Vec3, Vec3];
  }
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/** STEP içindeki eşlenebilir parçalar: katılar; katı yoksa kabuklar; o da yoksa yüzler (tek küme) */
function candidatesOf(root: AnyShape): Candidate[] {
  const list: AnyShape[] = [];
  for (const s of iterTopo(root.wrapped, 'solid')) list.push(cast(s));
  if (!list.length) for (const s of iterTopo(root.wrapped, 'shell')) list.push(cast(s));
  if (!list.length) {
    const faces = [...iterTopo(root.wrapped, 'face')].map((f) => cast(f));
    if (faces.length) list.push(makeCompound(faces));
  }
  return list.map((shape) => ({ shape, ...tightBox(shape), used: false }));
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export async function exportAssembly(
  items: ExportItem[],
  blobs: Record<string, Blob>,
): Promise<{ blob: Blob; warnings: string[] }> {
  const warnings: string[] = [];
  const out: { shape: AnyShape; name: string; color: string }[] = [];
  const files = new Map<string, Candidate[] | null>();

  const imports: Extract<ExportItem, { kind: 'import' }>[] = [];
  for (const it of items) {
    if (it.kind === 'body') {
      const { shape, featureErrors } = buildShape(it.body);
      const nErr = Object.keys(featureErrors).length;
      if (nErr) warnings.push(`${it.name}: ${nErr} özellik üretilemedi`);
      if (!shape) {
        warnings.push(`${it.name}: katı yok, atlandı`);
        continue;
      }
      out.push({ shape: placeShape(shape, it.world), name: it.name, color: it.color ?? '#b4b4b4' });
    } else imports.push(it);
  }

  // Dosyaları bir kez oku
  for (const it of imports) {
    if (files.has(it.fileId)) continue;
    const blob = blobs[it.fileId];
    if (!blob) {
      warnings.push(`${it.fileName}: kaynak dosya yok`);
      files.set(it.fileId, null);
      continue;
    }
    try {
      files.set(it.fileId, candidatesOf(await importSTEP(blob)));
    } catch {
      warnings.push(`${it.fileName}: STEP dosyası okunamadı`);
      files.set(it.fileId, null);
    }
  }

  // Açgözlü eşleme: tüm (öğe, aday) çiftleri puana göre
  const pairs: { i: number; c: Candidate; score: number }[] = [];
  imports.forEach((it, i) => {
    const cands = files.get(it.fileId);
    if (!cands) return;
    const scale = Math.hypot(...it.nodeSize);
    const tol = Math.max(0.05, scale * 0.02);
    for (const c of cands) {
      const dc = dist(c.center, it.nodeCenter);
      const ds = dist(c.size, it.nodeSize);
      if (dc <= tol && ds <= tol * 2) pairs.push({ i, c, score: dc + 0.5 * ds });
    }
  });
  pairs.sort((a, b) => a.score - b.score);
  const matched = new Map<number, Candidate>();
  for (const p of pairs) {
    if (matched.has(p.i) || p.c.used) continue;
    p.c.used = true;
    matched.set(p.i, p.c);
  }
  imports.forEach((it, i) => {
    const c = matched.get(i);
    if (!c) {
      if (files.get(it.fileId)) warnings.push(`${it.name}: kaynak STEP'te eşleşen katı bulunamadı, atlandı`);
      return;
    }
    out.push({ shape: placeShape(c.shape, it.world), name: it.name, color: it.color ?? '#b4b4b4' });
  });

  if (!out.length) throw new Error('Dışa aktarılacak katı yok');
  const blob = exportSTEP(
    out.map((o) => ({ shape: o.shape, name: o.name, color: o.color })),
    { unit: 'mm', modelUnit: 'mm' },
  );
  return { blob, warnings };
}

