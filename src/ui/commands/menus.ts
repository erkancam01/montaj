// Bağlama göre menü girdileri: sahne sağ tık (yüzey / parça / boş alan), ağaç sağ tık, bağlam kutusu ve S menüsü.
import { isPartFixed, setPartFixed } from '@/state/partStatus';
import { viewerApi } from '@/services/viewerApi';
import { normalTo } from '@/ui/viewport/viewCommands';
import { cancelFeature, enterBody, exitBody, finishSketch, bodyIdOfPart } from '@/state/modelingActions';
import { duplicate, remove, setVisible, groupSelection } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import { confirmCancel, SKETCH_TOOLS } from '@/ui/sketch/SketchToolbar';
import { chooseTool, constructionKey } from '@/ui/sketch/tools';
import { tryApplyFeature } from '@/ui/modeling/FeatureInspector';
import { FEATURE_TOOLS, openFilePicker, runFeatureTool } from '@/ui/shell/Toolbar';
import { acceptMateSession, mateFromFace, newPartOnPlane, runCommand, sketchOnFace, sketchOnPlane, targetBodyId, toggleMateTool } from '@/ui/commands/commands';
import type { MenuEntry, MenuItem } from '@/ui/commands/PopupMenu';
import { useCommandUi, type SceneHit } from '@/ui/commands/commandStore';
import { createElement } from 'react';
import { FIcon } from '@/ui/icons/featureIcons';
import { ToolIcon } from '@/ui/icons/sketchIcons';
import { IconMate } from '@/ui/icons/icons';

const st = () => useAssembly.getState();

/** Parçayı seçer (sahne kuralı değil, parçanın kendisi) */
function selectPart(partId: string) {
  st().select({ kind: 'part', id: partId });
}

const sketchIcon = () => createElement(FIcon, { name: 'sketch' });
const mateIcon = () => createElement(IconMate, { size: 16 });

/** Bağlam kutusu: yüzeye tıklanınca imleç yanındaki küçük simge şeridi */
export function contextBoxItems(hit: SceneHit): MenuItem[] {
  const items: MenuItem[] = [];
  const face = hit.face;
  const s = st();
  const busy = !!s.modeling.sketch || !!s.modeling.feature;
  if (face) {
    items.push({
      label: 'Sketch',
      icon: sketchIcon(),
      disabled: !hit.planar || busy,
      title: hit.planar ? 'Bu yüzeyde yeni sketch' : 'Yüzey düz değil: sketch açılamaz',
      onClick: () => runCommand('sketch-face', 'Yüzeyde sketch', () => sketchOnFace(face)),
    });
    items.push({
      label: 'Mate',
      icon: mateIcon(),
      disabled: busy,
      title: 'Bu yüzeyi referans alarak mate kur (sonra ikinci yüzeye tıklayın)',
      onClick: () => runCommand('mate', 'Mate', () => mateFromFace(face)),
    });
    if (hit.planar) {
      items.push({
        label: "Normal'e bak",
        icon: 'plane',
        title: "Bu yüzeye dik bak (Ctrl+8)",
        onClick: () => normalTo(face),
      });
    }
  }
  const bodyId = bodyIdOfPart(hit.partId);
  if (bodyId && s.modeling.activeBodyId !== bodyId) {
    items.push({
      label: 'Parçayı düzenle',
      icon: 'editPart',
      disabled: busy,
      title: 'Özellik geçmişini düzenle',
      onClick: () => enterBody(bodyId),
    });
  }
  items.push({ label: 'Gizle', icon: 'hide', title: 'Parçayı gizle (H)', onClick: () => setVisible('part', hit.partId, false) });
  return items;
}

