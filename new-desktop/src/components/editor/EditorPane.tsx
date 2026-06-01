import { X, Search, FileText, Folder, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EditorPaneProps {
  onClose: () => void;
}

/**
 * Stub editor pane. Wire to real Monaco once the file-diff event stream
 * (file.read / file.write) lands and the desktop channel writes diffs.
 */
export function EditorPane({ onClose }: EditorPaneProps) {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-border-subtle bg-surface-1">
      <div className="drag-region flex h-9 items-center border-b border-border-subtle bg-surface-2 px-3">
        <span className="text-xs text-fg-muted">Editor</span>
        <span className="mx-2 text-fg-dim">·</span>
        <span className="text-[11.5px] text-fg-dim">no files open</span>
        <div className="ml-auto flex items-center gap-1 no-drag-region">
          <Button variant="ghost" size="icon-sm">
            <Search className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr]">
        <div className="overflow-y-auto border-r border-border-subtle p-2 text-xs text-fg-muted">
          <TreeRow icon={<Folder className="h-3.5 w-3.5 text-info" />} label="src" caret />
          <TreeRow icon={<Folder className="h-3.5 w-3.5 text-fg-dim" />} label="application" indent={1} caret />
          <TreeRow icon={<FileText className="h-3.5 w-3.5 text-warning" />} label="zoho-books.tool.ts" indent={2} />
          <TreeRow icon={<FileText className="h-3.5 w-3.5 text-fg-dim" />} label="zoho-crm.tool.ts" indent={2} />
        </div>
        <div className="flex items-center justify-center bg-background p-8 text-center text-xs text-fg-dim">
          Wire to Monaco when the desktop channel emits <code className="ml-1 mr-1 rounded border border-border-subtle bg-surface-2 px-1.5 py-px font-mono text-[11.5px]">file.write</code> events with diffs.
        </div>
      </div>
    </aside>
  );
}

function TreeRow({
  icon,
  label,
  indent = 0,
  caret,
}: {
  icon: React.ReactNode;
  label: string;
  indent?: number;
  caret?: boolean;
}) {
  return (
    <div
      className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-surface-hover hover:text-foreground"
      style={{ paddingLeft: 6 + indent * 14 }}
    >
      {caret ? <ChevronDown className="h-3 w-3 text-fg-dim" /> : <span className="w-3" />}
      {icon}
      <span className="truncate">{label}</span>
    </div>
  );
}
