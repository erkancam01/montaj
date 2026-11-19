// Sağ panel: açık özellik taslağının formu. Her değişiklik taslağa yazılır (canlı önizleme);
// Uygula geçmişe işler, İptal taslağı atar.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { worldFaceGeom } from '../../lib/faceGeometry';
import {
  applyFeature,
  BASE_PLANES,
  cancelFeature,
  FEATURE_LABELS,
  planeFromFace,
  updateFeatureDraft,
  worldPlaneToBody,
} from '../../modeling/actions';
import { useAssembly } from '../../store/useAssembly';
import type {
  Body,
  ChamferFeature,
  CircularPatternFeature,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  HoleFeature,
  LinearPatternFeature,
  MirrorFeature,
  PickRequest,
  PickTarget,
  RevolveFeature,
  SketchFeature,
  Vec2,
  Vec3,
} from '../../types';
import { NameField, NumberField } from '../Inspector';
import { ExprField } from '../params/ExprField';
import { featureExprKey } from '../../modeling/params';
import { IconClose } from '../icons';
import { featureIconName, FIcon } from './featureIcons';
import {
  AXIS_DIRS,
  axisName,
  basePlaneName,
  edgeLabel,
  fmtVec,
  patternSources,
  pointMap,
  sameSig,
  sketchLines,
  sketchRegions,
} from './geom';
import { useModelingUi } from './modelingUi';
import './modeling.css';

const st = () => useAssembly.getState();
const up = (p: Partial<Feature>) => updateFeatureDraft(p);
const curDraft = () => st().modeling.feature?.draft;

// ---------------------------------------------------------------- Seçim isteği yardımcıları

export const PICK_KEYS = {
  edges: 'edges',
  holeFace: 'hole-face',
  dir1: 'lp-dir1',
  dir2: 'lp-dir2',
  cpAxis: 'cp-axis',
  mirrorPlane: 'mirror-plane',
} as const;

/** Bu anahtarlı seçim isteğinin picked listesi değişince fn çağrılır */
function usePicked(key: string, fn: (picked: PickTarget[]) => void) {
  const picked = useAssembly((s) => (s.modeling.pick?.key === key ? s.modeling.pick.picked : null));
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    if (picked && picked.length) fnRef.current(picked);
  }, [picked]);
}

function usePickKey(): string | null {
  return useAssembly((s) => s.modeling.pick?.key ?? null);
}

function togglePick(active: boolean, req: Omit<PickRequest, 'picked'>) {
  if (active) st().endPick();
  else st().startPick(req);
}

/** Kenar seçimi: önizleme gizlenir ki özgün kenarlar seçilebilsin */
function startEdgePick(bodyId: string, prompt: string) {
  const d = curDraft();
  const ui = useModelingUi.getState();
  if (d && ui.edgeRestore === null) {
    ui.set({ edgeRestore: d.suppressed, edgeSnapshot: d.type === 'fillet' || d.type === 'chamfer' ? [...d.edges] : null });
    up({ suppressed: true });
  }
  st().startPick({ key: PICK_KEYS.edges, kinds: ['edge'], bodyId, multi: true, prompt });
}

/** Kenar seçimi bittiyse taslağın bastırma değerini geri yükler */
function restoreEdgeSuppression() {
  const ui = useModelingUi.getState();
  if (ui.edgeRestore === null) return;
  const v = ui.edgeRestore;
  ui.set({ edgeRestore: null, edgeSnapshot: null });
  up({ suppressed: v });
}

// ---------------------------------------------------------------- Doğrulama

function validate(d: Feature, body: Body | undefined, ui: { profileMode: 'all' | 'pick'; holeFaceChosen: boolean }): string | null {
  const sketch = (id: string) => body?.features.find((f): f is SketchFeature => f.id === id && f.type === 'sketch');
  switch (d.type) {
    case 'extrude':
      if (!sketch(d.sketchId)) return 'Bir sketch seçin';
      if (ui.profileMode === 'pick' && !d.profilePoints.length) return 'Sahnede en az bir profil bölgesi seçin';
      if (!d.throughAll && !(d.distance > 0) && !(d.extent === 'twoSides' && d.distance2 > 0)) return 'Mesafe sıfırdan büyük olmalı';
      return null;
    case 'revolve': {
      const sk = sketch(d.sketchId);
      if (!sk) return 'Bir sketch seçin';
      if (!sk.entities.some((e) => e.id === d.axisLineId && e.kind === 'line')) return 'Dönme ekseni olarak bir çizgi seçin';
      if (ui.profileMode === 'pick' && !d.profilePoints.length) return 'Sahnede en az bir profil bölgesi seçin';
      if (!(d.angle > 0)) return 'Açı sıfırdan büyük olmalı';
      return null;
    }
    case 'fillet':
      if (!d.edges.length) return 'En az bir kenar seçin';
      if (!(d.radius > 0)) return 'Yarıçap sıfırdan büyük olmalı';
      return null;
    case 'chamfer':
      if (!d.edges.length) return 'En az bir kenar seçin';
      if (!(d.distance > 0)) return 'Mesafe sıfırdan büyük olmalı';
      return null;
    case 'hole':
      if (!ui.holeFaceChosen) return 'Deliğin açılacağı düz yüzeyi seçin';
      if (!d.points.length) return 'En az bir delik merkezi ekleyin';
      if (!(d.diameter > 0)) return 'Çap sıfırdan büyük olmalı';
      if (!d.throughAll && !(d.depth > 0)) return 'Derinlik sıfırdan büyük olmalı';
      return null;
    case 'linearPattern':
      if (!d.featureIds.length) return 'Çoğaltılacak en az bir özellik seçin';
      if (d.count1 < 2 && d.count2 < 2) return 'Adet en az 2 olmalı';
      return null;
    case 'circularPattern':
      if (!d.featureIds.length) return 'Çoğaltılacak en az bir özellik seçin';
      if (d.count < 2) return 'Adet en az 2 olmalı';
      return null;
    case 'mirror':
      return null;
    case 'sketch':
      return 'Sketch bu panelde düzenlenmez';
  }
}

