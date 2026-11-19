// Komut çubuğu, bağlam kutusu, sağ tık ve S menüsünün ortak eylemleri. Son komut kaydı (Enter tekrarlar),
// sketch oturumunda Çizim sekmesine geçiş ve sketch bitince Extrude önerisi de buradadır.
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
import { useCommandUi, type LastCommand } from '@/ui/commands/commandStore';

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

/** Özellik aracını başlatır: varsayılan taslakla özellik oturumu açar (gerekirse gövdeyi düzenlemeye alır) */
export function startTool(bodyId: string, tool: FeatureTool, sketchId?: string) {
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
  if (sketchId && (d.type === 'extrude' || d.type === 'revolve')) startFeature(bodyId, { ...d, sketchId });
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
    hasSolid: fs.some((f) => (f.type === 'extrude' || f.type === 'revolve') && f.operation === 'add'),
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

// ---------------------------------------------------------------- Yeni parça / sketch

/** Çizime başlanmadan vazgeçilirse silinecek yeni gövde */
let freshBody: string | null = null;

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

/** Sekme geçişleri, Extrude önerisi ve boş kalan yeni parçanın silinmesi */
export function startCommandWatchers() {
  if (watching) return;
  watching = true;
  useAssembly.subscribe((s, prev) => {
    const ui = useCommandUi.getState();
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
        const used = body.features.some((x) => (x.type === 'extrude' || x.type === 'revolve') && x.sketchId === f.id);
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
    if (s.ui.tool === 'mate' && prev.ui.tool !== 'mate' && ui.tab !== 'assembly') ui.set({ tab: 'assembly' });
  });
}
