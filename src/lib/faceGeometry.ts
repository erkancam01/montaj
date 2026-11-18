// B-rep yüzeylerinin tanınması (düzlem / silindir / diğer) ve vurgulama geometrisi.
// Tüm hesaplar parça-yerel koordinatta (mesh koordinatı = parça-yerel) yapılır.
import { BufferAttribute, BufferGeometry } from 'three';
import type { Doc, FaceGeom, FaceRef, Part, Transform, Vec3 } from '../types';
import { geometryCache, type ParsedMesh } from './geometryCache';

// ---------------------------------------------------------------- Yüz arama

/** Üçgen indeksinin ait olduğu yüz indeksi (mesh.faces içinde); yoksa -1 */
export function faceAtTriangle(mesh: ParsedMesh, triangle: number): number {
  const faces = mesh.faces;
  let lo = 0;
  let hi = faces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = faces[mid];
    if (triangle < f.first) hi = mid - 1;
    else if (triangle > f.last) lo = mid + 1;
    else return mid;
  }
  // Aralıklar sıralı değilse (beklenmez) doğrusal tarama
  for (let i = 0; i < faces.length; i++) {
    if (triangle >= faces[i].first && triangle <= faces[i].last) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- Sınıflandırma

/** Düzlem: tüm üçgen normalleri ortalama normale bu açı içinde */
const PLANE_COS = Math.cos((1 * Math.PI) / 180);
/** Silindir: en küçük özdeğer / en büyük özdeğer bundan küçük olmalı (normaller eksene ~dik) */
const CYL_EIG_RATIO = 1e-3;
/** Silindir: çember uydurma artığı (rms) / yarıçap */
const CYL_FIT_TOL = 0.01;
/** Bundan küçük alanlı (mm²) yüzey tanınmaz */
const MIN_AREA = 1e-8;

const OTHER: FaceGeom = { kind: 'other' };

interface CacheEntry {
  mesh: ParsedMesh;
  geom: FaceGeom;
}
const geomCache = new Map<string, CacheEntry>();

/**
 * Yüzeyin parça-yerel geometrisi (düzlem / silindir / diğer). Önbelleğe alınır.
 * Parçanın dosyası yüklenmemişse ya da referans geçersizse null.
 */
export function getFaceGeom(part: Pick<Part, 'fileId' | 'nodeKey'>, meshIndex: number, faceIndex: number): FaceGeom | null {
  const mesh = geometryCache.get(part.fileId)?.nodes[part.nodeKey]?.meshes[meshIndex];
  if (!mesh || !(faceIndex >= 0 && faceIndex < mesh.faces.length)) return null;
  const key = `${part.fileId}:${part.nodeKey}:${meshIndex}:${faceIndex}`;
  const hit = geomCache.get(key);
  // Dosya yeniden ayrıştırıldıysa (aynı id, yeni mesh) önbellek geçersiz
  if (hit && hit.mesh === mesh) return hit.geom;
  const geom = classifyFace(mesh, faceIndex);
  geomCache.set(key, { mesh, geom });
  return geom;
}

/** Simetrik 3x3 matrisin özdeğer/özvektörleri (Jacobi). a satır-öncelikli, yerinde bozulur. v sütunları özvektör. */
function jacobi3(a: number[], v: number[]): void {
  v.splice(0, 9, 1, 0, 0, 0, 1, 0, 0, 0, 1);
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    const scale = Math.abs(a[0]) + Math.abs(a[4]) + Math.abs(a[8]);
    if (off <= 1e-15 * scale || off === 0) return;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p * 3 + q];
        if (apq === 0) continue;
        const app = a[p * 3 + p];
        const aqq = a[q * 3 + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          // A = Jᵀ A J
          const akp = a[k * 3 + p];
          const akq = a[k * 3 + q];
          a[k * 3 + p] = c * akp - s * akq;
          a[k * 3 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p * 3 + k];
          const aqk = a[q * 3 + k];
          a[p * 3 + k] = c * apk - s * aqk;
          a[q * 3 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p];
          const vkq = v[k * 3 + q];
          v[k * 3 + p] = c * vkp - s * vkq;
          v[k * 3 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
}

/** En büyük mutlak bileşeni pozitif olacak şekilde işaret seçer */
function canonicalSign(x: number, y: number, z: number): Vec3 {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const m = ax >= ay && ax >= az ? x : ay >= az ? y : z;
  return m < 0 ? [-x, -y, -z] : [x, y, z];
}

function classifyFace(mesh: ParsedMesh, faceIndex: number): FaceGeom {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return OTHER;
  const nrm = geo.getAttribute('normal');
  const index = geo.index;
  const { first, last } = mesh.faces[faceIndex];
  const triMax = (index ? index.count : pos.count) / 3 - 1;
  const t0 = Math.max(0, first);
  const t1 = Math.min(last, triMax);
  const n = t1 - t0 + 1;
  if (n <= 0) return OTHER;

  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);

  // Üçgen normalleri (|cross| = 2·alan) ve ağırlık merkezleri
  const tn = new Float64Array(n * 3); // birim normaller
  const ta = new Float64Array(n); // alanlar
  let sx = 0, sy = 0, sz = 0; // Σ cross (alan ağırlıklı normal)
  let cx = 0, cy = 0, cz = 0; // Σ alan·merkez
  let area = 0;
  let windingVote = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i;
    const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
    const x0 = pos.getX(i0), y0 = pos.getY(i0), z0 = pos.getZ(i0);
    const ux = pos.getX(i1) - x0, uy = pos.getY(i1) - y0, uz = pos.getZ(i1) - z0;
    const wx = pos.getX(i2) - x0, wy = pos.getY(i2) - y0, wz = pos.getZ(i2) - z0;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const a = len / 2;
    ta[i] = a;
    if (len > 0) {
      tn[i * 3] = nx / len;
      tn[i * 3 + 1] = ny / len;
      tn[i * 3 + 2] = nz / len;
    }
    sx += nx; sy += ny; sz += nz;
    area += a;
    cx += a * (x0 + (ux + wx) / 3);
    cy += a * (y0 + (uy + wy) / 3);
    cz += a * (z0 + (uz + wz) / 3);
    if (nrm) {
      const vx = nrm.getX(i0) + nrm.getX(i1) + nrm.getX(i2);
      const vy = nrm.getY(i0) + nrm.getY(i1) + nrm.getY(i2);
      const vz = nrm.getZ(i0) + nrm.getZ(i1) + nrm.getZ(i2);
      windingVote += nx * vx + ny * vy + nz * vz;
    }
  }
  if (!(area > MIN_AREA)) return OTHER;
  // Sargı vertex normalleriyle ters ise dış yön tersidir
  const sign = windingVote < 0 ? -1 : 1;
  cx /= area; cy /= area; cz /= area;

  // ---- Düzlem
  const slen = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (slen > 0) {
    const mx = sx / slen, my = sy / slen, mz = sz / slen;
    const tinyArea = (area / n) * 1e-3; // çok ince üçgenlerin sayısal gürültüsünü yok say
    let planar = true;
    for (let i = 0; i < n; i++) {
      if (ta[i] <= tinyArea) continue;
      if (tn[i * 3] * mx + tn[i * 3 + 1] * my + tn[i * 3 + 2] * mz < PLANE_COS) {
        planar = false;
        break;
      }
    }
    if (planar) {
      return { kind: 'plane', point: [cx, cy, cz], normal: [sign * mx, sign * my, sign * mz] };
    }
  }

  // ---- Silindir: M = Σ w n nᵀ, eksen = en küçük özdeğerin özvektörü
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = ta[i];
    const x = tn[i * 3], y = tn[i * 3 + 1], z = tn[i * 3 + 2];
    M[0] += w * x * x; M[1] += w * x * y; M[2] += w * x * z;
    M[4] += w * y * y; M[5] += w * y * z; M[8] += w * z * z;
  }
  M[3] = M[1]; M[6] = M[2]; M[7] = M[5];
  const V: number[] = [];
  jacobi3(M, V);
  const ev = [M[0], M[4], M[8]];
  const order = [0, 1, 2].sort((p, q) => ev[p] - ev[q]);
  const lMin = ev[order[0]], lMid = ev[order[1]], lMax = ev[order[2]];
  if (!(lMax > 0) || lMin > CYL_EIG_RATIO * lMax || lMid < 10 * Math.max(lMin, 0) + 1e-6 * lMax) return OTHER;
  const k = order[0];
  const [dx, dy, dz] = canonicalSign(V[k], V[3 + k], V[6 + k]);
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // Yüzün benzersiz köşeleri (ağırlık merkezine göre). Tessellation köşeleri gerçek yüzeyin üzerindedir.
  const seen = new Set<number>();
  const qs: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const j = vi(t0 + i, c);
      if (seen.has(j)) continue;
      seen.add(j);
      qs.push(pos.getX(j) - cx, pos.getY(j) - cy, pos.getZ(j) - cz);
    }
  }
  const nv = qs.length / 3;
  if (nv < 6) return OTHER;

  /** a eksenine dik düzlemde Kasa çember uydurması ve geometrik rms artığı */
  const fitFor = (ax: number, ay: number, az: number) => {
    let ux: number, uy: number, uz: number;
    if (Math.abs(ax) < 0.9) { ux = 0; uy = az; uz = -ay; } else { ux = -az; uy = 0; uz = ax; }
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    let s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, r1 = 0, r2 = 0, r3 = 0;
    let tMin = Infinity, tMax = -Infinity;
    for (let i = 0; i < nv; i++) {
      const qx = qs[i * 3], qy = qs[i * 3 + 1], qz = qs[i * 3 + 2];
      const x = qx * ux + qy * uy + qz * uz;
      const y = qx * vx + qy * vy + qz * vz;
      const t = qx * ax + qy * ay + qz * az;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      const rr = x * x + y * y;
      s11 += x * x; s12 += x * y; s13 += x;
      s22 += y * y; s23 += y;
      r1 += rr * x; r2 += rr * y; r3 += rr;
    }
    const s33 = nv;
    // x²+y² = A x + B y + C (Cramer)
    const det = s11 * (s22 * s33 - s23 * s23) - s12 * (s12 * s33 - s23 * s13) + s13 * (s12 * s23 - s22 * s13);
    if (!(Math.abs(det) > 1e-300)) return null;
    const A = (r1 * (s22 * s33 - s23 * s23) - s12 * (r2 * s33 - s23 * r3) + s13 * (r2 * s23 - s22 * r3)) / det;
    const B = (s11 * (r2 * s33 - r3 * s23) - r1 * (s12 * s33 - s23 * s13) + s13 * (s12 * r3 - r2 * s13)) / det;
    const C = (s11 * (s22 * r3 - s23 * r2) - s12 * (s12 * r3 - r2 * s13) + r1 * (s12 * s23 - s22 * s13)) / det;
    const ccx = A / 2, ccy = B / 2;
    const r2c = C + ccx * ccx + ccy * ccy;
    if (!(r2c > 0)) return null;
    const radius = Math.sqrt(r2c);
    let err = 0;
    for (let i = 0; i < nv; i++) {
      const qx = qs[i * 3], qy = qs[i * 3 + 1], qz = qs[i * 3 + 2];
      const x = qx * ux + qy * uy + qz * uz;
      const y = qx * vx + qy * vy + qz * vz;
      const d = Math.hypot(x - ccx, y - ccy) - radius;
      err += d * d;
    }
    return { rms: Math.sqrt(err / nv), ccx, ccy, radius, u: [ux, uy, uz], v: [vx, vy, vz], tMin, tMax, a: [ax, ay, az] };
  };

  let best = fitFor(dx / dl, dy / dl, dz / dl);
  if (!best) return OTHER;
  // İnce ayar: üçgen normallerinden gelen eksen tessellation yüzünden ~0.02° sapabilir.
  // Köşe noktalarına çember uydurma artığını en aza indiren yönü koordinat aramasıyla bul.
  let step = 2e-3;
  for (let iter = 0; iter < 400 && step > 1e-9; iter++) {
    let improved = false;
    for (const [su, sv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = best;
      let bx = b.a[0] + step * (su * b.u[0] + sv * b.v[0]);
      let by = b.a[1] + step * (su * b.u[1] + sv * b.v[1]);
      let bz = b.a[2] + step * (su * b.u[2] + sv * b.v[2]);
      const bl = Math.sqrt(bx * bx + by * by + bz * bz);
      bx /= bl; by /= bl; bz /= bl;
      const f = fitFor(bx, by, bz);
      if (f && f.rms < b.rms) {
        best = f;
        improved = true;
        break;
      }
    }
    if (!improved) step /= 2;
  }
  const { ccx, ccy, radius, u, v, tMin, tMax } = best;
  if (!(best.rms <= CYL_FIT_TOL * radius)) return OTHER;
  const [ax, ay, az] = best.a;
  const tMid = (tMin + tMax) / 2;
  const point: Vec3 = [
    cx + ccx * u[0] + ccy * v[0] + tMid * ax,
    cy + ccx * u[1] + ccy * v[1] + tMid * ay,
    cz + ccx * u[2] + ccy * v[2] + tMid * az,
  ];
  return { kind: 'cylinder', point, axis: canonicalSign(ax, ay, az), radius };
}

