// Kalıcı mate çözücüsü: sıralı (Gauss–Seidel tarzı), her mate'in b gövdesini en küçük düzeltmeyle taşır.
// Gövde = rijit grup (tüm üyeleri birlikte) ya da gruba ait olmayan tek parça.
import { Quaternion, Vector3 } from 'three';
import type { Doc, FaceGeom, Group, Instance, Mate, MateStatus, Part, Transform, Vec3 } from '../types';
import { getFaceGeom, worldFaceGeom } from './faceGeometry';
import { partLocalFromWorld } from './math';
import { lockedPartIds } from '../modeling/refLocks';

export interface SolveResult {
  /** Değişiklik yoksa `next` ile AYNI nesne döner */
  doc: Doc;
  status: Record<string, MateStatus>;
}

const MAX_ROUNDS = 30;
/** Yakınsama eşikleri (mm, rad) */
const CONV_POS = 1e-4;
const CONV_ANG = 1e-5;
/**
 * "Sağlandı" sayılma eşikleri (mm, rad). Yüzey geometrisi tessellation'dan uydurulduğu için
 * çok sıkı tutulmaz: gerçek montajlarda tutarlı mate'ler ~1e-3 mertebesinde artık bırakabilir.
 */
const OK_POS = 1e-2;
const OK_ANG = 5e-4;
/** Dönüşüm "değişti" eşiği */
const EPS_CHANGE = 1e-9;

const MSG_CYCLE = "Döngü: bu mate başka mate'lerle çevrim oluşturuyor";
const MSG_CONFLICT = "Çelişkili: diğer mate'lerle birlikte sağlanamıyor";
const MSG_SELF = 'Aynı parçanın iki yüzeyi arasında mate kurulamaz';
const MSG_LOCKED = 'Hareketli parça başka bir parçaya bağlı (canlı referans); mate yönünü değiştirin ya da bağlantıyı koparın';
const MSG_KIND = 'Bu yüzeyler bu mate tipi için uygun değil';
const MSG_SAME_BODY = 'Aynı rijit gruptaki parçalar arasında mate kurulamaz';

/** Parçanın / gövdenin dünya dönüşümü (değişken) */
interface Pose {
  p: Vector3;
  q: Quaternion;
}

/**
 * Rijit gövde: grup (id = grup id'si) ya da tek parça (id = parça id'si).
 * Gövde pozu: grupta groupFrameWorld (= partWorld(anchor) ∘ frame), tek parçada partWorld.
 */
interface Body {
  id: string;
  group: Group | null;
  /** Taşınabilir üyeler (next'te parçası ve instance'ı olanlar) */
  members: string[];
  /** Üyelerin gövdeye göre göreli dönüşümü: rel_i = poz⁻¹ ∘ W_i (next'ten; çözüm boyunca sabit). Tek parçada null = birim. */
  rel: Map<string, Pose> | null;
  /** next belgesindeki poz */
  base: Pose;
  /** Bu çözümdeki güncel poz (çözülünce güncellenir) */
  cur: Pose;
}

/** Çözülecek (etkin) mate ve GÖVDE-yerel yüzey geometrileri */
interface ActiveMate {
  mate: Mate;
  ba: Body;
  ga: FaceGeom;
  gb: FaceGeom;
}

// ---------------------------------------------------------------- Tekrar kullanılan geçiciler

const _pa = new Vector3();
const _da = new Vector3();
const _pb = new Vector3();
const _db = new Vector3();
const _target = new Vector3();
const _tmp = new Vector3();
const _rot = new Quaternion();
const _qi = new Quaternion();

/** Parça-yerel FaceGeom'un noktasını ve yönünü verilen pozla dünyaya taşır */
function geomWorld(g: FaceGeom, pose: Pose, outP: Vector3, outD: Vector3): void {
  if (g.kind === 'plane') {
    outP.fromArray(g.point);
    outD.fromArray(g.normal);
  } else if (g.kind === 'cylinder') {
    outP.fromArray(g.point);
    outD.fromArray(g.axis);
  } else {
    outP.set(0, 0, 0);
    outD.set(0, 0, 1);
  }
  outP.applyQuaternion(pose.q).add(pose.p);
  outD.applyQuaternion(pose.q);
}

