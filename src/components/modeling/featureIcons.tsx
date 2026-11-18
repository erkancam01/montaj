// Özellik türü ikonları (16×16, currentColor)
import type { ReactNode } from 'react';
import type { FeatureType } from '../../types';

function Svg({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const PATHS: Record<FeatureType | 'cut' | 'body' | 'pencil' | 'up' | 'down' | 'trash' | 'check', ReactNode> = {
  sketch: (
    <>
      <rect x="2.5" y="4.5" width="8" height="7" strokeDasharray="1.6 1.4" />
      <path d="M9 12.5l4.5-4.5-1.5-1.5L7.5 11l-.5 2z" />
    </>
  ),
  extrude: (
    <>
      <path d="M3 11l5 2.5 5-2.5M3 11V6l5-2.5L13 6v5M8 13.5V8.5M3 6l5 2.5L13 6" />
    </>
  ),
  cut: (
    <>
      <path d="M2.5 6.5l5.5-3 5.5 3v4l-5.5 3-5.5-3z" />
      <path d="M6 8.2l2-1.1 2 1.1v2.3l-2 1.1-2-1.1z" strokeDasharray="1.4 1" />
    </>
  ),
  revolve: (
    <>
      <path d="M8 1.5v13" strokeDasharray="1.6 1.4" />
      <ellipse cx="8" cy="5" rx="5" ry="1.6" />
      <path d="M3 5v6c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6V5" />
    </>
  ),
  fillet: (
    <>
      <path d="M2.5 13.5V8a5.5 5.5 0 0 1 5.5-5.5h5.5" />
      <path d="M2.5 2.5h3M2.5 2.5v3" strokeDasharray="1 1.2" />
    </>
  ),
  chamfer: (
    <>
      <path d="M2.5 13.5V7l4.5-4.5h6.5" />
      <path d="M2.5 2.5h4.5M2.5 2.5V7" strokeDasharray="1 1.2" />
    </>
  ),
  hole: (
    <>
      <ellipse cx="8" cy="4.5" rx="4" ry="1.6" />
      <path d="M4 4.5v7c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6v-7" strokeDasharray="1.6 1.2" />
    </>
  ),
  linearPattern: (
    <>
      <rect x="1.5" y="5.5" width="3.5" height="5" />
      <rect x="6.25" y="5.5" width="3.5" height="5" />
      <rect x="11" y="5.5" width="3.5" height="5" />
    </>
  ),
  circularPattern: (
    <>
      <circle cx="8" cy="8" r="1" />
      <circle cx="8" cy="3" r="1.6" />
      <circle cx="12.4" cy="10.5" r="1.6" />
      <circle cx="3.6" cy="10.5" r="1.6" />
    </>
  ),
  mirror: (
    <>
      <path d="M8 1.5v13" strokeDasharray="1.6 1.4" />
      <path d="M6 4L2 12h4zM10 4l4 8h-4z" />
    </>
  ),
  body: (
    <>
      <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" />
      <path d="M2.5 4.8L8 7.9l5.5-3.1M8 7.9v6.3" />
    </>
  ),
  pencil: <path d="M3 13l1-3.5L10.5 3 13 5.5 6.5 12zM9.3 4.2l2.5 2.5" />,
  up: <path d="M4 10l4-4 4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  check: <path d="M3 8.5l3 3 7-7" />,
};

export type IconName = keyof typeof PATHS;

export function FIcon({ name, size }: { name: IconName; size?: number }) {
  return <Svg size={size}>{PATHS[name]}</Svg>;
}

/** Özelliğin ikon adı (kesme extrude'u ayrı ikonla) */
export function featureIconName(f: { type: FeatureType; operation?: string }): IconName {
  if ((f.type === 'extrude' || f.type === 'revolve') && f.operation === 'cut') return f.type === 'extrude' ? 'cut' : 'revolve';
  return f.type;
}
