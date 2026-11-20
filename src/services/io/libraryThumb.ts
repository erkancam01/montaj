// Kütüphane öğeleri için küçük resim: ayrıştırılmış CAD geometrisini ekran dışı bir WebGL tuvalinde
// izometrik açıdan çizer ve data URL döndürür. Tek bir paylaşılan çizici kullanılır.
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { ParsedFile } from '@/core/geometry/geometryCache';

const SIZE = 192;
const DEFAULT_COLOR = new Color().setRGB(0.72, 0.75, 0.79, SRGBColorSpace);

let renderer: WebGLRenderer | null = null;

function getRenderer(): WebGLRenderer | null {
  if (renderer) return renderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.toneMapping = NeutralToneMapping;
    renderer.setClearColor(0x000000, 0);
    return renderer;
  } catch (e) {
    console.warn('Küçük resim çizicisi oluşturulamadı:', e);
    return null;
  }
}

/** Geometriyi çizip data URL (webp, olmazsa png) döndürür; çizilemezse null */
export function renderThumbnail(parsed: ParsedFile): string | null {
  const r = getRenderer();
  if (!r) return null;

  const scene = new Scene();
  const materials: MeshStandardMaterial[] = [];
  const box = new Box3();
  for (const n of parsed.nodes) {
    for (const m of n.meshes) {
      const mat = new MeshStandardMaterial({
        color: m.hasVertexColors ? 0xffffff : m.color ? new Color().setRGB(m.color[0], m.color[1], m.color[2], SRGBColorSpace) : DEFAULT_COLOR,
        vertexColors: m.hasVertexColors,
        metalness: 0.1,
        roughness: 0.6,
      });
      materials.push(mat);
      const mesh = new Mesh(m.geometry, mat);
      mesh.position.set(n.center[0], n.center[1], n.center[2]);
      mesh.updateMatrixWorld(true);
      scene.add(mesh);
      box.expandByObject(mesh, true);
    }
  }
  if (box.isEmpty()) return null;

  const sphere = box.getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, 1e-3);
  const camera = new PerspectiveCamera(30, 1, radius * 0.01, radius * 100);
  camera.up.set(0, 0, 1);
  // Sahnedeki varsayılan bakış yönüyle aynı (önden-sağdan-üstten, Z yukarı)
  const dir = new Vector3(0.55, -0.7, 0.55).normalize();
  const dist = radius / Math.sin(((camera.fov / 2) * Math.PI) / 180) * 1.05;
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.lookAt(sphere.center);

  scene.add(new AmbientLight(0xffffff, 1.1));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.copy(camera.position).add(new Vector3(radius, -radius * 0.5, radius * 2));
  key.target.position.copy(sphere.center);
  scene.add(key, key.target);
  const fill = new DirectionalLight(0xffffff, 0.6);
  fill.position.copy(sphere.center).add(new Vector3(-radius * 2, radius, -radius));
  scene.add(fill);

  try {
    r.render(scene, camera);
    const url = r.domElement.toDataURL('image/webp', 0.85);
    return url.startsWith('data:image/webp') ? url : r.domElement.toDataURL('image/png');
  } catch (e) {
    console.warn('Küçük resim çizilemedi:', e);
    return null;
  } finally {
    for (const m of materials) m.dispose();
    r.renderLists.dispose();
  }
}