/** d'ye dik herhangi bir birim vektör */
function anyPerpendicular(d: Vector3, out: Vector3): Vector3 {
  if (Math.abs(d.x) < 0.9) out.set(0, d.z, -d.y);
  else out.set(-d.z, 0, d.x);
  return out.normalize();
}

/** İki birim vektör arası açı (küçük açılarda hassas) */
function angleBetween(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  const dd = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return 2 * Math.asin(Math.min(1, dd / 2));
}

/** b'nin dünya yönünün hedefi (_target'e yazar); _da, _db güncel olmalı */
function directionTarget(m: Mate): void {
  switch (m.type) {
    case 'coincident':
      _target.copy(_da);
      if (!m.flip) _target.negate();
      return;
    case 'concentric':
    case 'parallel':
      _target.copy(_da);
      if (m.flip) _target.negate();
      return;
    case 'perpendicular': {
      _target.copy(_db).addScaledVector(_da, -_db.dot(_da));
      if (_target.lengthSq() < 1e-18) anyPerpendicular(_da, _target);
      else _target.normalize();
      return;
    }
    case 'angle': {
      const deg = m.flip ? 180 - m.angle : m.angle;
      const th = (deg * Math.PI) / 180;
      _tmp.copy(_db).addScaledVector(_da, -_db.dot(_da));
      if (_tmp.lengthSq() < 1e-18) anyPerpendicular(_da, _tmp);
      else _tmp.normalize();
      _target.copy(_da).multiplyScalar(Math.cos(th)).addScaledVector(_tmp, Math.sin(th));
      return;
    }
  }
}

/** Mate'in şu anki artığı: [konum (mm), açı (rad)]. _pa/_da/_pb/_db'yi doldurur. */
function residual(am: ActiveMate, poseA: Pose, poseB: Pose, out: [number, number]): void {
  const m = am.mate;
  geomWorld(am.ga, poseA, _pa, _da);
  geomWorld(am.gb, poseB, _pb, _db);
  let ang: number;
  if (m.type === 'perpendicular') {
    ang = Math.abs(Math.asin(Math.max(-1, Math.min(1, _db.dot(_da)))));
  } else if (m.type === 'angle') {
    const deg = m.flip ? 180 - m.angle : m.angle;
    const cur = Math.acos(Math.max(-1, Math.min(1, _db.dot(_da))));
    ang = Math.abs(cur - (deg * Math.PI) / 180);
  } else {
    directionTarget(m);
    ang = angleBetween(_db, _target);
  }
  let pos = 0;
  if (m.type === 'coincident') {
    pos = Math.abs(_tmp.subVectors(_pb, _pa).dot(_da) - m.offset);
  } else if (m.type === 'concentric') {
    _tmp.subVectors(_pb, _pa);
    _tmp.addScaledVector(_da, -_tmp.dot(_da));
    pos = _tmp.length();
  }
  out[0] = pos;
  out[1] = ang;
}

/** Tek mate için en küçük düzeltmeyi poseB'ye uygular */
function applyMate(am: ActiveMate, poseA: Pose, poseB: Pose): void {
  const m = am.mate;
  geomWorld(am.ga, poseA, _pa, _da);
  geomWorld(am.gb, poseB, _pb, _db);
  // Yön: b'nin yüz noktası etrafında en kısa dönüş
  directionTarget(m);
  if (angleBetween(_db, _target) > 1e-12) {
    _rot.setFromUnitVectors(_db, _target);
    poseB.q.premultiply(_rot).normalize();
    // p' = R (p - c) + c
    poseB.p.sub(_pb).applyQuaternion(_rot).add(_pb);
  }
  // Konum
  if (m.type === 'coincident') {
    const s = _tmp.subVectors(_pb, _pa).dot(_da) - m.offset;
    poseB.p.addScaledVector(_da, -s);
  } else if (m.type === 'concentric') {
    _tmp.subVectors(_pb, _pa);
    _tmp.addScaledVector(_da, -_tmp.dot(_da));
    poseB.p.sub(_tmp);
  }
}

