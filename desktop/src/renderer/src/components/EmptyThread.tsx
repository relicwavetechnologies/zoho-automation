import { MessageSquarePlus } from 'lucide-react'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

export function EmptyThread(): JSX.Element {
  const { createThread } = useChat()
  const { currentWorkspace } = useWorkspace()

  return (
    <div className="flex-1 flex items-center justify-center animate-in fade-in duration-1000">
      <div className="flex flex-col items-center gap-6 max-w-sm px-6 text-center">
        <div className="h-16 w-16 rounded-2xl bg-secondary/20 border border-border/50 flex items-center justify-center shadow-sm">
          <MessageSquarePlus size={28} className="text-muted-foreground/30" />
        </div>
        <div>
          <h3 className="text-lg font-bold text-foreground/90 tracking-tight mb-2">
            {currentWorkspace ? `No thread selected in ${currentWorkspace.name}` : 'No thread selected'}
          </h3>
          <p className="text-[13px] text-muted-foreground/50 leading-relaxed font-medium">
            {currentWorkspace
              ? 'Select an existing conversation from the sidebar or start a new one to begin.'
              : 'Open a workspace and start a new conversation with Divo.'}
          </p>
        </div>
        <button
          onClick={() => void createThread()}
          className={cn(
            'px-6 py-2 rounded-lg text-[12px] font-bold uppercase tracking-wider transition-all',
            'bg-primary text-primary-foreground hover:opacity-90 shadow-sm',
          )}
        >
          New thread
        </button>
      </div>
    </div>
  )
}
