import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Monitor, Home, FolderOpen, Plus, Check } from 'lucide-react';
import { cn, truncateMiddle } from '@/lib/utils';
import { useActiveWorkspace, useWorkspaceStore, type Workspace } from '@/store/workspace';

/**
 * Workspace breadcrumb shown above the composer when starting a new chat.
 *
 *   Home ▾  · 📁 Local
 *
 * Click "Home ▾" → opens a Cursor-style picker:
 *   - Search
 *   - Recents (Home + workspaces, current marked ✓)
 *   - Open Folder…
 */
export function WorkspaceBreadcrumb() {
  const active = useActiveWorkspace();
  const { workspaces, setActive, pickAndAdd } = useWorkspaceStore();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('pointerdown', onClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const label = active?.name ?? 'Home';

  const filtered = query
    ? workspaces.filter(
        (w) =>
          w.name.toLowerCase().includes(query.toLowerCase()) ||
          w.path.toLowerCase().includes(query.toLowerCase()),
      )
    : workspaces;

  const onPickHome = () => {
    setActive(null);
    setOpen(false);
  };

  const onPickWorkspace = (w: Workspace) => {
    setActive(w.id);
    setOpen(false);
  };

  const onAddFolder = async () => {
    setOpen(false);
    await pickAndAdd();
  };

  return (
    <div ref={ref} className="relative inline-flex items-center gap-2 text-[12.5px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground transition-colors hover:bg-surface-hover"
      >
        <span className="font-medium">{label}</span>
        <ChevronDown className="h-3 w-3 text-fg-muted" />
      </button>

      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <Monitor className="h-3.5 w-3.5" />
        Local
      </span>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-[320px] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-2xl shadow-black/40">
          <div className="px-2 pb-1 pt-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Run Divo anywhere…"
              className="w-full bg-transparent px-1 text-[12.5px] text-foreground placeholder:text-fg-dim focus:outline-none"
            />
          </div>
          <div className="h-px bg-border-subtle" />

          <div className="px-2 pb-1 pt-2 text-[10.5px] uppercase tracking-[0.08em] text-fg-dim">
            Recents
          </div>

          <PickerRow
            icon={<Home className="h-3.5 w-3.5" />}
            label="Home"
            active={!active}
            check
            onClick={onPickHome}
          />

          {filtered.map((w) => (
            <PickerRow
              key={w.id}
              icon={<FolderGlyph />}
              label={w.path}
              active={active?.id === w.id}
              check
              mono
              onClick={() => onPickWorkspace(w)}
            />
          ))}

          {filtered.length === 0 && query ? (
            <div className="px-3 py-2 text-xs text-fg-dim">No matches</div>
          ) : null}

          <div className="my-1 h-px bg-border-subtle" />

          <PickerRow
            icon={<FolderOpen className="h-3.5 w-3.5" />}
            label="Open Folder…"
            onClick={() => void onAddFolder()}
          />
          <PickerRow
            icon={<Plus className="h-3.5 w-3.5" />}
            label="Set Up Workspace"
            onClick={() => void onAddFolder()}
          />
        </div>
      ) : null}
    </div>
  );
}

interface PickerRowProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  check?: boolean;
  mono?: boolean;
  onClick: () => void;
}
function PickerRow({ icon, label, active, check, mono, onClick }: PickerRowProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
        active
          ? 'bg-surface-active text-foreground'
          : 'text-fg-muted hover:bg-surface-hover hover:text-foreground',
      )}
    >
      <span className="text-fg-muted">{icon}</span>
      <span
        className={cn(
          'flex-1 truncate',
          mono ? 'font-mono text-[11.5px]' : '',
        )}
        title={label}
      >
        {mono ? truncateMiddle(label, 36) : label}
      </span>
      {check && active ? <Check className="h-3.5 w-3.5 text-fg-muted" /> : null}
    </button>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
      <path
        d="M3 7a2 2 0 012-2h3.5l2 2H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
