import { useChat } from '../context/ChatContext'
import { ChatPane } from './ChatPane'
import { Composer } from './Composer'
import { HomeView } from './HomeView'

export function ChatLayout(): JSX.Element {
  const { activeThread, messages, isThreadLoading, isStreaming, liveBlocks } = useChat()

  // Show HomeView (minimalist centered UI) if:
  // 1. No thread is active
  // 2. Thread is active but has no messages yet (and not currently streaming/loading)
  const showHome = !activeThread || (!isThreadLoading && messages.length === 0 && !isStreaming && liveBlocks.length === 0)

  if (showHome) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <HomeView />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatPane />
      <Composer />
    </div>
  )
}
