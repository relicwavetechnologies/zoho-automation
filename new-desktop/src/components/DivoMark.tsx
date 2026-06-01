import { cn } from '@/lib/utils';

interface DivoMarkProps {
  className?: string;
  /** Stroke variant — outline only, transparent inside */
  variant?: 'solid' | 'outline';
}

/**
 * Divo brand mark — stylized D inside a precise rounded square.
 * Single color via currentColor. No gradients, no bevels. Scales cleanly
 * from 16px (avatars) to 96px (onboarding brand).
 */
export function DivoMark({ className, variant = 'solid' }: DivoMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('shrink-0', className)}
      aria-hidden
    >
      {/* Frame */}
      <rect
        x="2.5"
        y="2.5"
        width="27"
        height="27"
        rx="7"
        {...(variant === 'solid'
          ? { fill: 'currentColor', fillOpacity: 0.07 }
          : {})}
        stroke="currentColor"
        strokeOpacity={variant === 'solid' ? 0.5 : 0.85}
        strokeWidth="1.25"
      />
      {/* Stylized D */}
      <path
        d="M11.5 9v14M11.5 9c5 0 9 2.4 9 7s-4 7-9 7"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
