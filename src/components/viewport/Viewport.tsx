import { Canvas } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport } from '@react-three/drei';
import { NeutralToneMapping } from 'three';
import { useAssembly } from '../../store/useAssembly';
import { CameraRig } from './CameraRig';
import { FaceHighlights, MateCursor } from './FaceHighlights';
import { Gizmo } from './Gizmo';
import { Lights } from './Lights';
import { SceneContent } from './SceneContent';
import { SceneGrid } from './SceneGrid';
import { gizmoBusy } from './sceneRefs';
import { SketchLayer } from '../sketch/SketchLayer';
import { PickLayer } from '../modeling/PickLayer';
import { useViewShortcuts } from '../../hooks/useViewShortcuts';
import { ViewMenu } from './ViewMenu';

const BACKGROUND = '#1e2228';

// Sabit nesneler: Canvas her render'da yeniden yapılandırılmasın
const CAMERA = { fov: 45, position: [300, -400, 300] as [number, number, number], up: [0, 0, 1] as [number, number, number], near: 0.5, far: 1e6 };
const GL = { preserveDrawingBuffer: true, antialias: true, toneMapping: NeutralToneMapping };
const DPR: [number, number] = [1, 2];
const STYLE = { background: BACKGROUND };

function onPointerMissed(e: MouseEvent) {
  if (e.button !== 0 || gizmoBusy()) return;
  // Ctrl/Cmd/Shift ile çoklu seçim yaparken boşluğa tıklamak seçimi bozmasın
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;
  const st = useAssembly.getState();
  // Mate aracında boşluğa tıklamak seçimi ve bekleyen referans yüzeyi korur
  if (st.ui.tool === 'mate') return;
  st.select(null);
}

/**
 * 3D montaj sahnesi (Z-yukarı, mm). Kamera: SolidWorks şeması (CameraRig → CadControls);
 * görünüm kısayolları ve Space menüsü burada bağlanır.
 */
export function Viewport() {
  useViewShortcuts();
  return (
    <>
      <Canvas camera={CAMERA} gl={GL} dpr={DPR} style={STYLE} onPointerMissed={onPointerMissed}>
        <color attach="background" args={[BACKGROUND]} />
        <Lights />
        <SceneGrid />
        <SceneContent />
        <FaceHighlights />
        <MateCursor />
        <Gizmo />
        <SketchLayer />
        <PickLayer />
        <CameraRig />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={['#e5484d', '#30a46c', '#3e7bfa']} labelColor="#ffffff" />
        </GizmoHelper>
      </Canvas>
      <ViewMenu />
    </>
  );
}
