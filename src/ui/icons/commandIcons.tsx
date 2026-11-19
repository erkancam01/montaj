// Komut çubuğu ve bağlam menüleri için kendi ikonlarımız (16×16 görünüm kutusu, currentColor).
import type { ReactNode } from 'react';

function Svg({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const PATHS = {
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  addFile: (
    <>
      <path d="M9 1.8H4.2a1 1 0 00-1 1v10.4a1 1 0 001 1h7.6a1 1 0 001-1V5.6z" />
      <path d="M9 1.8v3.8h3.8M8 7.5v4.5M5.8 9.8h4.4" />
    </>
  ),
  move: (
    <>
      <path d="M8 1.8v12.4M1.8 8h12.4" />
      <path d="M6.2 3.6L8 1.8l1.8 1.8M6.2 12.4L8 14.2l1.8-1.8M3.6 6.2L1.8 8l1.8 1.8M12.4 6.2L14.2 8l-1.8 1.8" />
    </>
  ),
  rotate: (
    <>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M11.8 1.8v2.8H9" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.8 1.6 2.6 3.6 2.6 5.8S9.8 12.2 8 13.8C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 2.2z" />
    </>
  ),
  axes: (
    <>
      <path d="M3 13V3M3 13h10M3 13l6-6" />
      <path d="M1.8 4.4L3 3l1.2 1.4M11.6 11.8L13 13l-1.4 1.2" />
    </>
  ),
  snap: (
    <>
      <path d="M4 2.5v5.5a4 4 0 008 0V2.5" />
      <path d="M4 2.5h2.4v5.5a1.6 1.6 0 003.2 0V2.5H12" />
      <path d="M4 5h2.4M9.6 5H12" />
    </>
  ),
  pickPart: (
    <>
      <path d="M3 5.5L8 3l5 2.5v5L8 13l-5-2.5z" />
      <path d="M3 5.5L8 8l5-2.5M8 8v5" />
    </>
  ),
  pickAssembly: (
    <>
      <rect x="1.8" y="7" width="5.5" height="5.5" rx="0.6" />
      <rect x="8.7" y="7" width="5.5" height="5.5" rx="0.6" />
      <rect x="5.2" y="1.8" width="5.5" height="4" rx="0.6" />
    </>
  ),
  fit: (
    <>
      <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
      <rect x="5" y="5" width="6" height="6" rx="0.6" />
    </>
  ),
  edges: (
    <>
      <path d="M3 5.5L8 3l5 2.5v5L8 13l-5-2.5z" strokeWidth={1.8} />
    </>
  ),
  camera: (
    <>
      <path d="M2 5.2h2.6l1.2-1.7h4.4l1.2 1.7H14v7.3H2z" />
      <circle cx="8" cy="8.8" r="2.3" />
    </>
  ),
  newPart: (
    <>
      <path d="M2.5 6L7 3.7 11.5 6v4.6L7 13 2.5 10.6z" />
      <path d="M12.5 1.5v4M10.5 3.5h4" />
    </>
  ),
  editPart: (
    <>
      <path d="M2.5 6L7 3.7 11.5 6v4.6L7 13 2.5 10.6z" />
      <path d="M9.5 14l4.6-4.6-1.4-1.4-4.6 4.6-.3 1.7z" />
    </>
  ),
  done: <path d="M3 8.5l3.2 3.2L13 4.8" strokeWidth={1.8} />,
  close: <path d="M4 4l8 8M12 4l-8 8" strokeWidth={1.8} />,
  exitSketch: (
    <>
      <rect x="2" y="4" width="8" height="8" strokeDasharray="1.6 1.4" />
      <path d="M8 8h6.5M12 5.5L14.5 8 12 10.5" />
    </>
  ),
  hide: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <path d="M2.5 13.5l11-11" />
    </>
  ),
  show: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  pin: (
    <>
      <path d="M6 2h4l-.6 4 2.6 2.4H4L6.6 6z" />
      <path d="M8 8.4V14" />
    </>
  ),
  unpin: (
    <>
      <path d="M6 2h4l-.6 4 2.6 2.4H4L6.6 6z" />
      <path d="M8 8.4V14M2.5 13.5l11-11" />
    </>
  ),
  focus: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" />
    </>
  ),
  copy: (
    <>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1" />
      <path d="M11 5V3.2a.7.7 0 00-.7-.7H3.2a.7.7 0 00-.7.7v7.1a.7.7 0 00.7.7H5" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />,
  rename: (
    <>
      <path d="M2 11.5h7M2 8h5" />
      <path d="M9.5 13.5l4.6-4.6-1.4-1.4-4.6 4.6-.3 1.7z" />
    </>
  ),
  plane: <path d="M1.8 11L5 4.5h9.2L11 11z" />,
  zip: (
    <>
      <path d="M3.5 1.8h6.2L12.5 4.6v9.6h-9z" />
      <path d="M7 3.5h1M7 5.5h1M7 7.5h1M6.5 9.5h2v2h-2z" />
    </>
  ),
  export: (
    <>
      <path d="M8 10V2.2M5 5.2l3-3 3 3" />
      <path d="M2.5 9.5v4h11v-4" />
    </>
  ),
  newDoc: (
    <>
      <path d="M9 1.8H4.2a1 1 0 00-1 1v10.4a1 1 0 001 1h7.6a1 1 0 001-1V5.6z" />
      <path d="M9 1.8v3.8h3.8" />
    </>
  ),
  measure: (
    <>
      <path d="M1.8 10.5L10.5 1.8l3.7 3.7-8.7 8.7z" />
      <path d="M5 7.3l1.3 1.3M7 5.3l1.6 1.6M9 3.3l1.3 1.3" />
    </>
  ),
  importDxf: (
    <>
      <path d="M2.2 13.8V6.5h3v-3h5.5v3h3v7.3z" />
      <path d="M5.2 6.5v4.3h5.5V6.5" />
      <path d="M8 1v4.2M6.4 3.6L8 5.2l1.6-1.6" />
    </>
  ),
  sweep: (
    <>
      <path d="M2.5 13.5c0-5 3-8 8-8h3" />
      <path d="M1.5 11.5h2.5v2.5H1.5z" />
      <path d="M12 3.5l1.8 2-1.8 2" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 4.8v.1" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type CmdIconName = keyof typeof PATHS;

export function CIcon({ name, size }: { name: CmdIconName; size?: number }) {
  return <Svg size={size}>{PATHS[name]}</Svg>;
}