// ---------------------------------------------------------------- Onay (sol panel ✓ ve onay köşesi de kullanır)

/** Açık özellik taslağı uygulanamıyorsa nedeni (açık özellik yoksa da bir metin) */
export function useFeatureInvalid(): string | null {
  const draft = useAssembly((s) => s.modeling.feature?.draft);
  const body = useAssembly((s) => {
    const f = s.modeling.feature;
    return f ? s.doc.bodies.find((b) => b.id === f.bodyId) : undefined;
  });
  const ui = useModelingUi(useShallow((s) => ({ profileMode: s.profileMode, holeFaceChosen: s.holeFaceChosen })));
  return draft ? validate(draft, body, ui) : 'Açık özellik yok';
}

/** Taslak geçerliyse özelliği geçmişe işler */
export function tryApplyFeature(): boolean {
  const s = st();
  const fs = s.modeling.feature;
  if (!fs) return false;
  const body = s.doc.bodies.find((b) => b.id === fs.bodyId);
  const invalid = validate(fs.draft, body, useModelingUi.getState());
  if (invalid) {
    s.showToast(invalid, 'error');
    return false;
  }
  restoreEdgeSuppression();
  useModelingUi.getState().reset();
  applyFeature();
  return true;
}

// ---------------------------------------------------------------- Panel

export function FeatureInspector() {
  const fs = useAssembly(useShallow((s) => (s.modeling.feature ? { bodyId: s.modeling.feature.bodyId, isNew: s.modeling.feature.isNew, id: s.modeling.feature.draft.id } : null)));
  if (!fs) return null;
  return <FeatureForm key={fs.id} bodyId={fs.bodyId} isNew={fs.isNew} />;
}

