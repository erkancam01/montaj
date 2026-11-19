// Komut çubuğu, bağlam kutusu, sağ tık ve S menüsünün ortak eylemleri. Son komut kaydı (Enter tekrarlar),
// sketch oturumunda Çizim sekmesine geçiş ve sketch bitince Extrude önerisi de buradadır.
import { addsSolid, isProfileFeature } from '@/core/features/registry';
import { worldFaceGeom } from '@/core/geometry/faceGeometry';
import {
  BASE_PLANES,
  bodyIdOfPart,
  createBody,
  discardIfEmpty,
  enterBody,
  getBody,
  newFeatureDraft,
  startFeature,
  startSketch,
  startSketchOnFace,
  cancelFeature,
} from '@/state/modelingActions';
import { withFaceSig } from '@/services/bodyManager';
import { pickFace } from '@/state/assemblyActions';
import { useAssembly, type AssemblyState } from '@/state/useAssembly';
import type { FaceRef } from '@/core/types';
import { bodyIdOfFile, isBodyFileId } from '@/core/types';
import { sketchRegions } from '@/ui/modeling/geom';
import { pointerState, useCommandUi, type BasePlaneKey, type LastCommand } from '@/ui/commands/commandStore';
import { redoSketch, undoSketch } from '@/state/sketchSession';
import { resetDraw } from '@/ui/sketch/tools';
import { orientIso } from '@/ui/viewport/viewCommands';

const st = () => useAssembly.getState();

export type { FeatureTool } from '@/core/features/registry';
import type { FeatureTool } from '@/core/features/registry';

// ---------------------------------------------------------------- Son komut

/** Komutu çalıştırır ve Enter ile tekrarlanabilsin diye kaydeder */
export function runCommand(id: string, label: string, run: () => void) {
  useCommandUi.getState().set({ last: { id, label, run } as LastCommand });
  useCommandUi.getState().closePopups();
  run();
}

export function repeatLast(): boolean {
  const last = useCommandUi.getState().last;
  if (!last) return false;
  st().showToast(`Tekrar: ${last.label}`);
  last.run();
  return true;
}

// ---------------------------------------------------------------- Gövde / özellik

/** Sahnede seçili öğenin gövdesi (instance ya da parça) */
export function selectedBodyId(s: AssemblyState): string | null {
  const sel = s.selection;
  if (!sel) return null;
  if (sel.kind === 'instance') {
    const inst = s.doc.instances.find((i) => i.id === sel.id);
    return inst && isBodyFileId(inst.fileId) ? bodyIdOfFile(inst.fileId) : null;
  }
  if (sel.kind === 'part') return bodyIdOfPart(sel.id);
  return null;
}

/** Komutun uygulanacağı gövde: düzenlenen gövde, yoksa seçili gövde */
export function targetBodyId(s: AssemblyState = st()): string | null {
  return s.modeling.activeBodyId ?? selectedBodyId(s);
}

