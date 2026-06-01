import type { ReactNode } from 'react';
import { DivoMark } from '../DivoMark';

export interface OnboardLayoutProps {
  step: number;
  total: number;
  brandTagline: string;
  brandFootEyebrow: string;
  brandFootLine: string;
  eyebrow: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  rightFoot?: ReactNode;
}

/**
 * Half-split onboarding canvas: brand panel left, form panel right.
 * Matches the mock at advance-backend/docs/new-desktop-mock/login.html.
 */
export function OnboardLayout(props: OnboardLayoutProps) {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 overflow-hidden">
      {/* Brand left */}
      <div className="relative flex flex-col justify-between border-r border-border-subtle bg-background px-14 pb-10 pt-14">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 30% 25%, hsl(218 60% 18% / 0.25), transparent 55%), radial-gradient(circle at 65% 80%, hsl(280 50% 18% / 0.18), transparent 50%)',
          }}
        />
        <div className="relative z-10 my-auto">
          <DivoMark className="mb-7 h-16 w-16 text-foreground" />
          <h1 className="m-0 mb-2.5 text-[32px] font-medium leading-tight tracking-tight text-foreground">
            Divo
          </h1>
          <p className="m-0 max-w-[320px] text-sm leading-relaxed text-fg-muted">
            {props.brandTagline}
          </p>
        </div>
        <div className="relative z-10 flex flex-col gap-1.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-fg-dim">
            {props.brandFootEyebrow}
          </div>
          <div className="text-[12.5px] italic text-fg-muted">{props.brandFootLine}</div>
        </div>
      </div>

      {/* Form right */}
      <div className="relative flex flex-col overflow-y-auto bg-background px-14 pb-10 pt-14">
        <div className="absolute right-8 top-6 text-[11.5px] font-medium text-fg-dim">
          {props.step} of {props.total}
        </div>

        <div className="my-auto flex max-w-[380px] flex-col gap-2">
          <div className="mb-3 inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-accent">
            <span
              aria-hidden
              className="h-[5px] w-[5px] rounded-full bg-accent"
              style={{ boxShadow: '0 0 10px hsl(var(--accent))' }}
            />
            {props.eyebrow}
          </div>
          <h2 className="m-0 mb-2.5 text-[26px] font-medium leading-tight tracking-tight text-foreground">
            {props.title}
          </h2>
          {props.description ? (
            <p className="m-0 mb-6 text-[13.5px] leading-relaxed text-fg-muted">
              {props.description}
            </p>
          ) : null}

          {props.children}
        </div>

        {props.rightFoot ? (
          <div className="absolute bottom-6 right-8 text-[11.5px] text-fg-dim">
            {props.rightFoot}
          </div>
        ) : null}
      </div>
    </div>
  );
}
