// Canvas içinde çalışır ama yalnız DOM olaylarını dinler (parça işaretçi mantığına dokunmaz):
// - sürükleme olmayan (≤ 4 px) sol tıkta yüzeyin yanında bağlam kutusu,
// - sağ tuş basılıyken imleç 4 px'ten az oynadıysa `contextmenu` ile bağlama göre sağ tık menüsü,
// - S menüsü için son imleç konumu.
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { Raycaster, Vector2, type Intersection, type Mesh, type Object3D } from 'three';
import { faceAtTriangle } from '../../lib/faceGeometry';
import { geometryCache } from '../../lib/geometryCache';
import { useAssembly } from '../../store/useAssembly';
import type { FaceRef } from '../../types';
import { gizmoBusy, sceneRefs } from '../viewport/sceneRefs';
import { multiTouchRecent } from '../viewport/touchState';
import { longPressRecent, TAP_PX } from '../../hooks/useLongPress';
import { isPlanarFace } from './commands';
import { pointerState, useCommandUi, type SceneHit } from './commandStore';

const CLICK_TOL = 4;
const raycaster = new Raycaster();
const ndc = new Vector2();

function isMesh(o: Object3D): o is Mesh {
  return (o as Mesh).isMesh === true;
}

export function ScenePointer() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const el = gl.domElement;
    const down: Record<number, { x: number; y: number; moved: number }> = {};

    const hitAt = (clientX: number, clientY: number): SceneHit | null => {
      const root = sceneRefs.root;
      if (!root) return null;
      const r = el.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      let hits: Intersection[];
      try {
        hits = raycaster.intersectObject(root, true);
      } catch {
        return null;
      }
      const doc = useAssembly.getState().doc;
      for (const h of hits) {
        if (!isMesh(h.object) || !h.object.visible) continue;
        const id = h.object.userData as { partId?: unknown; meshIndex?: unknown };
        if (typeof id.partId !== 'string' || typeof id.meshIndex !== 'number') continue;
        const part = doc.parts.find((p) => p.id === id.partId);
        if (!part) continue;
        const mesh = geometryCache.get(part.fileId)?.nodes[part.nodeKey]?.meshes[id.meshIndex];
        let face: FaceRef | null = null;
        if (mesh && h.faceIndex != null && h.faceIndex >= 0) {
          const fi = faceAtTriangle(mesh, h.faceIndex);
          if (fi >= 0) face = { partId: part.id, meshIndex: id.meshIndex, faceIndex: fi };
        }
        return { partId: part.id, face, planar: face ? isPlanarFace(face) : false };
      }
      return null;
    };

    const onDown = (e: PointerEvent) => {
      down[e.button] = { x: e.clientX, y: e.clientY, moved: 0 };
      const ui = useCommandUi.getState();
      if (ui.contextBox || ui.contextMenu || ui.sMenu) ui.closePopups();
    };
    const onMove = (e: PointerEvent) => {
      pointerState.x = e.clientX;
      pointerState.y = e.clientY;
      pointerState.inside = true;
      for (const k in down) {
        const d = down[k];
        d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.x, e.clientY - d.y));
      }
    };
    const onLeave = () => {
      pointerState.inside = false;
    };
    const onUp = (e: PointerEvent) => {
      const d = down[e.button];
      delete down[e.button];
      if (e.button !== 0 || !d) return;
      const touch = e.pointerType === 'touch';
      // Dokunmatik: uzun basma (sağ tık menüsü açıldı) ya da iki parmaklı hareket tıklama sayılmaz
      if (touch && (longPressRecent() || multiTouchRecent())) return;
      const tol = touch ? TAP_PX : CLICK_TOL;
      if (d.moved > tol || Math.hypot(e.clientX - d.x, e.clientY - d.y) > tol) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const st = useAssembly.getState();
      if (st.modeling.sketch || st.modeling.feature || st.modeling.pick || st.ui.tool !== 'select') return;
      const x = e.clientX;
      const y = e.clientY;
      // Parçanın kendi tıklama işleyicisi (seçim) önce çalışsın
      window.setTimeout(() => {
        if (gizmoBusy()) return;
        const hit = hitAt(x, y);
        useCommandUi.getState().set({ contextBox: hit?.face ? { x, y, hit } : null });
      }, 0);
    };
    const onContext = (e: MouseEvent) => {
      const d = down[2];
      const moved = d ? Math.max(d.moved, Math.hypot(e.clientX - d.x, e.clientY - d.y)) : 0;
      e.preventDefault();
      // Sağ tuşla sürükleme (kamera / döndürme) menü açmaz
      if (moved >= CLICK_TOL) return;
      const st = useAssembly.getState();
      // Sketch oturumunda sağ tık sketch katmanına aittir
      if (st.modeling.sketch || st.modeling.pick) return;
      const hit = hitAt(e.clientX, e.clientY);
      if (hit) {
        const sel = st.selection;
        const covered = sel?.kind === 'part' && sel.id === hit.partId;
        if (!covered && !st.modeling.feature && st.ui.tool === 'select') st.select({ kind: 'part', id: hit.partId });
      }
      useCommandUi.getState().set({ contextBox: null, sMenu: null, contextMenu: { x: e.clientX, y: e.clientY, hit } });
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('contextmenu', onContext);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('contextmenu', onContext);
    };
  }, [gl, camera]);

  return null;
}
