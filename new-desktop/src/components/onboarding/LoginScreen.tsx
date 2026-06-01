import { Globe } from 'lucide-react';
import { OnboardLayout } from './OnboardLayout';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';

export function LoginScreen() {
  const { startLarkSignIn, status, error } = useAuthStore();
  const busy = status === 'authenticating';

  return (
    <OnboardLayout
      step={1}
      total={3}
      brandTagline="Your AI operations co-worker. Runs in Lark, on your desktop, against your tools — same brain everywhere."
      brandFootEyebrow="Sign in with Lark"
      brandFootLine='"One identity. Every device. No second login."'
      eyebrow="Welcome"
      title="Sign in to Divo."
      description={
        <>
          Use your Lark workspace to sign in. We'll match you to your team, restore your past chats,
          and pick up where you left off.
        </>
      }
      rightFoot={<a href="#" className="text-fg-muted hover:text-foreground">Get help</a>}
    >
      <Button
        size="lg"
        className="h-[42px] w-full bg-[hsl(0_0%_96%)] text-[13.5px] font-medium text-[hsl(0_0%_6%)] hover:bg-white"
        onClick={() => void startLarkSignIn()}
        disabled={busy}
      >
        <span
          className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[hsl(220_90%_50%)] text-[11px] font-bold text-white"
          aria-hidden
        >
          L
        </span>
        {busy ? 'Opening Lark…' : 'Continue with Lark'}
      </Button>

      <div className="my-5 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-dim">
        <span className="h-px flex-1 bg-border-subtle" />
        or
        <span className="h-px flex-1 bg-border-subtle" />
      </div>

      <Button variant="secondary" size="lg" className="h-[42px] w-full" disabled>
        <Globe className="h-4 w-4" />
        Custom server URL
      </Button>

      {error ? (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <p className="mt-6 text-center text-[11px] leading-relaxed text-fg-dim">
        By continuing you agree to Divo's{' '}
        <a href="#" className="text-fg-muted hover:text-foreground">Terms</a> and{' '}
        <a href="#" className="text-fg-muted hover:text-foreground">Privacy Policy</a>.
      </p>
    </OnboardLayout>
  );
}
