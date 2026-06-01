import { History, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface HeaderProps {
  editorOpen: boolean;
  onToggleEditor: () => void;
}

/**
 * Minimal header — just drag region + editor toggle.
 * The workspace breadcrumb lives next to the composer (Cursor behaviour).
 */
export function Header({ editorOpen, onToggleEditor }: HeaderProps) {
  return (
    <div className="drag-region flex h-11 shrink-0 items-center px-4">
      <div className="no-drag-region ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 text-xs">
          <History className="h-3.5 w-3.5" />
          History
        </Button>
        <Button
          variant={editorOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 text-xs"
          onClick={onToggleEditor}
        >
          <PanelRight className="h-3.5 w-3.5" />
          Editor
          <span className="ml-1 font-mono text-[10px] text-fg-dim">⌘E</span>
        </Button>
      </div>
    </div>
  );
}
