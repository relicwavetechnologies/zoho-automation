import { Composer } from './Composer';
import { WorkspaceBreadcrumb } from './WorkspaceBreadcrumb';

/**
 * Centered composer stage shown when there are no messages yet.
 * Matches Cursor's "new chat" landing — breadcrumb above, composer, Plan New Idea pill below.
 */
export function EmptyState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-stretch justify-center px-6">
      <div className="mx-auto w-full max-w-[720px]">
        <div className="mb-3 px-1">
          <WorkspaceBreadcrumb />
        </div>

        <Composer variant="inline" />

        <div className="mt-2.5">
          <button className="inline-flex items-center gap-1.5 rounded-full border border-border bg-transparent px-3 py-1.5 text-[11.5px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-foreground">
            <span>Plan New Idea</span>
            <span className="font-mono text-[10px] text-fg-dim">⇧Tab</span>
          </button>
        </div>
      </div>
    </div>
  );
}
