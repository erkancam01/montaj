// Sol panelin üstünde düzenlenen gövdenin özellik ağacı (geçmiş).
import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  breakExternalRefs,
  deleteFeature,
  dependentsOf,
  editFeature,
  editSketch,
  exitBody,
  FEATURE_LABELS,
  moveFeature,
  renameBody,
  renameFeature,
  setFeatureSuppressed,
} from '../../modeling/actions';
import { useAssembly } from '../../store/useAssembly';
import { liveSourcesOf } from '../../modeling/refLocks';
import type { Feature } from '../../types';
import { IconEye, IconEyeOff } from '../icons';
import { NameField } from '../Inspector';
import { featureIconName, FIcon } from './featureIcons';
import './modeling.css';

export function FeatureTree() {
  const bodyId = useAssembly((s) => s.modeling.activeBodyId);
  if (!bodyId) return null;
  return <FeatureTreePanel key={bodyId} bodyId={bodyId} />;
}

function FeatureTreePanel({ bodyId }: { bodyId: string }) {
  const body = useAssembly((s) => s.doc.bodies.find((b) => b.id === bodyId));
  const build = useAssembly((s) => s.modeling.build[bodyId]);
  const { editingId, draftNew, sketchId, sketchNew } = useAssembly(
    useShallow((s) => {
      const f = s.modeling.feature;
      const sk = s.modeling.sketch;
      return {
        editingId: f && f.bodyId === bodyId ? f.draft.id : null,
        draftNew: f && f.bodyId === bodyId && f.isNew ? f.draft : null,
        sketchId: sk && sk.bodyId === bodyId ? sk.featureId : null,
        sketchNew: sk && sk.bodyId === bodyId && sk.isNew ? sk.data : null,
      };
    }),
  );
  const linked = useAssembly(
    useShallow((s) => {
      const b = s.doc.bodies.find((x) => x.id === bodyId);
      if (!b) return null;
      const ids = liveSourcesOf(s.doc, b);
      if (!ids.length) return null;
      const names = ids.map((id) => s.doc.parts.find((p) => p.id === id)?.name ?? '?').join(', ');
      const broken = b.features.some(
        (f) => f.type === 'sketch' && (f.planeRef?.broken || f.projections?.some((p) => !p.frozen && p.broken)),
      );
      return { names, broken };
    }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  // Silinen özellik seçili kalmasın
  useEffect(() => {
    if (selected && body && !body.features.some((f) => f.id === selected)) setSelected(null);
  }, [body, selected]);

  if (!body) return null;
  const features = body.features;
  const errors = build?.featureErrors ?? {};
  const nErr = Object.keys(errors).length;
  const locked = !!sketchId;

  const onDelete = (f: Feature) => {
    const deps = dependentsOf(body, f.id);
    if (deps.length) {
      const names = deps
        .map((id) => features.find((x) => x.id === id)?.name)
        .filter(Boolean)
        .join(', ');
      if (!window.confirm(`"${f.name}" silinirse ona bağlı ${deps.length} özellik de silinir:\n${names}\n\nDevam edilsin mi?`)) return;
    }
    deleteFeature(bodyId, f.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!selected || renaming) return;
    const f = features.find((x) => x.id === selected);
    if (!f) return;
    if (e.key === 'F2') {
      e.preventDefault();
      setRenaming(f.id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      onDelete(f);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!locked) edit(f);
    }
  };

  const edit = (f: Feature) => {
    if (f.type === 'sketch') editSketch(bodyId, f.id);
    else editFeature(bodyId, f.id);
  };

  return (
    <section className="ft" aria-label="Özellik ağacı">
      <div className="ft-head">
        <span className="ft-body-icon">
          <FIcon name="body" />
        </span>
        <div className="ft-name">
          <NameField value={body.name} onCommit={(v) => renameBody(bodyId, v)} />
        </div>
        <BuildBadge state={build?.state} nErr={nErr} message={build?.message} />
      </div>
      <div
        className="ft-list"
        role="tree"
        aria-label="Özellikler"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {features.length === 0 && !draftNew && !sketchNew && (
          <div className="ft-empty">Henüz özellik yok. Araç çubuğundan “Sketch” ile başlayın.</div>
        )}
        {features.map((f, i) => (
          <FeatureRow
            key={f.id}
            f={f}
            first={i === 0}
            last={i === features.length - 1}
            error={errors[f.id]}
            selected={selected === f.id}
            editing={editingId === f.id || sketchId === f.id}
            locked={locked}
            renaming={renaming === f.id}
            onSelect={() => setSelected(f.id)}
            onEdit={() => edit(f)}
            onToggle={() => setFeatureSuppressed(bodyId, f.id, !f.suppressed)}
            onMove={(d) => moveFeature(bodyId, f.id, d)}
            onDelete={() => onDelete(f)}
            onRename={(n) => {
              setRenaming(null);
              if (n !== null) renameFeature(bodyId, f.id, n);
            }}
          />
        ))}
        {draftNew && (
          <div className="ft-row draft editing" title="Oluşturuluyor: sağ panelden Uygula ya da İptal">
            <span className="ft-icon">
              <FIcon name={featureIconName(draftNew as Feature & { operation?: string })} />
            </span>
            <span className="ft-label">{draftNew.name}</span>
            <span className="ft-tag">yeni</span>
            {errors[draftNew.id] && <span className="ft-err-dot" title={errors[draftNew.id]} />}
          </div>
        )}
        {sketchNew && (
          <div className="ft-row draft editing" title="Sketch çiziliyor">
            <span className="ft-icon">
              <FIcon name="sketch" />
            </span>
            <span className="ft-label">{sketchNew.name}</span>
            <span className="ft-tag">çiziliyor</span>
          </div>
        )}
      </div>
      {linked && (
        <div className="ft-link" title={`Bağlı olduğu parçalar: ${linked.names}`}>
          <span className="ft-link-icon" aria-hidden="true">🔗</span>
          <span className="ft-link-text">
            {linked.names} parçasına bağlı{linked.broken ? ' · bazı referanslar bulunamadı' : ''}
          </span>
          <button
            type="button"
            className="btn btn-small"
            disabled={!!sketchId}
            title="Referansları sabit kopyaya çevir: parça kaynağı izlemez ve serbestçe taşınabilir"
            onClick={() => breakExternalRefs(bodyId)}
          >
            Bağlantıyı kopar
          </button>
        </div>
      )}
      <div className="ft-foot">
        <span className="ft-count">
          {features.length} özellik{nErr ? ` · ${nErr} hata` : ''}
        </span>
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={!!sketchId}
          title={sketchId ? 'Önce sketch oturumunu bitirin' : 'Parça düzenlemesini bitir'}
          onClick={() => exitBody()}
        >
          Bitir
        </button>
      </div>
    </section>
  );
}

function BuildBadge({ state, nErr, message }: { state?: 'building' | 'ok' | 'error'; nErr: number; message?: string }) {
  if (state === 'building') {
    return (
      <span className="ft-build building" title="Geometri yeniden üretiliyor">
        <span className="spinner" aria-hidden="true" />
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="ft-build error" title={message ?? 'Üretim hatası'}>
        {nErr ? `${nErr} hata` : 'Hata'}
      </span>
    );
  }
  if (state === 'ok') {
    return (
      <span className="ft-build ok" title="Geometri güncel">
        <FIcon name="check" size={13} />
      </span>
    );
  }
  return null;
}

interface RowProps {
  f: Feature;
  first: boolean;
  last: boolean;
  error?: string;
  selected: boolean;
  editing: boolean;
  locked: boolean;
  renaming: boolean;
  onSelect(): void;
  onEdit(): void;
  onToggle(): void;
  onMove(d: -1 | 1): void;
  onDelete(): void;
  onRename(name: string | null): void;
}

function describe(f: Feature): string {
  switch (f.type) {
    case 'sketch': {
      const n = `${f.entities.filter((e) => e.kind !== 'point').length} eğri`;
      const live = !!f.planeRef || !!f.projections?.some((p) => !p.frozen);
      const broken = !!f.planeRef?.broken || !!f.projections?.some((p) => !p.frozen && p.broken);
      return live ? `${n} · 🔗${broken ? ' ⚠' : ''}` : n;
    }
    case 'extrude':
      return `${f.operation === 'cut' ? 'Kes' : 'Ekle'} · ${f.throughAll ? 'tümünden' : `${Number(f.distance.toFixed(2))} mm`}`;
    case 'revolve':
      return `${f.operation === 'cut' ? 'Kes' : 'Ekle'} · ${Number(f.angle.toFixed(1))}°`;
    case 'fillet':
      return `R${Number(f.radius.toFixed(2))} · ${f.edges.length} kenar`;
    case 'chamfer':
      return `${Number(f.distance.toFixed(2))} mm · ${f.edges.length} kenar`;
    case 'hole':
      return `Ø${Number(f.diameter.toFixed(2))} · ${f.points.length} adet`;
    case 'linearPattern':
      return `${f.count1}${f.count2 > 1 ? `×${f.count2}` : ''} adet`;
    case 'circularPattern':
      return `${f.count} adet · ${Number(f.angle.toFixed(1))}°`;
    case 'mirror':
      return f.featureIds.length ? `${f.featureIds.length} özellik` : 'tüm gövde';
  }
}

const FeatureRow = memo(function FeatureRow(p: RowProps) {
  const { f } = p;
  const cls = [
    'ft-row',
    p.selected ? 'selected' : '',
    p.editing ? 'editing' : '',
    f.suppressed ? 'suppressed' : '',
    p.error ? 'has-error' : '',
  ].join(' ');
  const typeLabel =
    f.type === 'extrude' && f.operation === 'cut' ? 'Kesme' : f.type === 'revolve' && f.operation === 'cut' ? 'Revolve (kes)' : FEATURE_LABELS[f.type];
  const title = p.error
    ? `${f.name} — Hata: ${p.error}`
    : `${typeLabel}: ${f.name}${f.suppressed ? ' (bastırılmış)' : ''} — çift tık: düzenle · F2: yeniden adlandır`;
  return (
    <div
      className={cls}
      role="treeitem"
      aria-selected={p.selected}
      title={title}
      onClick={p.onSelect}
      onDoubleClick={() => {
        if (!p.locked) p.onEdit();
      }}
    >
      <span className="ft-icon">
        <FIcon name={featureIconName(f as Feature & { operation?: string })} />
      </span>
      {p.renaming ? (
        <RenameInput value={f.name} onDone={p.onRename} />
      ) : (
        <span className="ft-label">
          {f.name}
          <span className="ft-desc">{describe(f)}</span>
        </span>
      )}
      {p.error && <span className="ft-err-dot" aria-label="Hata" />}
      <span className="ft-actions" onDoubleClick={(e) => e.stopPropagation()}>
        <RowBtn title="Düzenle" disabled={p.locked} onClick={p.onEdit}>
          <FIcon name="pencil" size={13} />
        </RowBtn>
        <RowBtn title={f.suppressed ? 'Etkinleştir' : 'Bastır'} disabled={p.locked} onClick={p.onToggle}>
          {f.suppressed ? <IconEyeOff size={13} /> : <IconEye size={13} />}
        </RowBtn>
        <RowBtn title="Yukarı taşı" disabled={p.locked || p.first} onClick={() => p.onMove(-1)}>
          <FIcon name="up" size={13} />
        </RowBtn>
        <RowBtn title="Aşağı taşı" disabled={p.locked || p.last} onClick={() => p.onMove(1)}>
          <FIcon name="down" size={13} />
        </RowBtn>
        <RowBtn title="Sil" danger disabled={p.locked} onClick={p.onDelete}>
          <FIcon name="trash" size={13} />
        </RowBtn>
      </span>
    </div>
  );
});

function RowBtn({
  title,
  disabled,
  danger,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  danger?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ft-btn ${danger ? 'danger' : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone(v: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className="text-input ft-rename"
      defaultValue={value}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value.trim() && e.currentTarget.value !== value ? e.currentTarget.value : null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') finish(null);
      }}
    />
  );
}
