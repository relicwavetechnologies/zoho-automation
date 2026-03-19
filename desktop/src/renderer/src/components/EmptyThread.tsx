import { MessageSquarePlus } from 'lucide-react'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

export function EmptyThread(): JSX.Element {
  const { createThread } = useChat()
  const { currentWorkspace } = useWorkspace()

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="glass-panel-strong flex flex-col items-center gap-5 max-w-md rounded-[32px] px-8 py-10 text-center">
        <div className="h-16 w-16 rounded-[22px] bg-sky-400/8 border border-sky-300/12 flex items-center justify-center">
          <MessageSquarePlus size={24} className="text-sky-100/72" />
        </div>
        <div>
          <h3 className="text-lg font-medium text-white/90 mb-1">
            {currentWorkspace ? `No thread selected in ${currentWorkspace.name}` : 'No thread selected'}
          </h3>
          <p className="text-sm text-white/50 leading-7">
            {currentWorkspace
              ? 'Select an existing thread from the sidebar or start a new conversation in this workspace.'
              : 'Open a workspace and start a new conversation.'}
          </p>
        </div>
        <button
          onClick={() => createThread()}
          className={cn(
            'px-4 py-2 rounded-xl text-sm font-medium transition-colors',
            'border border-sky-300/12 bg-sky-400/8 text-sky-50/88',
            'hover:bg-sky-400/12 hover:text-white',
          )}
        >
          New thread
        </button>
      </div>
    </div>
  )
}
