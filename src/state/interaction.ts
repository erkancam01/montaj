// Anlık etkileşim bayrakları (React dışı). Arayüz yazar; servisler ve arayüz okur.

let gizmoDragging = false;
let lastGizmoUp = 0;

export function markGizmoDown() {
  gizmoDragging = true;
}

export function markGizmoUp() {
  gizmoDragging = false;
  lastGizmoUp = performance.now();
}

/** Gizmo ile etkileşim sürüyor ya da az önce bitti: sahne tıklamaları seçim değiştirmesin */
export function gizmoBusy(): boolean {
  return gizmoDragging || performance.now() - lastGizmoUp < 250;
}
