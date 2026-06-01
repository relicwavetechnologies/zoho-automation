import { useState } from 'react';
import { Folder, Check, Clock, ArrowRight } from 'lucide-react';
import { OnboardLayout } from './OnboardLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';

export function WorkspaceScreen() {
  const { session, setOnboardingStep } = useAuthStore();
  const { workspaces, addByPath, pickAndAdd, setActive, upsertByPathRemote } = useWorkspaceStore();
  const [path, setPath] = useState<string>(
    workspaces[0]?.path ?? '~/conductor/workspaces/divo/lansing',
  );

  const open = async (p: string) => {
    if (session?.token) {
      await upsertByPathRemote(session.token, p);
    } else {
      addByPath(p);
    }
    setOnboardingStep('done');
  };

  const browse = async () => {
    const ws = await pickAndAdd();
    if (ws) {
      if (session?.token) await upsertByPathRemote(session.token, ws.path, ws.name);
      setOnboardingStep('done');
    }
  };

  return (
    <OnboardLayout
      step={3}
      total={3}
      brandTagline="Point Divo at your repositories. Multiple folders, one chat — switch context any time, run chat-only without one."
      brandFootEyebrow="Repositories"
      brandFootLine='"Your code stays on your machine. Always."'
      eyebrow="Repositories"
      title="Add your first repository."
      description={
        <>
          Pick a folder Divo should treat as a working directory. You can add more from the sidebar
          at any time, or skip and use chat-only mode.
        </>
      }
      rightFoot={
        <a href="#" className="text-fg-muted hover:text-foreground">
          Reconnect to continue using Divo
        </a>
      }
    >
      <div className="mb-1.5 text-xs font-medium text-fg-muted">Folder path</div>
      <div className="flex gap-2">
        <Input value={path} onChange={(e) => setPath(e.target.value)} className="flex-1" />
        <Button variant="secondary" className="h-10 flex-shrink-0 px-3.5" onClick={() => void browse()}>
          <Folder className="h-4 w-4" />
          Browse
        </Button>
      </div>

      <Button
        size="lg"
        className="mt-3.5 h-[42px] w-full bg-[hsl(0_0%_96%)] text-[13.5px] font-medium text-[hsl(0_0%_6%)] hover:bg-white"
        onClick={() => void open(path)}
      >
        Add repository
        <ArrowRight className="h-4 w-4" />
      </Button>

      {workspaces.length > 0 ? (
        <>
          <div className="mt-7 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-fg-dim">
            <Clock className="h-3 w-3" />
            Already added
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {workspaces.map((r, i) => (
              <button
                key={r.id}
                onClick={() => {
                  setActive(r.id);
                  setOnboardingStep('done');
                }}
                className="flex w-full items-center gap-2.5 rounded-md border border-border-subtle bg-surface-1 px-3 py-2.5 text-left text-[12.5px] text-foreground transition-colors hover:border-border hover:bg-surface-2"
              >
                <Folder className="h-3.5 w-3.5 text-fg-muted" />
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-fg-muted">
                  {r.path}
                </span>
                {i === 0 ? <Check className="h-3.5 w-3.5 text-success" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="mt-4 h-8 w-full justify-center text-xs"
        onClick={() => {
          setActive(null);
          setOnboardingStep('done');
        }}
      >
        Continue without a repository
        <span className="text-fg-dim">·</span>
        <span className="text-fg-dim">chat-only mode</span>
      </Button>
    </OnboardLayout>
  );
}