function FeatureForm({ bodyId, isNew }: { bodyId: string; isNew: boolean }) {
  const draft = useAssembly((s) => s.modeling.feature?.draft);
  const body = useAssembly((s) => s.doc.bodies.find((b) => b.id === bodyId));
  const error = useAssembly((s) => (draft ? s.modeling.build[bodyId]?.featureErrors[draft.id] : undefined));
  const building = useAssembly((s) => s.modeling.build[bodyId]?.state === 'building');
  const buildMsg = useAssembly((s) => (s.modeling.build[bodyId]?.state === 'error' ? s.modeling.build[bodyId]?.message : undefined));
  const ui = useModelingUi(useShallow((s) => ({ profileMode: s.profileMode, holeFaceChosen: s.holeFaceChosen, edgeRestore: s.edgeRestore })));
  const pickKey = usePickKey();

  // Oturum başında arayüz durumunu kur; kapanınca sıfırla
  useEffect(() => {
    const d = curDraft();
    const u = useModelingUi.getState();
    u.reset();
    if (d && (d.type === 'extrude' || d.type === 'revolve')) u.set({ profileMode: d.profilePoints.length ? 'pick' : 'all' });
    if (d && d.type === 'hole') u.set({ holeFaceChosen: !isNew, holePlace: false });
    // Yeni özellikte ilk adım doğrudan başlar
    if (isNew && d) {
      if (d.type === 'fillet') startEdgePick(bodyId, 'Yuvarlatılacak kenarları seçin (tekrar tıklamak kaldırır)');
      else if (d.type === 'chamfer') startEdgePick(bodyId, 'Pah kırılacak kenarları seçin (tekrar tıklamak kaldırır)');
      else if (d.type === 'hole')
        st().startPick({ key: PICK_KEYS.holeFace, kinds: ['face'], filter: ['plane'], bodyId, multi: false, prompt: 'Deliğin açılacağı düz yüzeyi seçin' });
    }
    return () => {
      // Önizleme gizlenmişse geri aç (oturum kapandıysa etkisizdir)
      restoreEdgeSuppression();
      useModelingUi.getState().reset();
    };
  }, [bodyId, isNew]);

  // Kenar seçimi bitince önizlemeyi geri aç
  useEffect(() => {
    if (pickKey !== PICK_KEYS.edges && ui.edgeRestore !== null) restoreEdgeSuppression();
  }, [pickKey, ui.edgeRestore]);

  if (!draft) return null;
  const invalid = validate(draft, body, ui);
  const label = draft.type === 'extrude' && draft.operation === 'cut' ? 'Kesme' : FEATURE_LABELS[draft.type];

  const onApply = () => {
    if (invalid) return;
    tryApplyFeature();
  };

  return (
    <div className="props fi">
      <section className="prop-section">
        <div className="prop-head fi-head">
          <span className="kind-tag fi-tag">
            <FIcon name={featureIconName(draft as Feature & { operation?: string })} size={13} />
            {label}
          </span>
          <span className="fi-state">{isNew ? 'Yeni' : 'Düzenleniyor'}</span>
        </div>
        <NameField value={draft.name} onCommit={(v) => up({ name: v.trim() })} />
      </section>

      {draft.type === 'extrude' && <ExtrudeForm d={draft} body={body} />}
      {draft.type === 'revolve' && <RevolveForm d={draft} body={body} />}
      {(draft.type === 'fillet' || draft.type === 'chamfer') && <EdgeFeatureForm d={draft} bodyId={bodyId} />}
      {draft.type === 'hole' && <HoleForm d={draft} bodyId={bodyId} />}
      {draft.type === 'linearPattern' && <LinearPatternForm d={draft} body={body} bodyId={bodyId} />}
      {draft.type === 'circularPattern' && <CircularPatternForm d={draft} body={body} bodyId={bodyId} />}
      {draft.type === 'mirror' && <MirrorForm d={draft} body={body} bodyId={bodyId} />}

      <section className="prop-section fi-foot">
        {error ? (
          <div className="fi-error" role="alert">
            <strong>Üretilemedi:</strong> {error}
          </div>
        ) : buildMsg && !building ? (
          <div className="fi-error" role="alert">
            {buildMsg}
          </div>
        ) : null}
        <div className="fi-status">
          {building ? (
            <>
              <span className="spinner" aria-hidden="true" /> Önizleme üretiliyor…
            </>
          ) : invalid ? (
            <span className="fi-invalid">{invalid}</span>
          ) : (
            <span className="fi-ready">Uygulamaya hazır</span>
          )}
        </div>
        <div className="fi-actions">
          <button type="button" className="btn" title="Taslağı at" onClick={() => cancelFeature()}>
            İptal
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!invalid}
            title={invalid ?? 'Özelliği geçmişe işle (geri alınabilir)'}
            onClick={onApply}
          >
            Uygula
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Ortak alanlar

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="fi-field">
      <div className="fi-row">
        <span className="fi-label">{label}</span>
        <div className="fi-ctl">{children}</div>
      </div>
      {hint && <div className="fi-hint">{hint}</div>}
    </div>
  );
}

function Num({
  k,
  value,
  onChange,
  unit = 'mm',
  step = 1,
  min,
  max,
  int,
  field,
}: {
  k: string;
  value: number;
  onChange(v: number): void;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  int?: boolean;
  /** Özellik alan adı: verilirse alan ifade (parametre) kabul eder ve draft.exprs'e yazar */
  field?: string;
}) {
  const draft = useAssembly((s) => s.modeling.feature?.draft);
  if (field && draft) {
    const clamp = (v: number) => {
      let x = int ? Math.round(v) : v;
      if (min !== undefined) x = Math.max(min, x);
      if (max !== undefined) x = Math.min(max, x);
      return x;
    };
    return (
      <ExprField
        label={unit}
        unit={unit === '°' ? 'deg' : unit === 'adet' ? 'adet' : 'mm'}
        value={value}
        expr={draft.exprs?.[field]}
        step={step}
        mergeKey={k}
        errorKey={featureExprKey(draft.id, field)}
        onCommit={({ value: v, expr }) => {
          const exprs = { ...(draft.exprs ?? {}) };
          if (expr) exprs[field] = expr;
          else delete exprs[field];
          updateFeatureDraft({ [field]: clamp(v), exprs: Object.keys(exprs).length ? exprs : undefined } as Partial<Feature>);
        }}
      />
    );
  }
  return (
    <NumberField
      label={unit}
      value={value}
      step={step}
      mergeKey={k}
      onCommit={(v) => {
        let x = int ? Math.round(v) : v;
        if (min !== undefined) x = Math.max(min, x);
        if (max !== undefined) x = Math.min(max, x);
        onChange(x);
      }}
    />
  );
}

function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | null;
  options: { v: T; label: ReactNode; title?: string }[];
  onChange(v: T): void;
  label: string;
}) {
  return (
    <div className="seg fi-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={value === o.v ? 'active' : ''}
          aria-pressed={value === o.v}
          title={o.title}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange(v: boolean): void; title?: string }) {
  return (
    <label className="fi-check" title={title}>
      <input type="checkbox" className="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function PickBtn({ active, onClick, children, title }: { active: boolean; onClick(): void; children: ReactNode; title?: string }) {
  return (
    <button type="button" className={`btn btn-small btn-toggle ${active ? 'on' : ''}`} aria-pressed={active} title={title} onClick={onClick}>
      {active ? 'Seçiliyor…' : children}
    </button>
  );
}

function SketchSelect({ body, value, onChange }: { body: Body | undefined; value: string; onChange(id: string): void }) {
  const sketches = (body?.features ?? []).filter((f): f is SketchFeature => f.type === 'sketch');
  return (
    <select className="select-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {!sketches.some((s) => s.id === value) && <option value="">— sketch seçin —</option>}
      {sketches.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
          {s.suppressed ? ' (bastırılmış)' : ''}
        </option>
      ))}
    </select>
  );
}

