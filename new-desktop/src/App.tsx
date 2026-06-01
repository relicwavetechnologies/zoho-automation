import { useEffect } from 'react';
import { useAuthStore } from './store/auth';
import { useWorkspaceStore } from './store/workspace';
import { LoginScreen } from './components/onboarding/LoginScreen';
import { GreetingScreen } from './components/onboarding/GreetingScreen';
import { WorkspaceScreen } from './components/onboarding/WorkspaceScreen';
import { ChatLayout } from './components/chat/ChatLayout';

export function App() {
  const { session, hydrate, onboardingStep, setOnboardingStep, status } = useAuthStore();
  const { hydrate: hydrateWorkspace, workspaces } = useWorkspaceStore();

  useEffect(() => {
    hydrateWorkspace();
    void hydrate();
  }, [hydrate, hydrateWorkspace]);

  const hasSavedWorkspace = workspaces.length > 0;
  const shouldSkipWorkspaceStep = Boolean(session) && onboardingStep === 'workspace' && hasSavedWorkspace;
  const effectiveOnboardingStep = shouldSkipWorkspaceStep ? 'done' : onboardingStep;

  useEffect(() => {
    if (shouldSkipWorkspaceStep) {
      setOnboardingStep('done');
    }
  }, [setOnboardingStep, shouldSkipWorkspaceStep]);

  // Decide which surface to render based on onboarding step
  let content: React.ReactNode;
  if (status === 'loading') {
    content = (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-pulse rounded-lg bg-surface-2" />
          <p className="text-xs text-fg-dim">Loading…</p>
        </div>
      </div>
    );
  } else if (!session) {
    content = <LoginScreen />;
  } else if (effectiveOnboardingStep === 'greeting') {
    content = <GreetingScreen />;
  } else if (effectiveOnboardingStep === 'workspace') {
    content = <WorkspaceScreen />;
  } else {
    content = <ChatLayout />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{content}</div>
    </div>
  );
}
