// Küçük satır içi SVG ikonlar (16×16, currentColor).
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.2 3.8A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a12 12 0 0 1-1.9 2.5M4.1 4.9C2.4 6.1 1.5 8 1.5 8S3.9 12.5 8 12.5c1.2 0 2.3-.4 3.2-.9" />
    <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" />
    <path d="M2 2l12 12" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);

export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.5L2 6.5l3 3" />
    <path d="M2 6.5h7.5a4 4 0 0 1 0 8H7" />
  </Svg>
);

export const IconRedo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 3.5l3 3-3 3" />
    <path d="M14 6.5H6.5a4 4 0 0 0 0 8H9" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 10.5V2.5M5 5.5l3-3 3 3" />
    <path d="M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
  </Svg>
);

export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
    <rect x="5.5" y="5.5" width="5" height="5" rx="0.5" />
  </Svg>
);

/** Mate aracı: iki parçayı bağlayan halka */
export const IconMate = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.8 9.2l2.4-2.4" />
    <path d="M7.6 4.6l1.2-1.2a2.6 2.6 0 0 1 3.8 3.8l-1.2 1.2" />
    <path d="M8.4 11.4l-1.2 1.2a2.6 2.6 0 0 1-3.8-3.8l1.2-1.2" />
  </Svg>
);

/** Ağaçta "mate ile bağlı" işareti */
export const IconLink = IconMate;

export const IconSwap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8" />
    <path d="M13 10.5H3.5M6 8l-2.5 2.5L6 13" />
  </Svg>
);

/** Rijit grup: iki parçayı saran çerçeve */
export const IconGroup = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2" strokeDasharray="2.5 2" />
    <rect x="4" y="4" width="4" height="4" rx="0.5" />
    <rect x="8" y="8" width="4" height="4" rx="0.5" />
  </Svg>
);

/** Grubu çöz: ayrılan iki parça */
export const IconUngroup = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="0.8" />
    <rect x="9" y="9" width="5.5" height="5.5" rx="0.8" />
    <path d="M10 3.5h2.5V6M6 12.5H3.5V10" />
  </Svg>
);

// ---- mate tipleri ----

export const IconMateCoincident = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 7h11M2.5 9h11" />
    <path d="M4 4.5v2.5M12 4.5v2.5M4 9v2.5M12 9v2.5" />
  </Svg>
);

export const IconMateConcentric = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.5" />
  </Svg>
);

export const IconMateParallel = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 13.5L9 2.5M8 13.5l4-11" />
  </Svg>
);

export const IconMatePerpendicular = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.5v11M2.5 13.5h11" />
    <path d="M8 10.5h3v3" />
  </Svg>
);

export const IconMateAngle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 13.5h11M2.5 13.5L11 3.5" />
    <path d="M7.5 13.5a5 5 0 0 0-1.6-3.9" />
  </Svg>
);
