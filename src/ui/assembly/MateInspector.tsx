// Seçili mate'in özellik paneli.
import { useShallow } from 'zustand/react/shallow';
import { getFaceGeom } from '@/core/geometry/faceGeometry';
import { compatibleTypes, FACE_KIND_LABELS, MATE_HINTS, MATE_LABELS } from '@/core/assembly/mateMeta';
import { clickPart, removeMate, swapMate, updateMate } from '@/state/assemblyActions';
import { useAssembly } from '@/state/useAssembly';
import type { FaceGeom, FaceRef, MateType, Part } from '@/core/types';
import { groupByPart } from '@/ui/assembly/GroupList';
import { IconSwap } from '@/ui/icons/icons';
import { NameField } from '@/ui/shell/Inspector';
import { ExprField } from '@/ui/params/ExprField';
import { mateExprKey } from '@/core/modeling/params';
import { mateStateOf, mateStateText, MateTypeIcon } from '@/ui/assembly/MateList';

/** Flip'in anlamlı olduğu tipler */
const FLIP_TYPES = new Set<MateType>(['coincident', 'concentric', 'parallel', 'angle']);

const clampAngle = (v: number) => Math.min(180, Math.max(0, v));

/** Geometri modülü hazır değilse / hata verirse null (arayüz çökmesin) */
function faceGeomSafe(part: Part | undefined, ref: FaceRef): FaceGeom | null {
  if (!part) return null;
  try {
    return getFaceGeom(part, ref.meshIndex, ref.faceIndex);
  } catch (e) {
    console.error('Yüzey geometrisi okunamadı', e);
    return null;
  }
}

/** Parçanın kendisini seçer (gruptaysa da grubu değil parçayı) */
function selectPart(id: string) {
  clickPart(id, { direct: true });
}

function selectGroup(id: string) {
  useAssembly.getState().select({ kind: 'group', id });
}