// ---------------------------------------------------------------- Vurgulama

const highlightCache = new WeakMap<ParsedMesh, Map<number, BufferGeometry>>();

/** Yüzeyi gösteren alt geometri (aynı position özniteliğini paylaşır, parça-yerel). Önbelleğe alınır. */
export function faceHighlightGeometry(mesh: ParsedMesh, faceIndex: number): BufferGeometry | null {
  const face = mesh.faces[faceIndex];
  if (!face) return null;
  let perMesh = highlightCache.get(mesh);
  const hit = perMesh?.get(faceIndex);
  if (hit) return hit;
  const src = mesh.geometry;
  const pos = src.getAttribute('position');
  if (!pos) return null;
  const index = src.index;
  const triMax = (index ? index.count : pos.count) / 3 - 1;
  const t0 = Math.max(0, face.first);
  const t1 = Math.min(face.last, triMax);
  if (t1 < t0) return null;
  const count = (t1 - t0 + 1) * 3;
  const idx = pos.count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) idx[i] = index ? index.getX(t0 * 3 + i) : t0 * 3 + i;
  const g = new BufferGeometry();
  g.setAttribute('position', pos);
  const nrm = src.getAttribute('normal');
  if (nrm) g.setAttribute('normal', nrm);
  g.setIndex(new BufferAttribute(idx, 1));
  if (src.boundingSphere) g.boundingSphere = src.boundingSphere.clone();
  if (src.boundingBox) g.boundingBox = src.boundingBox.clone();
  if (!perMesh) highlightCache.set(mesh, (perMesh = new Map()));
  perMesh.set(faceIndex, g);
  return g;
}

