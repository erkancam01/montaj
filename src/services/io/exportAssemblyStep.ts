// Tüm montajı (çizilen gövdeler + içe aktarılan parçalar) tek STEP dosyası olarak dışa aktarır.
import { exportAssemblySTEP, type ExportItem } from '@/services/kernel/kernelApi';
import { geometryCache } from '@/core/geometry/geometryCache';
import { composeT, partWorld } from '@/core/math/math';
import { loadBlob } from '@/services/io/persistence';
import { useAssembly } from '@/state/useAssembly';
import { bodyIdOfFile, isBodyFileId } from '@/core/types';

/** Görünür parçalardan STEP üretir. Uyarılar (eşleşmeyen parçalar vb.) ile döner. */
export async function exportAssemblyAsStep(): Promise<{ blob: Blob; warnings: string[] }> {
  const { doc } = useAssembly.getState();
  const items: ExportItem[] = [];
  const blobs: Record<string, Blob> = {};
  const warnings: string[] = [];
  for (const inst of doc.instances) {
    if (!inst.visible) continue;
    for (const part of doc.parts) {
      if (part.instanceId !== inst.id || !part.visible) continue;
      const world = partWorld(inst, part);
      if (isBodyFileId(part.fileId)) {
        const body = doc.bodies.find((b) => b.id === bodyIdOfFile(part.fileId));
        if (body) items.push({ kind: 'body', name: part.name, color: part.color, body, world });
        continue;
      }
      const node = geometryCache.get(part.fileId)?.nodes[part.nodeKey];
      const file = doc.files.find((f) => f.id === part.fileId);
      if (!node || !file) {
        warnings.push(`${part.name}: geometri yüklenmemiş, atlandı`);
        continue;
      }
      if (!blobs[file.id]) {
        const b = await loadBlob(file.id);
        if (!b) {
          warnings.push(`${file.name}: kaynak dosya bulunamadı`);
          continue;
        }
        blobs[file.id] = b;
      }
      const c = node.center;
      items.push({
        kind: 'import',
        name: part.name,
        color: part.color,
        fileId: file.id,
        fileName: file.name,
        nodeCenter: [...c],
        nodeSize: [...node.size],
        world: composeT(world, { position: [-c[0], -c[1], -c[2]], quaternion: [0, 0, 0, 1] }),
      });
    }
  }
  if (!items.length) throw new Error('Dışa aktarılacak görünür parça yok');
  const r = await exportAssemblySTEP(items, blobs);
  return { blob: r.blob, warnings: [...warnings, ...r.warnings] };
}
