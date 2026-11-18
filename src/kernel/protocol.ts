// Ana iş parçacığı ↔ çekirdek worker'ı mesajları
import type { Body } from '../types';
import type { BodyBuildResult, ExportItem } from './kernelApi';

export type KernelRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'build'; body: Body }
  | { id: number; type: 'export'; items: ExportItem[]; blobs: Record<string, Blob> };

export type KernelResult = null | BodyBuildResult | { blob: Blob; warnings: string[] };

export type KernelResponse =
  | { id: number; ok: true; result: KernelResult }
  /** fatal: çekirdek bozuldu (wasm abort vb.), worker yeniden kurulmalı */
  | { id: number; ok: false; error: string; fatal?: boolean };