// ---------------------------------------------------------------- Dünya dönüşümü

/** v'yi birim q quaternion'u ile döndürür (q = [x, y, z, w]) */
function rotate(q: readonly number[], v: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const [vx, vy, vz] = v;
  // t = 2 q×v ; v' = v + w t + q×t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

function transformPoint(t: Transform, p: Vec3): Vec3 {
  const r = rotate(t.quaternion, p);
  return [r[0] + t.position[0], r[1] + t.position[1], r[2] + t.position[2]];
}

/** Yerel FaceGeom'u verilen dünya dönüşümüyle dünyaya taşır */
export function faceGeomToWorld(g: FaceGeom, world: Transform): FaceGeom {
  switch (g.kind) {
    case 'plane':
      return { kind: 'plane', point: transformPoint(world, g.point), normal: rotate(world.quaternion, g.normal) };
    case 'cylinder':
      return {
        kind: 'cylinder',
        point: transformPoint(world, g.point),
        axis: rotate(world.quaternion, g.axis),
        radius: g.radius,
      };
    default:
      return g;
  }
}

/** FaceRef'in dünya koordinatındaki geometrisi (doc'taki parça + instance dönüşümüyle); bulunamazsa null */
export function worldFaceGeom(ref: FaceRef, doc: Doc): FaceGeom | null {
  const part = doc.parts.find((p) => p.id === ref.partId);
  if (!part) return null;
  const inst = doc.instances.find((i) => i.id === part.instanceId);
  if (!inst) return null;
  const g = getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  if (!g) return null;
  // partWorld ile aynı: dünya = instance ∘ part (ölçek 1)
  const world: Transform = {
    position: transformPoint(inst, part.position),
    quaternion: mulQuat(inst.quaternion, part.quaternion),
  };
  return faceGeomToWorld(g, world);
}

function mulQuat(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