/** Sahnede bir parçaya / yüzeyine sağ tık */
export function partMenu(hit: SceneHit): MenuEntry[] {
  const s = st();
  const { partId, face } = hit;
  const part = s.doc.parts.find((p) => p.id === partId);
  if (!part) return [];
  const busy = !!s.modeling.sketch || !!s.modeling.feature;
  const bodyId = bodyIdOfPart(partId);
  const fixed = isPartFixed(partId);
  const entries: MenuEntry[] = [{ heading: part.name }];
  if (face) {
    entries.push(
      {
        label: 'Bu yüzeyde sketch',
        icon: sketchIcon(),
        disabled: !hit.planar || busy,
        title: hit.planar ? undefined : 'Yüzey düz değil',
        onClick: () => runCommand('sketch-face', 'Yüzeyde sketch', () => sketchOnFace(face)),
      },
      {
        label: 'Mate (bu yüzey referans)',
        icon: mateIcon(),
        disabled: busy,
        hint: 'M',
        onClick: () => runCommand('mate', 'Mate', () => mateFromFace(face)),
      },
    );
    if (hit.planar) {
      entries.push({ label: "Normal'e bak", icon: 'plane', hint: 'Ctrl+8', onClick: () => normalTo(face) });
    }
  }
  if (bodyId) {
    entries.push(
      s.modeling.activeBodyId === bodyId
        ? { label: 'Düzenlemeyi bitir', icon: 'done', disabled: !!s.modeling.sketch, onClick: () => exitBody() }
        : { label: 'Parçayı düzenle', icon: 'editPart', disabled: busy, onClick: () => enterBody(bodyId) },
    );
  }
  entries.push('sep', ...commonPartEntries(partId, part.visible, fixed));
  return entries;
}

/** Ağaçta ve sahnede ortak parça girdileri */
export function commonPartEntries(partId: string, visible: boolean, fixed: boolean): MenuEntry[] {
  return [
    {
      label: visible ? 'Gizle' : 'Göster',
      icon: visible ? 'hide' : 'show',
      hint: 'H',
      onClick: () => setVisible('part', partId, !visible),
    },
    {
      label: fixed ? 'Serbest bırak' : 'Sabitle',
      icon: fixed ? 'unpin' : 'pin',
      title: fixed ? 'Parça sürüklenebilir / mate ile hareket edebilir' : 'Parçayı yerinde sabitle',
      onClick: () => setPartFixed(partId, !fixed),
    },
    {
      label: 'Odakla',
      icon: 'focus',
      onClick: () => {
        selectPart(partId);
        viewerApi.fit('selection');
      },
    },
    { label: 'Çoğalt', icon: 'copy', hint: 'Ctrl+D', onClick: () => duplicate({ kind: 'part', id: partId }) },
    'sep',
    { label: 'Sil', icon: 'trash', danger: true, hint: 'Del', onClick: () => remove({ kind: 'part', id: partId }) },
  ];
}

/** Sahnede boş alana sağ tık */
export function emptyMenu(): MenuEntry[] {
  const s = st();
  if (s.modeling.feature) {
    return [
      { heading: 'Açık özellik' },
      { label: 'Uygula', icon: 'done', primary: true, hint: 'Enter', onClick: () => void tryApplyFeature() },
      { label: 'İptal', icon: 'close', hint: 'Esc', onClick: () => cancelFeature() },
    ];
  }
  const hidden = s.doc.parts.some((p) => !p.visible) || s.doc.instances.some((i) => !i.visible);
  const last = lastEntry();
  return [
    ...(last ? [last, 'sep' as const] : []),
    { heading: 'Yeni parça' },
    { label: 'Üst düzlemde (XY)', icon: 'newPart', onClick: () => runCommand('newpart-XY', 'Yeni parça (XY)', () => newPartOnPlane('XY')) },
    { label: 'Ön düzlemde (XZ)', icon: 'newPart', onClick: () => runCommand('newpart-XZ', 'Yeni parça (XZ)', () => newPartOnPlane('XZ')) },
    { label: 'Sağ düzlemde (YZ)', icon: 'newPart', onClick: () => runCommand('newpart-YZ', 'Yeni parça (YZ)', () => newPartOnPlane('YZ')) },
    'sep',
    { label: 'Dosya ekle…', icon: 'addFile', onClick: openFilePicker },
    { label: 'Mate', icon: mateIcon(), hint: 'M', onClick: () => runCommand('mate', 'Mate', toggleMateTool) },
    ...(s.modeling.activeBodyId ? [{ label: 'Düzenlemeyi bitir', icon: 'done', onClick: () => exitBody() } as MenuItem] : []),
    'sep',
    {
      label: 'Tümünü göster',
      icon: 'show',
      disabled: !hidden,
      onClick: () =>
        st().commit((d) => ({
          ...d,
          parts: d.parts.map((p) => (p.visible ? p : { ...p, visible: true })),
          instances: d.instances.map((i) => (i.visible ? i : { ...i, visible: true })),
        })),
    },
    { label: 'Sığdır', icon: 'fit', onClick: () => viewerApi.fit('all') },
    { label: 'Geri al', icon: 'rotate', hint: 'Ctrl+Z', disabled: !s.past.length, onClick: () => st().undo() },
  ];
}

