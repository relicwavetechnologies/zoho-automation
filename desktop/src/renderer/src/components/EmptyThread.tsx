import { MessageSquarePlus } from 'lucide-react'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

export function EmptyThread(): JSX.Element {
  const { createThread } = useChat()
  const { currentWorkspace } = useWorkspace()

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-5 max-w-md px-6 text-center">
        <div className="h-14 w-14 rounded-2xl bg-[hsl(0,0%,8%)] border border-[hsl(0,0%,14%)] flex items-center justify-center">
          <MessageSquarePlus size={22} className="text-[hsl(0,0%,35%)]" />
        </div>
        <div>
          <h3 className="text-base font-medium text-[hsl(0,0%,70%)] mb-1">
            {currentWorkspace ? `No thread selected in ${currentWorkspace.name}` : 'No thread selected'}
          </h3>
          <p className="text-sm text-[hsl(0,0%,38%)] leading-relaxed">
            {currentWorkspace
              ? 'Select an existing thread from the sidebar or start a new conversation in this workspace.'
              : 'Open a workspace and start a new conversation.'}
          </p>
        </div>
        <button
          onClick={() => createThread()}
          className={cn(
            'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            'bg-[hsl(0,0%,14%)] text-[hsl(0,0%,70%)]',
            'hover:bg-[hsl(0,0%,18%)] hover:text-[hsl(0,0%,85%)]',
            'border border-[hsl(0,0%,20%)]',
          )}
        >
          New thread
        </button>
      </div>
    </div>
  )
}
