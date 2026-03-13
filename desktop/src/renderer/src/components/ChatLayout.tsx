import { useChat } from '../context/ChatContext'
import { ChatPane } from './ChatPane'
import { Composer } from './Composer'
import { HomeView } from './HomeView'

export function ChatLayout(): JSX.Element {
  const { activeThread } = useChat()

  if (!activeThread) {
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
