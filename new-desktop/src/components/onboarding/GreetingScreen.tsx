import { Check, ArrowRight, Plus } from 'lucide-react';
import { OnboardLayout } from './OnboardLayout';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';

interface CheckRowProps {
  title: string;
  subtitle: string;
  meta: string;
  pending?: boolean;
}

function CheckRow({ title, subtitle, meta, pending }: CheckRowProps) {
  return (
    <div className="mb-1.5 flex items-center gap-2.5 rounded-md border border-border-subtle bg-surface-1 px-3 py-2.5 text-[12.5px]">
      <div
        className={
          pending
            ? 'flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md bg-surface-3 text-fg-dim'
            : 'flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md bg-success/15 text-success'
        }
      >
        {pending ? <Plus className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className={pending ? 'text-fg-muted' : 'text-foreground'}>{title}</div>
        <div className="text-[11.5px] text-fg-muted">{subtitle}</div>
      </div>
      <span className="text-[11.5px] text-fg-dim">{meta}</span>
    </div>
  );
}

export function GreetingScreen() {
  const { session, setOnboardingStep } = useAuthStore();
  const first = session?.user?.name?.split(' ')[0] ?? 'there';

  return (
    <OnboardLayout
      step={2}
      total={3}
      brandTagline="Same brain in Lark, on desktop, and on the web. Your tools, your identity, your team — already connected."
      brandFootEyebrow="Signed in via Lark"
      brandFootLine={`"Welcome back, ${first}."`}
      eyebrow="You"
      title={`Hi, ${first}.`}
      description={
        <>
          You're signed in as{' '}
          <code className="rounded bg-surface-2 px-1.5 py-px font-mono text-xs text-foreground">
            {session?.user?.email ?? 'you@company.com'}
          </code>
          {session?.user?.role ? <> · {session.user.role}</> : null}
          {session?.user?.department ? <> · {session.user.department}</> : null}. Here's what's
          already wired up:
        </>
      }
      rightFoot={
        <a href="#" className="text-fg-muted hover:text-foreground">Wrong account?</a>
      }
    >
      <CheckRow
        title="Lark identity"
        subtitle="EMIAC Technologies tenant"
        meta="verified"
      />
      <CheckRow title="Zoho Books" subtitle="Finance ledger access" meta="connected" />
      <CheckRow
        title="Google Workspace"
        subtitle="Gmail · Calendar · Drive"
        meta="connected"
      />
      <CheckRow
        title="3 chats restored"
        subtitle="from your last Lark session"
        meta="ready"
        pending
      />

      <Button
        size="lg"
        className="mt-5 h-[42px] w-full bg-[hsl(0_0%_96%)] text-[13.5px] font-medium text-[hsl(0_0%_6%)] hover:bg-white"
        onClick={() => setOnboardingStep('workspace')}
      >
        Continue
        <ArrowRight className="h-4 w-4" />
      </Button>
    </OnboardLayout>
  );
}