// ---------------------------------------------------------------- Yardımcılar

const mapCache = new WeakMap<object, Map<string, unknown>>();
function byId<T extends { id: string }>(arr: T[]): Map<string, T> {
  let m = mapCache.get(arr) as Map<string, T> | undefined;
  if (!m) {
    m = new Map();
    for (const x of arr) m.set(x.id, x);
    mapCache.set(arr, m as Map<string, unknown>);
  }
  return m;
}

function worldPose(inst: Instance, part: Part): Pose {
  const qi = new Quaternion().fromArray(inst.quaternion);
  const p = new Vector3().fromArray(part.position).applyQuaternion(qi).add(_tmp.fromArray(inst.position));
  const q = qi.multiply(_qi.fromArray(part.quaternion));
  return { p, q };
}

/** a ∘ b */
function composePose(a: Pose, b: Pose): Pose {
  return { p: b.p.clone().applyQuaternion(a.q).add(a.p), q: a.q.clone().multiply(b.q) };
}

/** a⁻¹ ∘ b */
function relPose(a: Pose, b: Pose): Pose {
  const qi = a.q.clone().invert();
  return { p: b.p.clone().sub(a.p).applyQuaternion(qi), q: qi.multiply(b.q) };
}

function poseOfT(t: Transform): Pose {
  return { p: new Vector3().fromArray(t.position), q: new Quaternion().fromArray(t.quaternion) };
}

/** Parça-yerel geometriyi rel ile gövde-yerel koordinata çevirir */
function geomToBody(g: FaceGeom, rel: Pose | null | undefined): FaceGeom {
  if (!rel || g.kind === 'other') return g;
  _tmp.fromArray(g.point).applyQuaternion(rel.q).add(rel.p);
  const point: Vec3 = [_tmp.x, _tmp.y, _tmp.z];
  _tmp.fromArray(g.kind === 'plane' ? g.normal : g.axis).applyQuaternion(rel.q);
  const dir: Vec3 = [_tmp.x, _tmp.y, _tmp.z];
  return g.kind === 'plane' ? { kind: 'plane', point, normal: dir } : { kind: 'cylinder', point, axis: dir, radius: g.radius };
}

function quatDiff(a: Quaternion, b: Quaternion): number {
  const s = a.dot(b) < 0 ? -1 : 1;
  return Math.max(Math.abs(a.x - s * b.x), Math.abs(a.y - s * b.y), Math.abs(a.z - s * b.z), Math.abs(a.w - s * b.w));
}

function poseDiff(a: Pose, b: Pose): number {
  return Math.max(
    Math.abs(a.p.x - b.p.x),
    Math.abs(a.p.y - b.p.y),
    Math.abs(a.p.z - b.p.z),
    quatDiff(a.q, b.q),
  );
}