function nextName(base: string, existing: string[]): string {
  let n = 1;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Profil unsurunun kullanacağı sketch (önce seç, sonra komut): ağaçta seçili sketch, yoksa az önce kapanan
 * sketch, yoksa henüz hiçbir unsurun kullanmadığı en son sketch; hiçbiri yoksa null (varsayılan: son sketch).
 */
export function preferredSketch(bodyId: string): string | null {
  const ui = useCommandUi.getState();
  const body = getBody(bodyId);
  if (!body) return null;
  const live = (id: string | undefined) => !!id && body.features.some((f) => f.id === id && f.type === 'sketch' && !f.suppressed);
  if (ui.sketchSel?.bodyId === bodyId && live(ui.sketchSel.featureId)) return ui.sketchSel.featureId;
  if (ui.suggestion?.bodyId === bodyId && live(ui.suggestion.sketchId)) return ui.suggestion.sketchId;
  const used = new Set<string>();
  for (const f of body.features) {
    if (!isProfileFeature(f)) continue;
    used.add(f.sketchId);
    if (f.type === 'sweep') used.add(f.pathSketchId);
  }
  for (let i = body.features.length - 1; i >= 0; i--) {
    const f = body.features[i];
    if (f.type === 'sketch' && !f.suppressed && !used.has(f.id)) return f.id;
  }
  return null;
}

/** Özellik aracını başlatır: varsayılan taslakla özellik oturumu açar (gerekirse gövdeyi düzenlemeye alır) */
export function startTool(bodyId: string, tool: FeatureTool, sketchId?: string) {
  sketchId ??= preferredSketch(bodyId) ?? undefined;
  if (st().modeling.activeBodyId !== bodyId) enterBody(bodyId);
  useCommandUi.getState().set({ suggestion: null });
  if (tool === 'cut') {
    const d = newFeatureDraft(bodyId, 'extrude');
    if (d.type !== 'extrude') return;
    const names = getBody(bodyId)?.features.map((f) => f.name) ?? [];
    startFeature(bodyId, { ...d, ...(sketchId ? { sketchId } : {}), operation: 'cut', name: nextName('Kesme', names) });
    return;
  }
  const d = newFeatureDraft(bodyId, tool);
  if (sketchId && isProfileFeature(d)) startFeature(bodyId, { ...d, sketchId });
  else startFeature(bodyId, d);
}

export interface BodyCaps {
  hasSketch: boolean;
  hasSolid: boolean;
}

export function bodyCaps(s: AssemblyState, bodyId: string | null): BodyCaps {
  const b = bodyId ? s.doc.bodies.find((x) => x.id === bodyId) : undefined;
  const fs = (b?.features ?? []).filter((f) => !f.suppressed);
  return {
    hasSketch: fs.some((f) => f.type === 'sketch'),
    hasSolid: fs.some((f) => addsSolid(f)),
  };
}

/** Aracın neden kullanılamadığı (kullanılabiliyorsa null) */
export function toolBlocker(s: AssemblyState, needs: 'sketch' | 'solid' | 'sketch+solid'): string | null {
  if (s.modeling.sketch) return 'Sketch oturumu açıkken kullanılamaz';
  if (s.modeling.feature) return 'Önce açık özelliği uygulayın ya da iptal edin';
  const bodyId = targetBodyId(s);
  if (!bodyId) return 'Önce bir parça seçin ya da Yeni parça oluşturun';
  const caps = bodyCaps(s, bodyId);
  if (needs.includes('sketch') && !caps.hasSketch) return 'Parçada sketch yok: önce bir sketch çizin';
  if (needs.includes('solid') && !caps.hasSolid) return 'Parçada katı yok: önce Extrude ya da Revolve ile katı oluşturun';
  return null;
}

// ---------------------------------------------------------------- Geri al / yinele (sketch'te sketch geçmişi)

export function undoAny() {
  if (st().modeling.sketch) {
    resetDraw();
    undoSketch();
  } else st().undo();
}

export function redoAny() {
  if (st().modeling.sketch) {
    resetDraw();
    redoSketch();
  } else st().redo();
}

// ---------------------------------------------------------------- Yeni parça / sketch

/** Çizime başlanmadan vazgeçilirse silinecek yeni gövde */
let freshBody: string | null = null;
/** "Yeni parça" ile açılmış, henüz unsuru olmayan gövdeler: parça kipinden çıkınca boşsa silinir */
const emptyNew = new Set<string>();

/** Açık komutları kapatır (sketch açıksa false: önce sketch bitmeli) */
function closeCommands(): boolean {
  const s = st();
  if (s.modeling.sketch) {
    s.showToast("Önce sketch'ten çıkın (✓) ya da iptal edin", 'error');
    return false;
  }
  if (s.modeling.feature) cancelFeature();
  if (s.modeling.pick) s.endPick();
  if (s.ui.tool === 'mate') s.setUi({ tool: 'select' });
  return true;
}

/**
 * Yeni boş parça: parça kipine girer, sketch açmaz (SolidWorks'te yeni parça belgesi gibi). Kullanıcı ağaçta bir
 * düzlem seçip Sketch'e basar. Hiç unsur eklenmeden montaja dönülürse parça silinir.
 */
export function newPart() {
  if (!closeCommands()) return;
  const id = createBody();
  emptyNew.add(id);
  enterBody(id);
  useCommandUi.getState().set({ plane: null, face: null, sketchSel: null, tab: 'features' });
  st().showToast('Yeni parça: ağaçta bir düzlem seçip Sketch’e basın.');
}

export const SKETCH_PLANE_KEY = 'sketch-plane';

/** Sketch düzlemi bekleme kipi: üç temel düzlem sahnede gösterilir, düz yüzeyler de seçilebilir */
export function beginPlanePick() {
  const s = st();
  useCommandUi.getState().set({ planePick: true, contextBox: null });
  s.startPick({
    key: SKETCH_PLANE_KEY,
    kinds: ['face'],
    filter: ['plane'],
    multi: false,
    prompt: 'Sketch için bir düzlem (Ön / Üst / Sağ) ya da düz bir yüzey seçin · Esc vazgeç',
  });
}

/** Düzlem bekleme kipinde temel düzleme tıklandı */
export function pickBasePlane(k: BasePlaneKey) {
  const ui = useCommandUi.getState();
  if (ui.planePick) {
    ui.set({ planePick: false });
    if (st().modeling.pick?.key === SKETCH_PLANE_KEY) st().endPick();
    runCommand(`sketch-${k}`, 'Sketch', () => sketchOnPlane(k));
    return;
  }
  ui.set({ plane: ui.plane === k ? null : k, face: null, sketchSel: null });
}

/**
 * Sketch komutu (önce seç, sonra komut): seçili temel düzlemde ya da son tıklanan düz yüzeyde açılır;
 * seçim yoksa düzlem bekleme kipine geçer.
 */
export function sketchCommand() {
  const s = st();
  if (s.modeling.sketch) return;
  if (s.modeling.feature) {
    s.showToast('Önce açık özelliği uygulayın ya da iptal edin', 'error');
    return;
  }
  const ui = useCommandUi.getState();
  if (ui.plane) {
    const k = ui.plane;
    ui.set({ plane: null });
    sketchOnPlane(k);
    return;
  }
  if (ui.face && s.doc.parts.some((p) => p.id === ui.face!.partId) && isPlanarFace(ui.face)) {
    const f = ui.face;
    ui.set({ face: null });
    sketchOnFace(f);
    return;
  }
  if (s.ui.tool === 'mate') s.setUi({ tool: 'select' });
  beginPlanePick();
}

/** Yeni parça + temel düzlemde sketch */
export function newPartOnPlane(k: keyof typeof BASE_PLANES) {
  if (st().modeling.sketch) return;
  if (st().modeling.feature) cancelFeature();
  const id = createBody();
  freshBody = id;
  startSketch(id, BASE_PLANES[k]);
}

/** Düzenlenen (ya da seçili) gövdede temel düzlemde sketch; gövde yoksa yeni parça */
export function sketchOnPlane(k: keyof typeof BASE_PLANES) {
  const s = st();
  if (s.modeling.sketch) return;
  const bodyId = targetBodyId(s);
  if (!bodyId) {
    newPartOnPlane(k);
    return;
  }
  if (s.modeling.feature) cancelFeature();
  if (s.modeling.activeBodyId !== bodyId) enterBody(bodyId);
  startSketch(bodyId, BASE_PLANES[k]);
}

export function isPlanarFace(ref: FaceRef): boolean {
  try {
    return worldFaceGeom(ref, st().doc)?.kind === 'plane';
  } catch {
    return false;
  }
}

/**
 * Tıklanan yüzeyde yeni sketch. Düzenlenen gövde varsa sketch ona eklenir (başka parçanın yüzüyse bağlanır);
 * yoksa yüzey bir gövdeye aitse o gövde düzenlemeye alınır; içe aktarılmış parçaysa yeni parça oluşturulur.
 */
export function sketchOnFace(ref: FaceRef, opts: { newPart?: boolean } = {}) {
  const s = st();
  if (s.modeling.sketch) return;
  if (!isPlanarFace(ref)) {
    s.showToast('Seçilen yüzey düz değil; sketch için düz bir yüzey seçin.', 'error');
    return;
  }
  if (s.modeling.feature) cancelFeature();
  if (s.modeling.pick) s.endPick();
  if (s.ui.tool === 'mate') s.setUi({ tool: 'select' });
  const faceRef = withFaceSig(ref);
  let bodyId = opts.newPart ? null : s.modeling.activeBodyId;
  let fresh = false;
  if (!bodyId) {
    const own = opts.newPart ? null : bodyIdOfPart(ref.partId);
    if (own) {
      enterBody(own);
      bodyId = own;
    } else {
      bodyId = createBody();
      fresh = true;
    }
  }
  const ok = startSketchOnFace(bodyId, faceRef);
  if (fresh) {
    if (ok) freshBody = bodyId;
    else discardIfEmpty(bodyId);
  }
}

/** Mate aracını bu yüzey referans (1. yüzey) seçili olarak açar */
export function mateFromFace(ref: FaceRef) {
  const s = st();
  if (s.modeling.sketch || s.modeling.feature) return;
  s.setUi({ tool: 'mate' });
  st().setPendingFace(null);
  pickFace(ref);
}

export function toggleMateTool() {
  const s = st();
  if (s.modeling.sketch) return;
  s.setUi({ tool: s.ui.tool === 'mate' ? 'select' : 'mate' });
}

// ---------------------------------------------------------------- Mate oturumu (sol panel ✓ / ✕)

/** Mate aracı açıldığında var olan mate'ler: ✕ bu oturumda eklenenleri geri alır */
let mateSessionBase: Set<string> | null = null;

export function mateSessionAdded(): string[] {
  if (!mateSessionBase) return [];
  const base = mateSessionBase;
  return st()
    .doc.mates.filter((m) => !base.has(m.id))
    .map((m) => m.id);
}

/** ✓: mate aracını kapatır, kurulan mate'ler kalır */
export function acceptMateSession() {
  const s = st();
  s.setPendingFace(null);
  s.setUi({ tool: 'select' });
  s.selectMate(null);
}

/** ✕: bu oturumda kurulan mate'leri kaldırır ve aracı kapatır */
export function cancelMateSession() {
  const added = new Set(mateSessionAdded());
  const s = st();
  s.setPendingFace(null);
  if (added.size) {
    s.commit((d) => ({ ...d, mates: d.mates.filter((m) => !added.has(m.id)) }));
    s.showToast(`${added.size} mate geri alındı.`);
  }
  s.setUi({ tool: 'select' });
  s.selectMate(null);
}

// ---------------------------------------------------------------- Durum izleyicileri

let watching = false;
/** Az önce bir sketch kapandı (görünüm hâlâ sketch düzlemine dik olabilir) */
let justSketched = false;

/** Sekme geçişleri, Extrude önerisi ve boş kalan yeni parçanın silinmesi */
export function startCommandWatchers() {
  if (watching) return;
  watching = true;
  useAssembly.subscribe((s, prev) => {
    const ui = useCommandUi.getState();
    // Sketch düzlemi için yüzey seçildi
    const pk = s.modeling.pick;
    if (pk?.key === SKETCH_PLANE_KEY && pk.picked.length && pk !== prev.modeling.pick) {
      const t = pk.picked[0];
      queueMicrotask(() => {
        useAssembly.getState().endPick();
        ui.set({ planePick: false });
        if (t.kind === 'face') sketchOnFace(t.ref);
      });
    }
    if (ui.planePick && pk?.key !== SKETCH_PLANE_KEY && prev.modeling.pick?.key === SKETCH_PLANE_KEY) ui.set({ planePick: false });
    // Mate aracı: yeni kurulan mate için imleç yanında tür kutusu; araç kapanınca / yeni seçim başlayınca kapanır
    if (s.ui.tool === 'mate' && s.doc.mates !== prev.doc.mates && s.doc.mates.length > prev.doc.mates.length) {
      const old = new Set(prev.doc.mates.map((m) => m.id));
      const added = s.doc.mates.find((m) => !old.has(m.id));
      if (added) ui.set({ matePopup: { mateId: added.id, x: pointerState.x, y: pointerState.y } });
    }
    if (ui.matePopup) {
      const gone = !s.doc.mates.some((m) => m.id === ui.matePopup!.mateId);
      if (s.ui.tool !== 'mate' || gone || (s.pendingFace && !prev.pendingFace)) ui.set({ matePopup: null });
    }
    // Kip değişti: parça kipinde Unsurlar, montajda Montaj sekmesi
    if (!!s.modeling.activeBodyId !== !!prev.modeling.activeBodyId && !s.modeling.sketch) {
      ui.set({ tab: s.modeling.activeBodyId ? 'features' : 'assembly' });
    }
    // Parça kipinden çıkıldı: "Yeni parça" ile açılıp boş kalan gövde silinir
    const pa = prev.modeling.activeBodyId;
    if (pa && pa !== s.modeling.activeBodyId) {
      if (emptyNew.has(pa)) {
        emptyNew.delete(pa);
        queueMicrotask(() => discardIfEmpty(pa));
      }
      if (ui.plane || ui.sketchSel) ui.set({ plane: null, sketchSel: null });
    }
    if (s.modeling.activeBodyId && emptyNew.has(s.modeling.activeBodyId)) {
      const b = s.doc.bodies.find((x) => x.id === s.modeling.activeBodyId);
      if (b?.features.length) emptyNew.delete(b.id);
    }
    // Mate oturumu başlangıcı
    if (s.ui.tool === 'mate' && prev.ui.tool !== 'mate') mateSessionBase = new Set(s.doc.mates.map((m) => m.id));
    if (s.ui.tool !== 'mate' && prev.ui.tool === 'mate') mateSessionBase = null;

    const sk = s.modeling.sketch;
    const psk = prev.modeling.sketch;
    if (sk && !psk) {
      ui.set({ tab: 'sketch', suggestion: null });
      ui.closePopups();
    }
    if (!sk && psk) {
      justSketched = true;
      // Sketch kapandı: bitti mi, iptal mi?
      const body = s.doc.bodies.find((b) => b.id === psk.bodyId);
      const f = body?.features.find((x) => x.id === psk.featureId);
      if (ui.tab === 'sketch') ui.set({ tab: 'features' });
      if (freshBody) {
        const id = freshBody;
        freshBody = null;
        if (!f) queueMicrotask(() => discardIfEmpty(id));
      }
      if (f && f.type === 'sketch' && body) {
        const used = body.features.some((x) => isProfileFeature(x) && (x.sketchId === f.id || (x.type === 'sweep' && x.pathSketchId === f.id)));
        let closed = false;
        try {
          closed = sketchRegions(f).length > 0;
        } catch {
          closed = false;
        }
        if (!used && closed) {
          const caps = bodyCaps(s, body.id);
          ui.set({ suggestion: { bodyId: body.id, sketchId: f.id, sketchName: f.name, hasSolid: caps.hasSolid } });
        }
      }
    }
    // Özellik açıldı ya da gövde düzenlemesi bitti → öneri düşer
    if (ui.suggestion && (s.modeling.feature || s.modeling.sketch || !s.modeling.activeBodyId)) ui.set({ suggestion: null });
    if (s.modeling.feature && !prev.modeling.feature && ui.tab !== 'features') ui.set({ tab: 'features' });
    // Yeni profil unsuru (Ekstrüzyon / Kesme / Döndürme / Süpür): sketch'e dik bakılıyorsa önizleme için
    // izometriğe dön (hedef ve uzaklık korunur)
    if (s.modeling.feature?.isNew && !prev.modeling.feature && isProfileFeature(s.modeling.feature.draft) && justSketched) {
      justSketched = false;
      orientIso();
    }
    if (s.modeling.feature && !prev.modeling.feature) justSketched = false;
    if (s.ui.tool === 'mate' && prev.ui.tool !== 'mate' && ui.tab !== 'assembly') ui.set({ tab: 'assembly' });
  });
}