function OpSeg({ value, onChange }: { value: 'add' | 'cut'; onChange(v: 'add' | 'cut'): void }) {
  return (
    <Seg
      label="İşlem"
      value={value}
      onChange={onChange}
      options={[
        { v: 'add', label: 'Ekle', title: 'Gövdeye malzeme ekle' },
        { v: 'cut', label: 'Kes', title: 'Gövdeden malzeme çıkar' },
      ]}
    />
  );
}

/** Extrude/Revolve profil seçimi */
function ProfileField({ d, body }: { d: ExtrudeFeature | RevolveFeature; body: Body | undefined }) {
  const mode = useModelingUi((s) => s.profileMode);
  const sk = body?.features.find((f): f is SketchFeature => f.id === d.sketchId && f.type === 'sketch');
  const regions = sk ? sketchRegions(sk) : [];
  const setMode = (m: 'all' | 'pick') => {
    useModelingUi.getState().set({ profileMode: m });
    if (m === 'all' && d.profilePoints.length) up({ profilePoints: [] });
  };
  return (
    <Field
      label="Profil"
      hint={
        !sk ? null : regions.length === 0 ? (
          <span className="fi-warn">Sketch'te kapalı bölge bulunamadı.</span>
        ) : mode === 'all' ? (
          `${regions.length} kapalı bölgenin tamamı (iç içe olanlar delik sayılır). Tek tek seçmek için sahnede bölgeye tıklayın.`
        ) : (
          `${d.profilePoints.length} / ${regions.length} bölge seçili — sahnede bölgelere tıklayarak ekleyin/çıkarın.`
        )
      }
    >
      <Seg
        label="Profil"
        value={mode}
        onChange={setMode}
        options={[
          { v: 'all', label: 'Tüm bölgeler', title: 'Tüm kapalı bölgeler' },
          { v: 'pick', label: 'Seçili', title: 'Sahnede tıklanan bölgeler' },
        ]}
      />
      {mode === 'pick' && d.profilePoints.length > 0 && (
        <button type="button" className="btn btn-small" title="Seçimi temizle" onClick={() => up({ profilePoints: [] })}>
          Temizle
        </button>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------- Extrude / Kesme

function ExtrudeForm({ d, body }: { d: ExtrudeFeature; body: Body | undefined }) {
  const k = `feat:${d.id}`;
  const cut = d.operation === 'cut';
  return (
    <section className="prop-section">
      <Field label="Sketch">
        <SketchSelect body={body} value={d.sketchId} onChange={(id) => up({ sketchId: id, profilePoints: [] })} />
      </Field>
      <ProfileField d={d} body={body} />
      <Field label="İşlem">
        <OpSeg value={d.operation} onChange={(v) => up(v === 'add' ? { operation: v, throughAll: false } : { operation: v })} />
      </Field>
      <Field label="Kapsam">
        <Seg
          label="Kapsam"
          value={d.extent}
          onChange={(v) => up({ extent: v })}
          options={[
            { v: 'oneSide', label: 'Tek yön', title: 'Düzlem normali yönünde' },
            { v: 'symmetric', label: 'Simetrik', title: 'İki yöne yarı yarıya' },
            { v: 'twoSides', label: 'İki yön', title: 'İki yöne ayrı mesafeler' },
          ]}
        />
      </Field>
      {cut && (
        <Field label="">
          <Check
            label="Tümünden geç"
            checked={d.throughAll}
            title="Mesafe yerine gövdenin tamamı boyunca kes"
            onChange={(v) => up({ throughAll: v })}
          />
        </Field>
      )}
      {!d.throughAll && (
        <Field label={d.extent === 'twoSides' ? 'Mesafe 1' : d.extent === 'symmetric' ? 'Toplam' : 'Mesafe'}>
          <Num field="distance" k={`${k}:d`} value={d.distance} min={0} onChange={(v) => up({ distance: v })} />
        </Field>
      )}
      {!d.throughAll && d.extent === 'twoSides' && (
        <Field label="Mesafe 2">
          <Num field="distance2" k={`${k}:d2`} value={d.distance2} min={0} onChange={(v) => up({ distance2: v })} />
        </Field>
      )}
      {d.extent !== 'symmetric' && (
        <Field label="">
          <Check label="Yönü çevir" checked={d.reverse} onChange={(v) => up({ reverse: v })} />
        </Field>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Revolve

function RevolveForm({ d, body }: { d: RevolveFeature; body: Body | undefined }) {
  const k = `feat:${d.id}`;
  const sk = body?.features.find((f): f is SketchFeature => f.id === d.sketchId && f.type === 'sketch');
  const lines = sk ? sketchLines(sk) : [];
  const pts = sk ? pointMap(sk) : new Map();
  const axisOk = lines.some((l) => l.id === d.axisLineId);

  // Eksen seçilmemişse ilk yardımcı çizgiyi öner
  useEffect(() => {
    if (axisOk || !lines.length) return;
    const c = lines.find((l) => l.construction);
    if (c) up({ axisLineId: c.id });
  }, [axisOk, lines]);

  const lineLabel = (id: string, i: number) => {
    const l = lines.find((x) => x.id === id)!;
    const a = pts.get(l.p1);
    const b = pts.get(l.p2);
    const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    let dir = '';
    if (a && b) {
      if (Math.abs(a.y - b.y) < 1e-6) dir = ' · yatay';
      else if (Math.abs(a.x - b.x) < 1e-6) dir = ' · dikey';
    }
    return `${l.construction ? 'Yardımcı çizgi' : 'Çizgi'} ${i + 1} · ${Number(len.toFixed(2))} mm${dir}`;
  };

  return (
    <section className="prop-section">
      <Field label="Sketch">
        <SketchSelect body={body} value={d.sketchId} onChange={(id) => up({ sketchId: id, profilePoints: [], axisLineId: '' })} />
      </Field>
      <ProfileField d={d} body={body} />
      <Field label="Eksen" hint={lines.length ? 'Seçili eksen sahnede turuncu kesikli çizgiyle gösterilir.' : <span className="fi-warn">Sketch'te çizgi yok: eksen için bir (yardımcı) çizgi çizin.</span>}>
        <select className="select-input" value={axisOk ? d.axisLineId : ''} onChange={(e) => up({ axisLineId: e.target.value })}>
          {!axisOk && <option value="">— eksen çizgisi seçin —</option>}
          {lines.map((l, i) => (
            <option key={l.id} value={l.id}>
              {lineLabel(l.id, i)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Açı">
        <Num field="angle" k={`${k}:a`} unit="°" step={15} value={d.angle} min={0.1} max={360} onChange={(v) => up({ angle: v })} />
      </Field>
      <Field label="">
        <Check label="Yönü çevir" checked={d.reverse} onChange={(v) => up({ reverse: v })} />
      </Field>
      <Field label="İşlem">
        <OpSeg value={d.operation} onChange={(v) => up({ operation: v })} />
      </Field>
    </section>
  );
}

// ---------------------------------------------------------------- Radyus / Pah

function EdgeFeatureForm({ d, bodyId }: { d: FilletFeature | ChamferFeature; bodyId: string }) {
  const k = `feat:${d.id}`;
  const pickKey = usePickKey();
  const active = pickKey === PICK_KEYS.edges;
  const prompt = d.type === 'fillet' ? 'Yuvarlatılacak kenarları seçin (tekrar tıklamak kaldırır)' : 'Pah kırılacak kenarları seçin (tekrar tıklamak kaldırır)';

  // Tıklanan kenarlar taslağa işlenir (aynı kenar ikinci kez → çıkarılır); picked kuyruk gibi boşaltılır
  usePicked(PICK_KEYS.edges, (picked) => {
    const cur = curDraft();
    if (!cur || (cur.type !== 'fillet' && cur.type !== 'chamfer')) return;
    const edges = [...cur.edges];
    for (const t of picked) {
      if (t.kind !== 'edge') continue;
      const i = edges.findIndex((e) => sameSig(e, t.sig));
      if (i >= 0) edges.splice(i, 1);
      else edges.push(t.sig);
    }
    up({ edges });
    st().setPicked([]);
  });

  return (
    <section className="prop-section">
      {d.type === 'fillet' ? (
        <Field label="Yarıçap">
          <Num field="radius" k={`${k}:r`} value={d.radius} step={0.5} min={0} onChange={(v) => up({ radius: v })} />
        </Field>
      ) : (
        <Field label="Mesafe">
          <Num field="distance" k={`${k}:d`} value={d.distance} step={0.5} min={0} onChange={(v) => up({ distance: v })} />
        </Field>
      )}
      <Field
        label="Kenarlar"
        hint={active ? 'Seçim sürerken önizleme gizlenir; özgün kenarlar gösterilir.' : 'Kenar eklemek/çıkarmak için “Kenar seç”e basın.'}
      >
        <PickBtn active={active} title="Sahnede kenarlara tıklayın" onClick={() => (active ? st().endPick() : startEdgePick(bodyId, prompt))}>
          Kenar seç
        </PickBtn>
        <span className="fi-count">{d.edges.length} kenar</span>
      </Field>
      {d.edges.length > 0 && (
        <ul className="fi-list">
          {d.edges.map((e, i) => (
            <li key={i}>
              <span className="fi-list-text">{edgeLabel(e)}</span>
              <button
                type="button"
                className="ft-btn danger"
                title="Kenarı listeden çıkar"
                aria-label="Kenarı çıkar"
                onClick={() => up({ edges: d.edges.filter((_, j) => j !== i) })}
              >
                <IconClose size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Delik

function HoleForm({ d, bodyId }: { d: HoleFeature; bodyId: string }) {
  const k = `feat:${d.id}`;
  const pickKey = usePickKey();
  const facePicking = pickKey === PICK_KEYS.holeFace;
  const { holePlace, holeFaceChosen } = useModelingUi(useShallow((s) => ({ holePlace: s.holePlace, holeFaceChosen: s.holeFaceChosen })));

  usePicked(PICK_KEYS.holeFace, (picked) => {
    const t = picked[0];
    st().endPick();
    if (t.kind !== 'face') return;
    const plane = planeFromFace(bodyId, t.ref);
    if (!plane) {
      st().showToast('Seçilen yüzey düz değil; düz bir yüzey seçin.', 'error');
      return;
    }
    up({ plane, points: [] });
    useModelingUi.getState().set({ holeFaceChosen: true, holePlace: true });
  });

  const setPoint = (i: number, axis: 0 | 1, v: number) => {
    const points = d.points.map((p, j) => (j === i ? ((axis === 0 ? [v, p[1]] : [p[0], v]) as Vec2) : p));
    up({ points });
  };

  return (
    <>
      <section className="prop-section">
        <Field
          label="Yüzey"
          hint={
            holeFaceChosen
              ? `Düzlem normali ${fmtVec(d.plane.normal)} · delik normalin tersine açılır.`
              : 'Önce deliğin açılacağı düz yüzeyi seçin.'
          }
        >
          <PickBtn
            active={facePicking}
            title="Sahnede gövdenin düz bir yüzeyine tıklayın"
            onClick={() =>
              togglePick(facePicking, {
                key: PICK_KEYS.holeFace,
                kinds: ['face'],
                filter: ['plane'],
                bodyId,
                multi: false,
                prompt: 'Deliğin açılacağı düz yüzeyi seçin',
              })
            }
          >
            {holeFaceChosen ? 'Yüzeyi değiştir' : 'Yüzey seç'}
          </PickBtn>
          {holeFaceChosen && <span className="fi-ok-tag">Seçildi</span>}
        </Field>
        <Field label="Merkezler" hint={holePlace ? 'Yüzeye tıklayarak delik merkezi ekleyin (snap açıksa ızgaraya oturur).' : undefined}>
          <button
            type="button"
            className={`btn btn-small btn-toggle ${holePlace ? 'on' : ''}`}
            disabled={!holeFaceChosen || facePicking}
            aria-pressed={holePlace}
            title="Sahnede yüzeye tıklayarak nokta ekle"
            onClick={() => useModelingUi.getState().set({ holePlace: !holePlace })}
          >
            {holePlace ? 'Ekleniyor…' : 'Tıklayarak ekle'}
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!holeFaceChosen}
            title="Yüzey merkezine nokta ekle"
            onClick={() => up({ points: [...d.points, [0, 0]] })}
          >
            + Nokta
          </button>
        </Field>
        {d.points.length > 0 && (
          <ul className="fi-list fi-points">
            {d.points.map((p, i) => (
              <li key={i}>
                <span className="fi-idx">{i + 1}</span>
                <div className="num-row fi-num-row">
                  <NumberField label="X" axis={0} value={p[0]} step={1} mergeKey={`${k}:p${i}x`} onCommit={(v) => setPoint(i, 0, v)} />
                  <NumberField label="Y" axis={1} value={p[1]} step={1} mergeKey={`${k}:p${i}y`} onCommit={(v) => setPoint(i, 1, v)} />
                </div>
                <button
                  type="button"
                  className="ft-btn danger"
                  title="Noktayı sil"
                  aria-label="Noktayı sil"
                  onClick={() => up({ points: d.points.filter((_, j) => j !== i) })}
                >
                  <IconClose size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="prop-section">
        <Field label="Tip">
          <Seg
            label="Delik tipi"
            value={d.holeType}
            onChange={(v) => up({ holeType: v })}
            options={[
              { v: 'simple', label: 'Basit' },
              { v: 'counterbore', label: 'Havşa başı', title: 'Silindirik havşa (counterbore)' },
              { v: 'countersink', label: 'Havşa', title: 'Konik havşa (countersink)' },
            ]}
          />
        </Field>
        <Field label="Çap">
          <Num field="diameter" k={`${k}:dia`} value={d.diameter} step={0.5} min={0} onChange={(v) => up({ diameter: v })} />
        </Field>
        <Field label="">
          <Check label="Tümünden geç" checked={d.throughAll} onChange={(v) => up({ throughAll: v })} />
        </Field>
        {!d.throughAll && (
          <Field label="Derinlik">
            <Num field="depth" k={`${k}:dep`} value={d.depth} min={0} onChange={(v) => up({ depth: v })} />
          </Field>
        )}
        {d.holeType === 'counterbore' && (
          <>
            <Field label="Havşa çapı">
              <Num field="cbDiameter" k={`${k}:cbd`} value={d.cbDiameter} step={0.5} min={0} onChange={(v) => up({ cbDiameter: v })} />
            </Field>
            <Field label="Havşa der.">
              <Num field="cbDepth" k={`${k}:cbh`} value={d.cbDepth} step={0.5} min={0} onChange={(v) => up({ cbDepth: v })} />
            </Field>
          </>
        )}
        {d.holeType === 'countersink' && (
          <>
            <Field label="Havşa çapı">
              <Num field="csDiameter" k={`${k}:csd`} value={d.csDiameter} step={0.5} min={0} onChange={(v) => up({ csDiameter: v })} />
            </Field>
            <Field label="Havşa açısı">
              <Num field="csAngle" k={`${k}:csa`} unit="°" value={d.csAngle} step={1} min={1} max={179} onChange={(v) => up({ csAngle: v })} />
            </Field>
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Desen / Ayna ortak

function FeatureChecklist({ body, draftId, value, onChange, emptyNote }: { body: Body | undefined; draftId: string; value: string[]; onChange(ids: string[]): void; emptyNote?: string }) {
  const list = patternSources(body, draftId);
  if (!list.length) return <div className="fi-hint fi-warn">Bu özellikten önce extrude/revolve/delik yok.</div>;
  return (
    <ul className="fi-list fi-checks">
      {list.map((f) => (
        <li key={f.id}>
          <label className={`fi-check ${f.suppressed ? 'dim' : ''}`}>
            <input
              type="checkbox"
              className="checkbox"
              checked={value.includes(f.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, f.id] : value.filter((x) => x !== f.id))}
            />
            <FIcon name={featureIconName(f as Feature & { operation?: string })} size={13} />
            {f.name}
          </label>
        </li>
      ))}
      {emptyNote && !value.length && <li className="fi-hint">{emptyNote}</li>}
    </ul>
  );
}

function DirField({
  label,
  dir,
  onChange,
  pickKey,
  bodyId,
}: {
  label: string;
  dir: Vec3;
  onChange(d: Vec3): void;
  pickKey: string;
  bodyId: string;
}) {
  const active = usePickKey() === pickKey;
  usePicked(pickKey, (picked) => {
    const t = picked[0];
    st().endPick();
    if (t.kind === 'edge' && t.sig.dir) onChange(t.sig.dir);
    else st().showToast('Düz bir kenar seçin.', 'error');
  });
  const name = axisName(dir);
  return (
    <Field label={label} hint={`Yön: ${name ?? fmtVec(dir)}`}>
      <Seg
        label={label}
        value={name && !name.startsWith('-') ? (name as 'X' | 'Y' | 'Z') : null}
        onChange={(v) => onChange(AXIS_DIRS[v])}
        options={(['X', 'Y', 'Z'] as const).map((a) => ({ v: a, label: a, title: `Gövde ${a} ekseni` }))}
      />
      <PickBtn
        active={active}
        title="Yönü gövdenin düz bir kenarından al"
        onClick={() => togglePick(active, { key: pickKey, kinds: ['edge'], filter: ['line'], bodyId, multi: false, prompt: 'Yön için düz bir kenar seçin' })}
      >
        Kenar
      </PickBtn>
      <button type="button" className="btn btn-small" title="Yönü çevir" onClick={() => onChange([-dir[0], -dir[1], -dir[2]])}>
        ⇄
      </button>
    </Field>
  );
}

// ---------------------------------------------------------------- Doğrusal desen

function LinearPatternForm({ d, body, bodyId }: { d: LinearPatternFeature; body: Body | undefined; bodyId: string }) {
  const k = `feat:${d.id}`;
  const two = d.count2 > 1;
  return (
    <>
      <section className="prop-section">
        <div className="prop-title">Çoğaltılacak özellikler</div>
        <FeatureChecklist body={body} draftId={d.id} value={d.featureIds} onChange={(ids) => up({ featureIds: ids })} />
      </section>
      <section className="prop-section">
        <div className="prop-title">Yön 1</div>
        <DirField label="Yön" dir={d.dir1} bodyId={bodyId} pickKey={PICK_KEYS.dir1} onChange={(v) => up({ dir1: v })} />
        <Field label="Adet">
          <Num field="count1" k={`${k}:c1`} unit="adet" value={d.count1} int min={1} max={500} onChange={(v) => up({ count1: v })} />
        </Field>
        <Field label="Aralık">
          <Num field="spacing1" k={`${k}:s1`} value={d.spacing1} onChange={(v) => up({ spacing1: v })} />
        </Field>
      </section>
      <section className="prop-section">
        <Check label="İkinci yön" checked={two} onChange={(v) => up({ count2: v ? Math.max(2, d.count2) : 1 })} />
        {two && (
          <>
            <DirField label="Yön" dir={d.dir2} bodyId={bodyId} pickKey={PICK_KEYS.dir2} onChange={(v) => up({ dir2: v })} />
            <Field label="Adet">
              <Num field="count2" k={`${k}:c2`} unit="adet" value={d.count2} int min={1} max={500} onChange={(v) => up({ count2: v })} />
            </Field>
            <Field label="Aralık">
              <Num field="spacing2" k={`${k}:s2`} value={d.spacing2} onChange={(v) => up({ spacing2: v })} />
            </Field>
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Dairesel desen

function CircularPatternForm({ d, body, bodyId }: { d: CircularPatternFeature; body: Body | undefined; bodyId: string }) {
  const k = `feat:${d.id}`;
  const active = usePickKey() === PICK_KEYS.cpAxis;
  usePicked(PICK_KEYS.cpAxis, (picked) => {
    const t = picked[0];
    st().endPick();
    if (t.kind === 'edge') {
      if (t.sig.kind === 'circle' && t.sig.center && t.sig.axis) up({ axisOrigin: t.sig.center, axisDir: t.sig.axis });
      else st().showToast('Dairesel bir kenar seçin.', 'error');
      return;
    }
    const g = worldFaceGeom(t.ref, st().doc);
    if (!g || g.kind !== 'cylinder') {
      st().showToast('Silindirik bir yüzey seçin.', 'error');
      return;
    }
    const loc = worldPlaneToBody(bodyId, { origin: g.point, xDir: g.axis, normal: g.axis });
    up({ axisOrigin: loc.origin, axisDir: loc.normal });
  });
  const name = axisName(d.axisDir);
  const atOrigin = d.axisOrigin.every((x) => Math.abs(x) < 1e-9);
  const setOrigin = (i: number, v: number) => {
    const o = [...d.axisOrigin] as Vec3;
    o[i] = v;
    up({ axisOrigin: o });
  };
  return (
    <>
      <section className="prop-section">
        <div className="prop-title">Çoğaltılacak özellikler</div>
        <FeatureChecklist body={body} draftId={d.id} value={d.featureIds} onChange={(ids) => up({ featureIds: ids })} />
      </section>
      <section className="prop-section">
        <Field label="Eksen" hint={`Yön ${name ?? fmtVec(d.axisDir)} · merkez ${fmtVec(d.axisOrigin)}`}>
          <Seg
            label="Eksen"
            value={atOrigin && name && !name.startsWith('-') ? (name as 'X' | 'Y' | 'Z') : null}
            onChange={(v) => up({ axisDir: AXIS_DIRS[v], axisOrigin: [0, 0, 0] })}
            options={(['X', 'Y', 'Z'] as const).map((a) => ({ v: a, label: a, title: `Gövde ${a} ekseni (orijinden)` }))}
          />
          <PickBtn
            active={active}
            title="Silindirik yüzey ya da dairesel kenar seçin"
            onClick={() =>
              togglePick(active, {
                key: PICK_KEYS.cpAxis,
                kinds: ['face', 'edge'],
                filter: ['cylinder', 'circle'],
                bodyId,
                multi: false,
                prompt: 'Eksen için silindirik bir yüzey ya da dairesel bir kenar seçin',
              })
            }
          >
            Seç
          </PickBtn>
          <button type="button" className="btn btn-small" title="Dönüş yönünü çevir" onClick={() => up({ axisDir: [-d.axisDir[0], -d.axisDir[1], -d.axisDir[2]] })}>
            ⇄
          </button>
        </Field>
        <div className="num-row">
          {(['X', 'Y', 'Z'] as const).map((a, i) => (
            <NumberField key={a} label={a} axis={i} value={d.axisOrigin[i]} step={1} mergeKey={`${k}:o${a}`} onCommit={(v) => setOrigin(i, v)} />
          ))}
        </div>
        <Field label="Adet">
          <Num field="count" k={`${k}:c`} unit="adet" value={d.count} int min={1} max={500} onChange={(v) => up({ count: v })} />
        </Field>
        <Field label="Toplam açı" hint={d.angle >= 360 ? 'Kopyalar çevreye eşit aralıkla dağılır.' : undefined}>
          <Num field="angle" k={`${k}:a`} unit="°" step={15} value={d.angle} min={0.1} max={360} onChange={(v) => up({ angle: v })} />
        </Field>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Ayna

function MirrorForm({ d, body, bodyId }: { d: MirrorFeature; body: Body | undefined; bodyId: string }) {
  const active = usePickKey() === PICK_KEYS.mirrorPlane;
  usePicked(PICK_KEYS.mirrorPlane, (picked) => {
    const t = picked[0];
    st().endPick();
    if (t.kind !== 'face') return;
    const plane = planeFromFace(bodyId, t.ref);
    if (!plane) st().showToast('Seçilen yüzey düz değil.', 'error');
    else up({ plane });
  });
  const base = basePlaneName(d.plane, BASE_PLANES) as keyof typeof BASE_PLANES | null;
  return (
    <>
      <section className="prop-section">
        <div className="prop-title">Aynalanacak özellikler</div>
        <FeatureChecklist
          body={body}
          draftId={d.id}
          value={d.featureIds}
          onChange={(ids) => up({ featureIds: ids })}
          emptyNote="Hiçbiri seçilmezse o ana kadarki tüm gövde aynalanır."
        />
      </section>
      <section className="prop-section">
        <Field label="Düzlem" hint={base ? `${base} düzlemi (gövde orijininden)` : `Yüzey düzlemi · normal ${fmtVec(d.plane.normal)}`}>
          <Seg
            label="Ayna düzlemi"
            value={base}
            onChange={(v) => up({ plane: BASE_PLANES[v] })}
            options={(['XY', 'XZ', 'YZ'] as const).map((p) => ({ v: p, label: p }))}
          />
          <PickBtn
            active={active}
            title="Ayna düzlemi olarak düz bir yüzey seçin"
            onClick={() =>
              togglePick(active, { key: PICK_KEYS.mirrorPlane, kinds: ['face'], filter: ['plane'], bodyId, multi: false, prompt: 'Ayna düzlemi için düz bir yüzey seçin' })
            }
          >
            Yüzey
          </PickBtn>
        </Field>
      </section>
    </>
  );
}