export function MateInspector({ id }: { id: string }) {
  const { mate, partA, partB, status } = useAssembly(
    useShallow((s) => {
      const mate = s.doc.mates.find((m) => m.id === id);
      return {
        mate,
        partA: mate ? s.doc.parts.find((p) => p.id === mate.a.partId) : undefined,
        partB: mate ? s.doc.parts.find((p) => p.id === mate.b.partId) : undefined,
        status: s.mateStatus[id],
      };
    }),
  );
  /** Hareketli parçanın grubu (varsa tüm grup hareket eder) */
  const bGroup = useAssembly(
    useShallow((s) => {
      const g = mate ? groupByPart(s.doc.groups).get(mate.b.partId) : undefined;
      return { id: g?.id ?? null, name: g?.name ?? '' };
    }),
  );
  // geometryCache reaktif değil; dosyalar hazır olunca yüzey geometrisini yeniden okumak için
  useAssembly((s) => (partA ? s.fileStatus[partA.fileId]?.status : undefined));
  useAssembly((s) => (partB ? s.fileStatus[partB.fileId]?.status : undefined));
  const { snap, snapMove, snapAngle } = useAssembly(
    useShallow((s) => ({ snap: s.ui.snap, snapMove: s.ui.snapMove, snapAngle: s.ui.snapAngle })),
  );

  if (!mate) return null;

  const ga = faceGeomSafe(partA, mate.a);
  const gb = faceGeomSafe(partB, mate.b);
  const compatible = ga && gb ? compatibleTypes(ga, gb) : [];
  const types = compatible.includes(mate.type) ? compatible : [mate.type, ...compatible];
  const state = mateStateOf(mate, status);
  const stateText = mateStateText(state, status);
  const faceInfo = (g: FaceGeom | null) => (g ? ` · ${FACE_KIND_LABELS[g.kind]}` : '');

  return (
    <div className="props">
      <section className="prop-section">
        <div className="prop-head">
          <span className="kind-tag mate">
            <MateTypeIcon type={mate.type} size={12} /> Mate · {MATE_LABELS[mate.type]}
          </span>
        </div>
        <NameField value={mate.name} onCommit={(v) => updateMate(id, { name: v.trim() })} />
      </section>

      <section className="prop-section">
        <div className="prop-line">
          <span className="prop-label">Referans</span>
          <span className="prop-value mate-part">
            <button
              type="button"
              className="link-btn inline"
              disabled={!partA}
              title={partA ? `Parçayı seç: ${partA.name}${faceInfo(ga)}` : 'Parça bulunamadı'}
              onClick={() => partA && selectPart(partA.id)}
            >
              {partA?.name ?? '?'}
            </button>
            <span className="mate-role">sabit</span>
          </span>
        </div>
        <div className="prop-line">
          <span className="prop-label">Hareketli</span>
          <span className="prop-value mate-part">
            <button
              type="button"
              className="link-btn inline"
              disabled={!partB}
              title={partB ? `Parçayı seç: ${partB.name}${faceInfo(gb)}` : 'Parça bulunamadı'}
              onClick={() => partB && selectPart(partB.id)}
            >
              {partB?.name ?? '?'}
            </button>
            <span className="mate-role moving">hareket eder</span>
          </span>
        </div>
        {bGroup.id && (
          <p className="mate-group-note">
            (
            <button
              type="button"
              className="link-btn inline"
              title="Grubu seç"
              onClick={() => bGroup.id && selectGroup(bGroup.id)}
            >
              Grup: {bGroup.name}
            </button>{' '}
            — tüm grup hareket eder)
          </p>
        )}
        <button
          type="button"
          className="btn btn-small mate-swap"
          title="Referans ile hareketli parçayı yer değiştir"
          onClick={() => swapMate(id)}
        >
          <IconSwap size={13} /> Yer değiştir
        </button>
      </section>

      <section className="prop-section">
        <div className="prop-line">
          <span className="prop-label">Tip</span>
          <span className="prop-value">
            <select
              className="select-input"
              value={mate.type}
              disabled={types.length < 2}
              title={types.length < 2 ? 'Bu yüzeyler için başka mate tipi yok' : 'Mate tipi'}
              onChange={(e) => updateMate(id, { type: e.target.value as MateType })}
            >
              {types.map((t) => (
                <option key={t} value={t}>
                  {MATE_LABELS[t]}
                </option>
              ))}
            </select>
          </span>
        </div>
        <p className="mate-hint">{MATE_HINTS[mate.type]}</p>

        {mate.type === 'coincident' && (
          <div className="prop-line">
            <span className="prop-label wide">Mesafe (mm)</span>
            <ExprField
              value={mate.offset}
              expr={mate.offsetExpr}
              step={snap ? snapMove : 1}
              mergeKey={`mate-offset:${id}`}
              errorKey={mateExprKey(id, 'offset')}
              onCommit={({ value, expr }) => updateMate(id, { offset: value, offsetExpr: expr })}
            />
          </div>
        )}
        {mate.type === 'angle' && (
          <div className="prop-line">
            <span className="prop-label wide">Açı (°)</span>
            <ExprField
              value={mate.angle}
              expr={mate.angleExpr}
              unit="deg"
              step={snap ? snapAngle : 1}
              mergeKey={`mate-angle:${id}`}
              errorKey={mateExprKey(id, 'angle')}
              onCommit={({ value, expr }) => updateMate(id, { angle: clampAngle(value), angleExpr: expr })}
            />
          </div>
        )}
        {FLIP_TYPES.has(mate.type) && (
          <div className="prop-line">
            <span className="prop-label wide">Yön</span>
            <button
              type="button"
              className={`btn btn-small btn-toggle ${mate.flip ? 'on' : ''}`}
              aria-pressed={mate.flip}
              title="Hareketli yüzeyin yönünü ters çevir"
              onClick={() => updateMate(id, { flip: !mate.flip })}
            >
              Yönü çevir
            </button>
          </div>
        )}
        <div className="prop-line">
          <span className="prop-label wide">Bastır</span>
          <span className="prop-value">
            <input
              type="checkbox"
              className="checkbox"
              checked={mate.suppressed}
              title="Bastırılmış mate çözülmez"
              onChange={(e) => updateMate(id, { suppressed: e.target.checked })}
            />
          </span>
        </div>
      </section>

      <section className="prop-section">
        <div className={`mate-status state-${state}`} role="status" title={stateText}>
          <span className={`mate-dot state-${state}`} aria-hidden="true" />
          <span className="mate-status-text">{stateText}</span>
        </div>
      </section>

      <section className="prop-section actions-grid">
        <button type="button" className="btn btn-danger span-2" title="Mate'i sil (Del)" onClick={() => removeMate(id)}>
          Mate'i sil
        </button>
      </section>
    </div>
  );
}
