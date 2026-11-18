import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Instance, Part, Quat, Transform, Vec3 } from '../types';

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function quatFromEulerDeg(e: Vec3): Quat {
  const q = new Quaternion().setFromEuler(
    new Euler(MathUtils.degToRad(e[0]), MathUtils.degToRad(e[1]), MathUtils.degToRad(e[2]), 'XYZ'),
  );
  return [q.x, q.y, q.z, q.w];
}

export function eulerDegFromQuat(q: Quat): Vec3 {
  const e = new Euler().setFromQuaternion(new Quaternion(...q), 'XYZ');
  const r = (v: number) => {
    const d = MathUtils.radToDeg(v);
    return Math.abs(d) < 1e-9 ? 0 : d;
  };
  return [r(e.x), r(e.y), r(e.z)];
}

function matrixOf(t: Transform): Matrix4 {
  return new Matrix4().compose(new Vector3(...t.position), new Quaternion(...t.quaternion), new Vector3(1, 1, 1));
}

function transformOf(m: Matrix4): Transform {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
}

/** Parçanın dünya dönüşümü (instance ∘ part) */
export function partWorld(inst: Instance, part: Part): Transform {
  return transformOf(matrixOf(inst).multiply(matrixOf(part)));
}

/** Dünya dönüşümünden parçanın instance'a göre yerel dönüşümünü hesaplar */
export function partLocalFromWorld(inst: Instance, world: Transform): Transform {
  return transformOf(matrixOf(inst).invert().multiply(matrixOf(world)));
}

/** a ∘ b (önce b, sonra a) */
export function composeT(a: Transform, b: Transform): Transform {
  return transformOf(matrixOf(a).multiply(matrixOf(b)));
}

export function invertT(t: Transform): Transform {
  return transformOf(matrixOf(t).invert());
}

/** child'ın parent'a göre göreli dönüşümü: parent⁻¹ ∘ child */
export function relT(parent: Transform, child: Transform): Transform {
  return transformOf(matrixOf(parent).invert().multiply(matrixOf(child)));
}

export const IDENTITY_T = (): Transform => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
