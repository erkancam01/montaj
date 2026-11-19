// Dokunmatik girdi durumu (React dışı + küçük zustand deposu).
// mode: 'camera' → tek parmak kamerayı döndürür; 'move' / 'rotate' → parçaya dokunup sürüklemek
// DragController'ın sol-sürükle taşı / sağ-sürükle döndür davranışını verir.
import { create } from 'zustand';

export type TouchMode = 'camera' | 'move' | 'rotate';

export const useTouchMode = create<{ mode: TouchMode }>(() => ({ mode: 'camera' }));

export function touchMode(): TouchMode {
  return useTouchMode.getState().mode;
}

export function setTouchMode(mode: TouchMode) {
  useTouchMode.setState({ mode });
}

let multiActive = false;
let multiEndedAt = 0;

/** CadControls: iki parmaklı hareket başladı / tüm parmaklar kalktı */
export function markMultiTouch(on: boolean) {
  if (on) multiActive = true;
  else if (multiActive) {
    multiActive = false;
    multiEndedAt = performance.now();
  }
}

/** Şu anki (ya da az önce biten) dokunma iki parmaklı mıydı: tıklama sayılmamalı */
export function multiTouchRecent(ms = 350): boolean {
  return multiActive || performance.now() - multiEndedAt < ms;
}

/** Dokunmatik cihaz mı (kaba işaretçi ya da dokunma noktası) */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  } catch {
    /* yok say */
  }
  return (navigator.maxTouchPoints ?? 0) > 0;
}