function lastEntry(): MenuItem | null {
  const last = useCommandUi.getState().last;
  if (!last) return null;
  return { label: `Tekrarla: ${last.label}`, icon: 'rotate', hint: 'Enter', primary: true, onClick: () => last.run() };
}

/** S kısayol menüsü: bağlama göre sık komutlar (simge ızgarası) */
export function sMenuEntries(): MenuEntry[] {
  const s = st();
  if (s.modeling.sketch) {
    const pick = ['select', 'line', 'rect', 'rectCenter', 'circle', 'arc', 'point', 'dimension', 'project'];
    return [
      ...SKETCH_TOOLS.filter((t) => pick.includes(t.tool)).map(
        (t): MenuItem => ({
          label: t.label,
          icon: createElement(ToolIcon, { tool: t.tool, size: 18 }),
          hint: t.key,
          onClick: () => runCommand(`sk-${t.tool}`, t.label, () => chooseTool(t.tool)),
        }),
      ),
      { label: 'Yardımcı', icon: 'rename', hint: 'X', onClick: constructionKey },
      { label: "Sketch'ten çık", icon: 'exitSketch', primary: true, hint: 'Enter', onClick: () => finishSketch() },
      { label: 'İptal', icon: 'close', onClick: confirmCancel },
    ];
  }
  if (s.modeling.feature) {
    return [
      { label: 'Uygula', icon: 'done', primary: true, onClick: () => void tryApplyFeature() },
      { label: 'İptal', icon: 'close', onClick: () => cancelFeature() },
    ];
  }
  if (s.modeling.activeBodyId || targetBodyId(s)) {
    const feat = FEATURE_TOOLS.filter((t) => ['extrude', 'cut', 'revolve', 'fillet', 'chamfer', 'hole'].includes(t.tool)).map(
      (t): MenuItem => ({
        label: t.label,
        icon: createElement(FIcon, { name: t.icon, size: 18 }),
        onClick: () => runFeatureTool(t.tool),
      }),
    );
    return [
      { label: 'Sketch (XY)', icon: sketchIcon(), onClick: () => runCommand('sketch-XY', 'Sketch (XY)', () => sketchOnPlane('XY')) },
      ...feat,
      ...(s.modeling.activeBodyId
        ? [{ label: 'Düzenlemeyi bitir', icon: 'done', onClick: () => exitBody() } as MenuItem]
        : [{ label: 'Mate', icon: mateIcon(), onClick: () => runCommand('mate', 'Mate', toggleMateTool) } as MenuItem]),
    ];
  }
  if (s.ui.tool === 'mate') {
    return [
      { label: 'Mate bitti', icon: 'done', primary: true, onClick: acceptMateSession },
      { label: 'Taşı', icon: 'move', hint: 'W', onClick: () => runCommand('move', 'Taşı', () => st().setUi({ mode: 'translate', tool: 'select' })) },
    ];
  }
  return [
    { label: 'Mate', icon: mateIcon(), hint: 'M', onClick: () => runCommand('mate', 'Mate', toggleMateTool) },
    { label: 'Taşı', icon: 'move', hint: 'W', onClick: () => runCommand('move', 'Taşı', () => st().setUi({ mode: 'translate', tool: 'select' })) },
    { label: 'Döndür', icon: 'rotate', hint: 'E', onClick: () => runCommand('rotate', 'Döndür', () => st().setUi({ mode: 'rotate', tool: 'select' })) },
    { label: 'Yeni parça', icon: 'newPart', onClick: () => runCommand('newpart-XY', 'Yeni parça (XY)', () => newPartOnPlane('XY')) },
    { label: 'Dosya ekle', icon: 'addFile', onClick: openFilePicker },
    { label: 'Grupla', icon: 'pickAssembly', hint: 'Ctrl+G', onClick: () => runCommand('group', 'Grupla', () => void groupSelection()) },
    { label: 'Sığdır', icon: 'fit', onClick: () => viewerApi.fit('all') },
    {
      label: 'Kenarlar',
      icon: 'edges',
      onClick: () => st().setUi({ showEdges: !st().ui.showEdges }),
    },
  ];
}