function arrDiff(a: readonly number[], b: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

function localChanged(a: Part, b: Part): boolean {
  if (a === b) return false;
  if (arrDiff(a.position, b.position) > EPS_CHANGE) return true;
  const s = a.quaternion[0] * b.quaternion[0] + a.quaternion[1] * b.quaternion[1] + a.quaternion[2] * b.quaternion[2] + a.quaternion[3] * b.quaternion[3] < 0 ? -1 : 1;
  for (let i = 0; i < 4; i++) if (Math.abs(a.quaternion[i] - s * b.quaternion[i]) > EPS_CHANGE) return true;
  return false;
}

function geomCompatible(type: Mate['type'], a: FaceGeom, b: FaceGeom): boolean {
  if (type === 'coincident') return a.kind === 'plane' && b.kind === 'plane';
  if (type === 'concentric') return a.kind === 'cylinder' && b.kind === 'cylinder';
  return a.kind !== 'other' && b.kind !== 'other';
}

// ---------------------------------------------------------------- Çözücü

/**
 * Mate'leri çözer. prev = değişiklikten önceki belge, next = değişiklikten sonraki (henüz çözülmemiş) belge.
 * Hareketli birim "gövde"dir: mate'in b parçası bir rijit gruptaysa grubun tüm üyeleri birlikte (aynı dünya
 * deltasıyla) taşınır, değilse yalnızca b parçası. Yalnızca b gövdelerinin üyelerinin Part.position/quaternion'u değişir.
 * Grup çerçevesi anchor'a bağlı olduğundan ayrıca güncellenmez.
 */
export function solveMates(prev: Doc, next: Doc): SolveResult {
  const status: Record<string, MateStatus> = {};
  if (!next.mates.length) return { doc: next, status };

  const parts = byId(next.parts);
  const insts = byId(next.instances);
  const groups = next.groups ?? [];
  /** Canlı dış referanslı gövde parçaları mate'te hareketli taraf olamaz */
  const locked = lockedPartIds(next);

  /** parça id → grubu (bir parça en fazla bir grupta; tutarsızlıkta ilk grup geçerli) */
  let groupOf: Map<string, Group> | null = null;
  if (groups.length) {
    groupOf = new Map();
    for (const g of groups) for (const id of g.partIds) if (!groupOf.has(id)) groupOf.set(id, g);
  }
  const bodyIdOfPart = (partId: string): string => groupOf?.get(partId)?.id ?? partId;

  const nextWorldCache = new Map<string, Pose>();
  const nextWorld = (id: string): Pose | null => {
    let w = nextWorldCache.get(id);
    if (!w) {
      const part = parts.get(id);
      const inst = part && insts.get(part.instanceId);
      if (!part || !inst) return null;
      w = worldPose(inst, part);
      nextWorldCache.set(id, w);
    }
    return w;
  };

  const bodies = new Map<string, Body>();
  /** Parçanın gövdesi (parça ve instance'ı var olmalı) */
  const bodyOf = (partId: string): Body => {
    const bid = bodyIdOfPart(partId);
    let body = bodies.get(bid);
    if (body) return body;
    const g = groupOf?.get(partId) ?? null;
    if (!g) {
      const w = nextWorld(partId)!;
      body = { id: bid, group: null, members: [partId], rel: null, base: w, cur: w };
    } else {
      const members: string[] = [];
      for (const id of g.partIds) if (nextWorld(id) && !members.includes(id)) members.push(id);
      // Grup pozu = partWorld(anchor) ∘ frame; anchor yoksa (cleanupGroups'tan önce) ilk mevcut üye, birim çerçeve
      const aw = nextWorld(g.partIds[0]);
      const pose = aw ? composePose(aw, poseOfT(g.frame)) : nextWorld(members[0])!;
      const rel = new Map<string, Pose>();
      for (const id of members) rel.set(id, relPose(pose, nextWorld(id)!));
      body = { id: bid, group: g, members, rel, base: pose, cur: pose };
    }
    bodies.set(bid, body);
    return body;
  };

  // 1) Etkin mate'ler, gövdeler arası bağımlılık grafiği (a gövdesi → b gövdesi), döngü tespiti
  const byMover = new Map<string, ActiveMate[]>();
  /** a gövdesi → bu gövdeye bağlı hareketli gövdeler */
  const edges = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    if (from === to) return true;
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length) {
      const x = stack.pop()!;
      const out = edges.get(x);
      if (!out) continue;
      for (const y of out) {
        if (y === to) return true;
        if (!seen.has(y)) {
          seen.add(y);
          stack.push(y);
        }
      }
    }
    return false;
  };

  for (const m of next.mates) {
    if (m.suppressed) {
      status[m.id] = { state: 'suppressed' };
      continue;
    }
    const pa = parts.get(m.a.partId);
    const pb = parts.get(m.b.partId);
    if (!pa || !pb || !insts.has(pa.instanceId) || !insts.has(pb.instanceId)) {
      status[m.id] = { state: 'pending' };
      continue;
    }
    const ga = getFaceGeom(pa, m.a.meshIndex, m.a.faceIndex);
    const gb = getFaceGeom(pb, m.b.meshIndex, m.b.faceIndex);
    if (!ga || !gb) {
      status[m.id] = { state: 'pending' };
      continue;
    }
    if (pa.id === pb.id) {
      status[m.id] = { state: 'error', message: MSG_SELF };
      continue;
    }
    const aId = bodyIdOfPart(pa.id);
    const bId = bodyIdOfPart(pb.id);
    if (aId === bId) {
      status[m.id] = { state: 'error', message: MSG_SAME_BODY };
      continue;
    }
    if (!geomCompatible(m.type, ga, gb)) {
      status[m.id] = { state: 'error', message: MSG_KIND };
      continue;
    }
    if (locked.has(pb.id)) {
      status[m.id] = { state: 'error', message: MSG_LOCKED };
      continue;
    }
    const out = edges.get(aId);
    if (!out?.has(bId)) {
      // a → b kenarı, b'den a'ya yol varsa çevrim oluşturur
      if (reaches(bId, aId)) {
        status[m.id] = { state: 'error', message: MSG_CYCLE };
        continue;
      }
      if (out) out.add(bId);
      else edges.set(aId, new Set([bId]));
    }
    const ba = bodyOf(pa.id);
    const bb = bodyOf(pb.id);
    let list = byMover.get(bId);
    if (!list) byMover.set(bId, (list = []));
    // Yüz geometrileri gövde-yerel koordinata: g_gövde = rel ∘ g_parça
    list.push({ mate: m, ba, ga: geomToBody(ga, ba.rel?.get(pa.id)), gb: geomToBody(gb, bb.rel?.get(pb.id)) });
  }

  if (!byMover.size) return { doc: next, status };

  // Topolojik sıra (Kahn; eşitlikte ilk mate sırası)
  const indeg = new Map<string, number>();
  for (const id of byMover.keys()) indeg.set(id, 0);
  for (const [from, outs] of edges) {
    if (!byMover.has(from)) continue;
    for (const to of outs) indeg.set(to, indeg.get(to)! + 1);
  }
  const order: string[] = [];
  const queue: string[] = [];
  for (const id of byMover.keys()) if (indeg.get(id) === 0) queue.push(id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    const outs = edges.get(id);
    if (!outs) continue;
    for (const to of outs) {
      const d = indeg.get(to)! - 1;
      indeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }

  // 2) Pozlar
  const prevParts = byId(prev.parts);
  const prevInsts = byId(prev.instances);
  const prevWorld = (id: string): Pose | null => {
    const part = prevParts.get(id);
    const inst = part && prevInsts.get(part.instanceId);
    return part && inst ? worldPose(inst, part) : null;
  };
  /**
   * Gövdenin prev'deki pozu, NEXT'teki üyelik/çerçeveyle hesaplanır (grup yeni kurulduysa, üyeliği ya da anchor'ı
   * değiştiyse de base ile aynı tanım). Anchor next'te yoksa ilk mevcut üye (bodyOf ile aynı yedek).
   */
  const prevBodyPose = (body: Body): Pose | null => {
    if (!body.group) return prevWorld(body.id);
    const anchorId = body.group.partIds[0];
    if (nextWorld(anchorId)) {
      const aw = prevWorld(anchorId);
      return aw ? composePose(aw, poseOfT(body.group.frame)) : null;
    }
    return body.members.length ? prevWorld(body.members[0]) : null;
  };
  /** Gövdenin herhangi bir üyesi prev→next arasında doğrudan değişti mi (prev'de olmayan üye = değişti) */
  const directlyChanged = (body: Body): boolean => {
    for (const id of body.members) {
      const prevPart = prevParts.get(id);
      if (!prevPart || localChanged(prevPart, parts.get(id)!)) return true;
    }
    return false;
  };

  const res: [number, number] = [0, 0];
  const changedBodies: Body[] = [];

  for (const bid of order) {
    const mates = byMover.get(bid)!;
    const body = bodies.get(bid)!;
    const base = body.base;
    const pose: Pose = { p: base.p.clone(), q: base.q.clone() };

    if (!directlyChanged(body)) {
      // Referans gövde bu çözümde hareket ettiyse rijit takip: P = ΔR · P_prev
      const ref = mates[0].ba;
      const rNew = ref.cur;
      const rOld = prevBodyPose(ref);
      const pOld = rOld && prevBodyPose(body);
      if (rOld && pOld && poseDiff(rNew, rOld) > EPS_CHANGE) {
        // ΔR = R_new · R_old⁻¹
        const dq = rNew.q.clone().multiply(_qi.copy(rOld.q).invert());
        pose.q.copy(dq).multiply(pOld.q).normalize();
        pose.p.copy(pOld.p).sub(rOld.p).applyQuaternion(dq).add(rNew.p);
      }
    }

    // 3) Gauss–Seidel turları (a gövdeleri topolojik sırada önce çözüldü; cur güncel)
    for (let round = 0; round < MAX_ROUNDS; round++) {
      for (const am of mates) applyMate(am, am.ba.cur, pose);
      let maxPos = 0;
      let maxAng = 0;
      for (const am of mates) {
        residual(am, am.ba.cur, pose, res);
        if (res[0] > maxPos) maxPos = res[0];
        if (res[1] > maxAng) maxAng = res[1];
      }
      if (maxPos < CONV_POS && maxAng < CONV_ANG) break;
    }

    // 4) Durumlar
    for (const am of mates) {
      residual(am, am.ba.cur, pose, res);
      status[am.mate.id] = res[0] <= OK_POS && res[1] <= OK_ANG ? { state: 'ok' } : { state: 'error', message: MSG_CONFLICT };
    }

    body.cur = pose;
    if (poseDiff(pose, base) > EPS_CHANGE) changedBodies.push(body);
  }

  // 5) Belgeyi güncelle: üyelerin yeni dünyası = yeniPoz ∘ rel_i → instance-yerel
  if (!changedBodies.length) return { doc: next, status };
  const newWorld = new Map<string, Pose>();
  for (const body of changedBodies) {
    if (!body.rel) newWorld.set(body.id, body.cur);
    else for (const [id, rel] of body.rel) newWorld.set(id, composePose(body.cur, rel));
  }
  const newParts = next.parts.map((p) => {
    const pose = newWorld.get(p.id);
    if (!pose) return p;
    const world: Transform = { position: [pose.p.x, pose.p.y, pose.p.z], quaternion: [pose.q.x, pose.q.y, pose.q.z, pose.q.w] };
    const local = partLocalFromWorld(insts.get(p.instanceId)!, world);
    return { ...p, position: local.position, quaternion: local.quaternion };
  });
  return { doc: { ...next, parts: newParts }, status };
}

/** Düzlemde normal, silindirde eksen */
function directionOf(g: FaceGeom): Vec3 | null {
  return g.kind === 'plane' ? g.normal : g.kind === 'cylinder' ? g.axis : null;
}

/**
 * Yeni mate için başlangıç flip/angle değerleri: parçalar en az dönecek şekilde seçilir.
 * (coincident için flip daima false, offset 0 kalır.)
 */
export function initialMateParams(mate: Omit<Mate, 'flip' | 'angle'>, doc: Doc): { flip: boolean; angle: number } {
  const ga = worldFaceGeom(mate.a, doc);
  const gb = worldFaceGeom(mate.b, doc);
  const da = ga && directionOf(ga);
  const db = gb && directionOf(gb);
  if (!da || !db) return { flip: false, angle: 90 };
  const dot = Math.max(-1, Math.min(1, da[0] * db[0] + da[1] * db[1] + da[2] * db[2]));
  switch (mate.type) {
    case 'concentric':
    case 'parallel':
      return { flip: dot < 0, angle: 90 };
    case 'angle':
      return { flip: false, angle: Math.round((Math.acos(dot) * 180) / Math.PI) };
    default:
      return { flip: false, angle: 90 };
  }
}
