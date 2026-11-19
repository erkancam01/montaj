import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TransformControls } from '@react-three/drei';
import { MathUtils, Object3D } from 'three';
import { useShallow } from 'zustand/react/shallow';
import { composeT, invertT } from '../../lib/math';
import { objectRegistry } from '../../lib/registry';
import { applyWorldDelta, rigidSetOf, selectedPartIds } from '../../lib/rigid';
import { useAssembly, type AssemblyState } from '../../store/useAssembly';
import type { Doc, Transform } from '../../types';
import { markGizmoDown, markGizmoUp, sceneRefs } from './sceneRefs';
import { lockedPartIds } from '../../modeling/refLocks';

/** Parça ve instance'ı görünür mü */
function partShown(doc: Doc, partId: string): boolean {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part?.visible) return false;
  return !!doc.instances.find((i) => i.id === part.instanceId)?.visible;
}

/** Seçili öğe görünür mü. Grup / çoklu seçimde: kümedeki en az bir parça görünür mü */
function selectionVisible(s: AssemblyState): boolean {
  const sel = s.selection;
  if (!sel) return false;
  if (sel.kind === 'group' || s.extraSel.length) {
    return selectedPartIds(s.doc, sel, s.extraSel).some((id) => partShown(s.doc, id));
  }
  if (sel.kind === 'instance') return !!s.doc.instances.find((i) => i.id === sel.id)?.visible;
  return partShown(s.doc, sel.id);
}

function transformOf(o: Object3D): Transform {
  const p = o.position;
  const q = o.quaternion;
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
}

function placeAt(o: Object3D, t: Transform) {
  o.position.set(...t.position);
  o.quaternion.set(...t.quaternion);
  o.updateMatrixWorld(true);
}

/** Rijit küme sürüklemesi: başlangıçtaki proxy dönüşümü ve taşınan parçalar (sürükleme boyunca sabit) */
interface RigidDrag {
  start: Transform;
  partIds: string[];
}

export function Gizmo() {
  const selection = useAssembly((s) => s.selection);
  const extraSel = useAssembly((s) => s.extraSel);
  const fileStatus = useAssembly((s) => s.fileStatus);
  const doc = useAssembly((s) => s.doc);
  const visible = useAssembly(selectionVisible);
  // Mate aracında ve mate seçiliyken gizmo gösterilmez
  // Canlı referanslı (kilitli) gövde parçası seçiliyse de gösterilmez: konumunu referansından alır
  const hidden = useAssembly(
    (s) =>
      s.ui.tool === 'mate' ||
      s.mateSelection !== null ||
      (!!s.selection && !!s.doc.bodies.length && selectedPartIds(s.doc, s.selection, s.extraSel).some((id) => lockedPartIds(s.doc).has(id))),
  );
  const ui = useAssembly(
    useShallow((s) => ({
      mode: s.ui.mode,
      space: s.ui.space,
      snap: s.ui.snap,
      snapMove: s.ui.snapMove,
      snapAngle: s.ui.snapAngle,
    })),
  );

  // Grup ya da çoklu seçim: gizmo, sahne kökündeki bir proxy nesneye bağlanır (pivot dünya dönüşümünde)
  const rigid = useMemo(() => rigidSetOf(doc, selection, extraSel), [doc, selection, extraSel]);
  const [proxy] = useState(() => {
    const o = new Object3D();
    o.name = 'Rijit küme pivotu';
    o.userData.noExport = true;
    return o;
  });
  const drag = useRef<RigidDrag | null>(null);

  // Sürükleme yokken proxy pivotu izler (seçim, geri alma, çözücü düzeltmeleri)
  useLayoutEffect(() => {
    if (rigid && !drag.current) placeAt(proxy, rigid.pivot);
  }, [rigid, proxy]);

  const [target, setTarget] = useState<Object3D | null>(null);
  useEffect(() => {
    setTarget(selection ? (objectRegistry.get(selection.id) ?? null) : null);
  }, [selection, fileStatus, doc]);

  const gizmoRef = useCallback((o: Object3D | null) => {
    if (!o) return;
    sceneRefs.gizmo = o;
    return () => {
      if (sceneRefs.gizmo === o) sceneRefs.gizmo = null;
    };
  }, []);

  const onMouseDown = useCallback(() => {
    markGizmoDown();
    const st = useAssembly.getState();
    const r = rigidSetOf(st.doc, st.selection, st.extraSel);
    drag.current = r ? { start: transformOf(proxy), partIds: r.partIds } : null;
    st.beginDrag();
  }, [proxy]);

  const onObjectChange = useCallback(() => {
    const st = useAssembly.getState();
    const d = drag.current;
    if (d) {
      const delta = composeT(transformOf(proxy), invertT(d.start));
      st.updateLive((base) => applyWorldDelta(base, d.partIds, delta));
      return;
    }
    const sel = st.selection;
    if (!sel || sel.kind === 'group' || !target) return;
    const p = target.position;
    const q = target.quaternion;
    st.setTransformLive(sel.kind, sel.id, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
  }, [target, proxy]);

  const onMouseUp = useCallback(() => {
    markGizmoUp();
    const wasRigid = drag.current !== null;
    drag.current = null;
    const st = useAssembly.getState();
    st.endDrag();
    if (wasRigid) {
      // Çözücü kümeyi kısıta çektiyse proxy de oraya gider
      const r = rigidSetOf(st.doc, st.selection, st.extraSel);
      if (r) placeAt(proxy, r.pivot);
    }
  }, [proxy]);

  // Sürükleme ortasında bileşen kaybolursa geçmiş kaydını kapat
  useEffect(
    () => () => {
      markGizmoUp();
      drag.current = null;
      useAssembly.getState().endDrag();
    },
    [],
  );

  const object = rigid ? proxy : target;

  return (
    <>
      <primitive object={proxy} />
      {object && visible && !hidden && (
        <TransformControls
          ref={gizmoRef}
          object={object}
          mode={ui.mode}
          space={ui.space}
          size={0.9}
          translationSnap={ui.snap ? ui.snapMove : null}
          rotationSnap={ui.snap ? MathUtils.degToRad(ui.snapAngle) : null}
          onMouseDown={onMouseDown}
          onObjectChange={onObjectChange}
          onMouseUp={onMouseUp}
        />
      )}
    </>
  );
}
