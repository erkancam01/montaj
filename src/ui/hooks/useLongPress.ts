// Dokunmatik uzun basma (~500 ms, < 8 px) = sağ tık.
// Uzun basma, hedef öğeye sentetik bir `contextmenu` olayı gönderir; böylece var olan onContextMenu
// işleyicileri (ağaç satırları, sahne sağ tık menüsü) hiç değişmeden çalışır. Ayrıca:
// - tarayıcının kendi (Android) uzun basma `contextmenu`'su bizim işaretli hedeflerimizde bastırılır
//   (menü iki kez açılmasın),
// - uzun basmadan sonra parmak kaldırılınca gelen `click` yutulur (seçim tıklaması tetiklenmesin),
// - tuvalde dokunmatik çift dokunmanın tarayıcı `dblclick`'i yutulur (çift dokunma = odakla).
import type { PointerEvent as ReactPointerEvent } from 'react';

export const LONG_PRESS_MS = 500;
/** Dokunmada tıklama / uzun basma için en büyük hareket (px) */
export const TAP_PX = 8;

let guardsOn = false;
/** Uzun basmanın tetiklendiği, henüz kalkmamış parmak */
let lpPointerId: number | null = null;
let lpUpAt = 0;
let lastTouchDownAt = 0;
let lastMouseDownAt = 0;

/** Uzun basma etkin (parmak hâlâ basılı) ya da az önce bitti */
export function longPressRecent(ms = 450): boolean {
  return lpPointerId !== null || performance.now() - lpUpAt < ms;
}

/** Son işaretçi basışı dokunma mıydı */
export function lastInputWasTouch(): boolean {
  return lastTouchDownAt > lastMouseDownAt;
}

/** Bu öğe tarayıcının uzun basma menüsünden korunuyor mu (tuval ya da data-longpress) */
function guarded(t: EventTarget | null): boolean {
  return t instanceof Element && (t.tagName === 'CANVAS' || t.closest('[data-longpress]') !== null);
}

function installGuards() {
  if (guardsOn || typeof window === 'undefined') return;
  guardsOn = true;
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') lastTouchDownAt = performance.now();
      else lastMouseDownAt = performance.now();
    },
    true,
  );
  const up = (e: PointerEvent) => {
    if (lpPointerId !== null && e.pointerId === lpPointerId) {
      lpPointerId = null;
      lpUpAt = performance.now();
    }
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && longPressRecent()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener(
    'contextmenu',
    (e) => {
      // Dokunmayla gelen tarayıcı menüsü: kendi uzun basmamız yerine geçmesin
      if (e.isTrusted && lastInputWasTouch() && performance.now() - lastTouchDownAt < 2000 && guarded(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener(
    'dblclick',
    (e) => {
      if (e.isTrusted && lastInputWasTouch() && e.target instanceof HTMLCanvasElement) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}

if (typeof window !== 'undefined') installGuards();

/** Uzun basmayı sağ tık olarak hedefe iletir */
export function fireLongPress(target: EventTarget, x: number, y: number, pointerId: number) {
  installGuards();
  lpPointerId = pointerId;
  target.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, buttons: 0, view: window }),
  );
}

/** Uzun basmanın ardından titreşim geri bildirimi (destekleniyorsa) */
export function hapticTick() {
  try {
    navigator.vibrate?.(15);
  } catch {
    /* yok say */
  }
}

// ---------------------------------------------------------------- DOM öğeleri için (ağaç satırları)

interface Press {
  id: number;
  x: number;
  y: number;
  target: Element;
  timer: number;
}

let press: Press | null = null;

function clearPress() {
  if (press) window.clearTimeout(press.timer);
  press = null;
  window.removeEventListener('pointermove', onPressMove, true);
  window.removeEventListener('pointerup', onPressEnd, true);
  window.removeEventListener('pointercancel', onPressEnd, true);
}

function onPressMove(e: PointerEvent) {
  if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_PX) clearPress();
}

function onPressEnd(e: PointerEvent) {
  if (press && e.pointerId === press.id) clearPress();
}

function onPressDown(e: ReactPointerEvent<Element>) {
  if (e.pointerType !== 'touch' || !e.isPrimary) return;
  clearPress();
  const target = e.currentTarget;
  const { clientX: x, clientY: y, pointerId: id } = e;
  press = {
    id,
    x,
    y,
    target,
    timer: window.setTimeout(() => {
      const p = press;
      clearPress();
      if (!p || !p.target.isConnected) return;
      hapticTick();
      fireLongPress(p.target, p.x, p.y, p.id);
    }, LONG_PRESS_MS),
  };
  window.addEventListener('pointermove', onPressMove, true);
  window.addEventListener('pointerup', onPressEnd, true);
  window.addEventListener('pointercancel', onPressEnd, true);
}

/** Öğeye yayılacak sabit özellikler: dokunmatik uzun basma o öğenin onContextMenu'sunu tetikler */
export const longPressProps = { onPointerDown: onPressDown, 'data-longpress': '' } as const;

/**
 * Hook biçimi: `<div {...useLongPress()} onContextMenu={…}>`. Durumsuzdur; sabit nesneyi döndürür.
 * (Satır bileşenlerinde doğrudan `{...longPressProps}` da kullanılabilir.)
 */
export function useLongPress() {
  return longPressProps;
}
