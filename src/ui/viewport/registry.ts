// Instance/Part id → sahnedeki Three.js grup nesnesi.
// Viewport bileşenleri ref callback ile doldurur; Gizmo, sığdırma ve "zemine oturt" kullanır.
import type { Object3D } from 'three';

export const objectRegistry = new Map<string, Object3D>();
