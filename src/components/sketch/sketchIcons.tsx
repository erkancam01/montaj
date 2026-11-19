// Sketch araç ve kısıt ikonları (16×16, currentColor)
import type { ReactNode } from 'react';
import type { SkConstraintType } from '../../modeling/types';
import type { SketchTool } from '../../sketch/session';

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

const dot = (x: number, y: number, r = 1.4) => <rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill="currentColor" stroke="none" />;

export function ToolIcon({ tool, size }: { tool: SketchTool; size?: number }) {
  switch (tool) {
    case 'select':
      return (
        <Svg size={size}>
          <path d="M4 2.5 L4 12.5 L6.6 10 L8.6 14 L10.2 13.2 L8.3 9.4 L11.8 9.2 Z" />
        </Svg>
      );
    case 'line':
      return (
        <Svg size={size}>
          <path d="M3 13 L13 3" />
          {dot(3, 13)}
          {dot(13, 3)}
        </Svg>
      );
    case 'rect':
      return (
        <Svg size={size}>
          <rect x="2.5" y="4" width="11" height="8" />
          {dot(2.5, 4)}
          {dot(13.5, 12)}
        </Svg>
      );
    case 'rectCenter':
      return (
        <Svg size={size}>
          <rect x="2.5" y="4" width="11" height="8" />
          <path d="M2.5 4 L13.5 12" strokeDasharray="1.6 1.6" strokeWidth={1} />
          {dot(8, 8)}
        </Svg>
      );
    case 'circle':
      return (
        <Svg size={size}>
          <circle cx="8" cy="8" r="5.5" />
          {dot(8, 8)}
        </Svg>
      );
    case 'arc':
      return (
        <Svg size={size}>
          <path d="M13 9.5 A5.5 5.5 0 0 0 3 9.5" />
          {dot(3, 9.5)}
          {dot(13, 9.5)}
          {dot(8, 9.5, 1)}
        </Svg>
      );
    case 'point':
      return (
        <Svg size={size}>
          <path d="M8 2.5 V5.5 M8 10.5 V13.5 M2.5 8 H5.5 M10.5 8 H13.5" strokeWidth={1} />
          {dot(8, 8, 1.8)}
        </Svg>
      );
    case 'dimension':
      return (
        <Svg size={size}>
          <path d="M2.5 4 V12 M13.5 4 V12 M2.5 8 H13.5" />
          <path d="M4.8 6.4 L2.8 8 L4.8 9.6 M11.2 6.4 L13.2 8 L11.2 9.6" strokeWidth={1.1} />
        </Svg>
      );
    case 'project':
      return (
        <Svg size={size}>
          <path d="M3 3.5 L11 3.5 L13 6 L5 6 Z" strokeWidth={1.1} />
          <path d="M8 7 V10.5" strokeDasharray="1.4 1.4" strokeWidth={1} />
          <path d="M6.6 9.4 L8 10.8 L9.4 9.4" strokeWidth={1} />
          <rect x="3" y="11.5" width="10" height="2.5" />
        </Svg>
      );
  }
}

export const IconConstruction = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2.5 13.5 L13.5 2.5" strokeDasharray="2 2" />
    <circle cx="8" cy="8" r="2.5" strokeDasharray="1.5 1.5" strokeWidth={1} />
  </Svg>
);

export const IconCheck = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 8.5 L6.5 12 L13 4.5" strokeWidth={1.8} />
  </Svg>
);

export const IconTrash = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 4.5 H13 M6.5 4.5 V3 H9.5 V4.5 M4.5 4.5 L5.2 13.5 H10.8 L11.5 4.5" />
  </Svg>
);

export const IconSketch = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2.5 12 L7 3.5 L11 9 L13.5 6" />
    <path d="M2 14 H14" strokeWidth={1} />
  </Svg>
);

/** Kısıt ikonları (rozetler, listeler, ilişki düğmeleri) */
export function ConstraintIcon({ type, size = 12 }: { type: SkConstraintType; size?: number }) {
  switch (type) {
    case 'horizontal':
      return (
        <Svg size={size}>
          <path d="M2 8 H14" strokeWidth={2} />
        </Svg>
      );
    case 'vertical':
      return (
        <Svg size={size}>
          <path d="M8 2 V14" strokeWidth={2} />
        </Svg>
      );
    case 'parallel':
      return (
        <Svg size={size}>
          <path d="M5 14 L9 2 M8 14 L12 2" strokeWidth={1.7} />
        </Svg>
      );
    case 'perpendicular':
      return (
        <Svg size={size}>
          <path d="M8 3 V13 M2.5 13 H13.5" strokeWidth={1.7} />
        </Svg>
      );
    case 'equal':
      return (
        <Svg size={size}>
          <path d="M3 6 H13 M3 10.5 H13" strokeWidth={1.8} />
        </Svg>
      );
    case 'tangent':
      return (
        <Svg size={size}>
          <circle cx="8" cy="9" r="4" />
          <path d="M1.5 5 H14.5" strokeWidth={1.6} />
        </Svg>
      );
    case 'fix':
      return (
        <Svg size={size}>
          <path d="M8 2.5 V10 M4 10 H12 M5 13.5 L6.5 10 M8 13.5 L9.5 10 M11 13.5 L12 11" strokeWidth={1.5} />
        </Svg>
      );
    case 'coincident':
      return (
        <Svg size={size}>
          <circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="5.8" strokeWidth={1.2} />
        </Svg>
      );
    case 'pointOnLine':
      return (
        <Svg size={size}>
          <path d="M2 12 L14 4" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'pointOnCircle':
      return (
        <Svg size={size}>
          <circle cx="8" cy="8" r="5" />
          <circle cx="11.5" cy="4.5" r="2.2" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'midpoint':
      return (
        <Svg size={size}>
          <path d="M2 8 H14 M2 5.5 V10.5 M14 5.5 V10.5" />
          <path d="M8 5.2 L10.6 8 L8 10.8 L5.4 8 Z" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'concentric':
      return (
        <Svg size={size}>
          <circle cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="3" />
        </Svg>
      );
    case 'distance':
    case 'distanceX':
    case 'distanceY':
      return (
        <Svg size={size}>
          <path d={type === 'distanceY' ? 'M4 2.5 H12 M4 13.5 H12 M8 2.5 V13.5' : 'M2.5 4 V12 M13.5 4 V12 M2.5 8 H13.5'} />
        </Svg>
      );
    case 'radius':
      return (
        <Svg size={size}>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 8 L12.2 3.8" />
        </Svg>
      );
    case 'diameter':
      return (
        <Svg size={size}>
          <circle cx="8" cy="8" r="6" />
          <path d="M3.8 12.2 L12.2 3.8" />
        </Svg>
      );
    case 'angle':
      return (
        <Svg size={size}>
          <path d="M2.5 13.5 H13.5 M2.5 13.5 L11 3.5" />
          <path d="M8.5 13.5 A6 6 0 0 0 6.6 9" />
        </Svg>
      );
  }
}
