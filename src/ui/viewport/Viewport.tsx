import { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { ViewCube } from '@/ui/viewport/ViewCube';
import { NeutralToneMapping } from 'three';
import { useAssembly } from '@/state/useAssembly';
import { CameraRig } from '@/ui/viewport/CameraRig';
import { FaceHighlights, MateCursor } from '@/ui/viewport/FaceHighlights';
import { Gizmo } from '@/ui/viewport/Gizmo';
import { DragController } from '@/ui/viewport/DragController';
import { Lights } from '@/ui/viewport/Lights';
import { SceneContent } from '@/ui/viewport/SceneContent';
import { SceneGrid } from '@/ui/viewport/SceneGrid';
import { gizmoBusy, inViewCube } from '@/ui/viewport/sceneRefs';
import { SketchLayer } from '@/ui/sketch/SketchLayer';
import { PickLayer } from '@/ui/modeling/PickLayer';
import { useViewShortcuts } from '@/ui/hooks/useViewShortcuts';
import { ViewMenu } from '@/ui/viewport/ViewMenu';
import { TouchControls } from '@/ui/viewport/TouchControls';

const BACKGROUND = '#1e2228';

// Sabit nesneler: Canvas her render'da yeniden yapılandırılmasın
const CAMERA = { fov: 45, position: [300, -400, 300] as [number, number, number], up: [0, 0, 1] as [number, number, number], near: 0.5, far: 1e6 };
const GL = { preserveDrawingBuffer: true, antialias: true, toneMapping: NeutralToneMapping };
const DPR: [number, number] = [1, 2];
const STYLE = { background: BACKGROUND };

function onPointerMissed(e: MouseEvent) {
  if (e.button !== 0 || gizmoBusy() || inViewCube(e.clientX, e.clientY)) return;
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
/** Dar ekran (telefon): eksen göstergesi küçülür */
function useNarrow(): boolean {
  const q = '(max-width: 899px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function Viewport() {
  useViewShortcuts();
  const narrow = useNarrow();
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
        <DragController />
        <SketchLayer />
        <PickLayer />
        <CameraRig />
        <ViewCube narrow={narrow} />
      </Canvas>
      <ViewMenu />
      <TouchControls />
    </>
  );
}
