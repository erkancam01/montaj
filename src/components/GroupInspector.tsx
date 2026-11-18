// Rijit grup ve çoklu seçim özellik panelleri.
import { useShallow } from 'zustand/react/shallow';
import { geometryCache } from '../lib/geometryCache';
import { eulerDegFromQuat, quatFromEulerDeg } from '../lib/math';
import { rigidSetOf, selectedPartIds } from '../lib/rigid';
import { viewerApi } from '../lib/viewerApi';
import {
  clickPart,
  duplicate,
  groupSelection,
  remove,
  removeSelection,
  rename,
  resetTransform,
  setColor,
  setRigidPivot,
  setVisible,
  ungroup,
} from '../store/actions';
import { useAssembly } from '../store/useAssembly';
import type { Selection, Transform, Vec3 } from '../types';
import { groupColor, partMap } from './GroupList';
import { IconClose, IconGroup } from './icons';
import { AXES, DEFAULT_SWATCH, NameField, NumberField, toHex } from './Inspector';

const EMPTY: never[] = [];

/** Rijit küme pivotunu sayı alanlarından düzenleme (konum + isteğe bağlı dönüş) */
function PivotFields({
  partIds,
  pivot,
  keyPrefix,
  withRotation,
  title,
}: {
  partIds: string[];
  pivot: Transform;
  keyPrefix: string;
  withRotation: boolean;
  title: string;
}) {
  const { snap, snapMove, snapAngle } = useAssembly(
    useShallow((s) => ({ snap: s.ui.snap, snapMove: s.ui.snapMove, snapAngle: s.ui.snapAngle })),
  );
  const euler = eulerDegFromQuat(pivot.quaternion);

  const setPos = (axis: number, v: number, mergeKey?: string) => {
    const p = [...pivot.position] as Vec3;
    p[axis] = v;
    setRigidPivot(partIds, pivot, { position: p, quaternion: pivot.quaternion }, mergeKey);
  };
  const setRot = (axis: number, v: number, mergeKey?: string) => {
    const e = [...euler] as Vec3;
    e[axis] = v;
    setRigidPivot(partIds, pivot, { position: pivot.position, quaternion: quatFromEulerDeg(e) }, mergeKey);
  };

  return (
    <section className="prop-section">
      <div className="prop-title">
        {title} <span className="unit">mm · dünya</span>
      </div>
      <div className="num-row">
        {AXES.map((a, i) => (
          <NumberField
            key={a}
            label={a}
            axis={i}
            value={pivot.position[i]}
            step={snap ? snapMove : 1}
            mergeKey={`pos:${keyPrefix}:${a}`}
            onCommit={(v, mk) => setPos(i, v, mk)}
          />
        ))}
      </div>
      {withRotation && (
        <>
          <div className="prop-title">
            Dönüş <span className="unit">derece · XYZ · grup ekseni</span>
          </div>
          <div className="num-row">
            {AXES.map((a, i) => (
              <NumberField
                key={a}
                label={a}
                axis={i}
                value={euler[i]}
                step={snap ? snapAngle : 1}
                mergeKey={`rot:${keyPrefix}:${a}`}
                onCommit={(v, mk) => setRot(i, v, mk)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ---------- grup ----------

export function GroupInspector({ id }: { id: string }) {
  // Pivot her belge değişiminde (gizmo sürükleme dahil) yeniden hesaplanır
  const doc = useAssembly((s) => s.doc);
  const group = doc.groups.find((g) => g.id === id);
  const sel: Selection = { kind: 'group', id };
  const rigid = group ? rigidSetOf(doc, sel, EMPTY) : null;
  // geometryCache reaktif değil; STEP rengi dosya hazır olunca okunabilsin
  useAssembly((s) => {
    const first = group && partMap(s.doc.parts).get(group.partIds[0]);
    return first ? s.fileStatus[first.fileId]?.status : undefined;
  });

  if (!group) return null;

  const parts = partMap(doc.parts);
  const members = group.partIds.map((pid) => parts.get(pid)).filter((p) => !!p);
  const visible = members.some((p) => p.visible);
  const customColor = members.find((p) => p.color)?.color ?? null;
  const first = members[0];
  const stepColor = first
    ? geometryCache.get(first.fileId)?.nodes[first.nodeKey]?.meshes.find((m) => m.color)?.color
    : undefined;
  const swatch = customColor ?? (stepColor ? toHex(stepColor) : DEFAULT_SWATCH);

  return (
    <div className="props">
      <section className="prop-section">
        <div className="prop-head">
          <span className="kind-tag group">
            <span className="group-dot" style={{ background: groupColor(id) }} aria-hidden="true" />
            Rijit grup
          </span>
        </div>
        <NameField value={group.name} onCommit={(v) => rename('group', id, v)} />
        <div className="prop-meta">{members.length} parça · tek gövde gibi taşınır</div>
        <ul className="member-list" aria-label="Grup üyeleri">
          {members.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`member-btn ${p.visible ? '' : 'hidden-item'}`}
                title={`Parçayı tek başına seç: ${p.name}`}
                onClick={() => clickPart(p.id, { direct: true })}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {rigid && <PivotFields partIds={rigid.partIds} pivot={rigid.pivot} keyPrefix={id} withRotation title="Konum" />}

      <section className="prop-section">
        <div className="prop-line">
          <span className="prop-label">Renk</span>
          <span className="prop-value color-ctl">
            <input
              type="color"
              className="color-input"
              value={swatch}
              title="Gruptaki tüm parçalara renk uygula"
              onChange={(e) => setColor('group', id, e.target.value)}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!customColor}
              title="STEP dosyasındaki orijinal renklere dön"
              onClick={() => setColor('group', id, null)}
            >
              STEP rengi
            </button>
          </span>
        </div>
        <div className="prop-line">
          <span className="prop-label">Görünür</span>
          <span className="prop-value">
            <input
              type="checkbox"
              className="checkbox"
              checked={visible}
              title="Grubu göster / gizle (H)"
              onChange={(e) => setVisible('group', id, e.target.checked)}
            />
          </span>
        </div>
      </section>

      <section className="prop-section actions-grid">
        <button type="button" className="btn" title="Zemine oturt (G)" onClick={() => viewerApi.dropToFloor(sel)}>
          Zemine oturt
        </button>
        <button type="button" className="btn" title="Odakla (F)" onClick={() => viewerApi.fit('selection')}>
          Odakla
        </button>
        <button type="button" className="btn" title="Grubu üyeleriyle çoğalt (Ctrl+D)" onClick={() => duplicate(sel)}>
          Çoğalt
        </button>
        <button
          type="button"
          className="btn"
          title="Üyeleri ilk içe aktarılan konumlarına döndür"
          onClick={() => resetTransform(sel)}
        >
          Konumu sıfırla
        </button>
        <button
          type="button"
          className="btn"
          title="Grubu çöz; parçalar yerinde kalır (Ctrl+Shift+G)"
          onClick={() => ungroup(id)}
        >
          Grubu çöz
        </button>
        <button type="button" className="btn btn-danger" title="Gruptaki tüm parçaları sil (Del)" onClick={() => remove(sel)}>
          Sil
        </button>
      </section>
    </div>
  );
}

// ---------- çoklu seçim ----------

interface SelItem {
  kind: 'instance' | 'part' | 'group';
  id: string;
  name: string;
  count: number;
}

export function MultiSelectionProps() {
  const doc = useAssembly((s) => s.doc);
  const selection = useAssembly((s) => s.selection);
  const extraSel = useAssembly((s) => s.extraSel);

  if (!selection) return null;

  const partIds = selectedPartIds(doc, selection, extraSel);
  const rigid = rigidSetOf(doc, selection, extraSel);
  const parts = partMap(doc.parts);
  const items: SelItem[] = [selection, ...extraSel].map((it) => {
    if (it.kind === 'group') {
      const g = doc.groups.find((x) => x.id === it.id);
      return { kind: 'group', id: it.id, name: g?.name ?? '?', count: g?.partIds.length ?? 0 };
    }
    if (it.kind === 'instance') {
      const inst = doc.instances.find((x) => x.id === it.id);
      return { kind: 'instance', id: it.id, name: inst?.name ?? '?', count: 0 };
    }
    return { kind: 'part', id: it.id, name: parts.get(it.id)?.name ?? '?', count: 1 };
  });
  const st = () => useAssembly.getState();

  return (
    <div className="props">
      <section className="prop-section">
        <div className="prop-head">
          <span className="kind-tag multi">Çoklu seçim</span>
        </div>
        <div className="multi-count">{partIds.length} parça seçili</div>
        <ul className="member-list" aria-label="Seçili öğeler">
          {items.map((it, i) => (
            <li key={`${it.kind}:${it.id}`} className="member-item">
              <button
                type="button"
                className={`member-btn ${i === 0 ? 'primary' : ''}`}
                title={i === 0 ? `Birincil seçim: ${it.name}` : `Yalnız bunu seç: ${it.name}`}
                onClick={() => st().select({ kind: it.kind, id: it.id })}
              >
                {it.kind === 'group' && (
                  <span className="group-dot" style={{ background: groupColor(it.id) }} aria-hidden="true" />
                )}
                {it.name}
                {it.kind === 'group' && <span className="member-sub"> · grup, {it.count} parça</span>}
              </button>
              {it.kind !== 'instance' && (
                <button
                  type="button"
                  className="tree-eye"
                  title="Seçimden çıkar"
                  aria-label="Seçimden çıkar"
                  onClick={() => st().toggleExtra({ kind: it.kind as 'part' | 'group', id: it.id })}
                >
                  <IconClose size={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {rigid && (
        <PivotFields
          partIds={rigid.partIds}
          pivot={rigid.pivot}
          keyPrefix="multi"
          withRotation={false}
          title="Konum (küme merkezi)"
        />
      )}

      <section className="prop-section actions-grid">
        <button
          type="button"
          className="btn btn-primary span-2"
          disabled={partIds.length < 2}
          title="Seçili parçaları tek rijit grupta birleştir (Ctrl+G)"
          onClick={() => groupSelection()}
        >
          <IconGroup size={14} /> Grupla (Ctrl+G)
        </button>
        <button type="button" className="btn" title="Zemine oturt (G)" onClick={() => viewerApi.dropToFloor(selection)}>
          Zemine oturt
        </button>
        <button type="button" className="btn" title="Odakla (F)" onClick={() => viewerApi.fit('selection')}>
          Odakla
        </button>
        <button type="button" className="btn" title="Seçimi temizle (Esc)" onClick={() => st().select(null)}>
          Seçimi temizle
        </button>
        <button
          type="button"
          className="btn btn-danger"
          title="Seçili tüm parçaları sil (Del)"
          onClick={() => removeSelection()}
        >
          Sil
        </button>
      </section>
    </div>
  );
}
