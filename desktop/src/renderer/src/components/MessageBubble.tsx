import type { Message } from '../types'
import { cn } from '../lib/utils'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  FileText,
  Search,
  Globe,
  FilePen,
  Share2,
  BarChart2,
  List,
  UserPlus,
  Edit,
  Zap,
} from 'lucide-react'
import { MarkdownContent } from './MarkdownContent'

interface Props {
  message: Message
}

const ICON_MAP: Record<string, React.ReactNode> = {
  'search': <Search size={11} className="shrink-0" />,
  'globe': <Globe size={11} className="shrink-0" />,
  'file-text': <FileText size={11} className="shrink-0" />,
  'file-pen': <FilePen size={11} className="shrink-0" />,
  'share-2': <Share2 size={11} className="shrink-0" />,
  'bar-chart-2': <BarChart2 size={11} className="shrink-0" />,
  'list': <List size={11} className="shrink-0" />,
  'user-plus': <UserPlus size={11} className="shrink-0" />,
  'edit': <Edit size={11} className="shrink-0" />,
  'zap': <Zap size={11} className="shrink-0" />,
}

export function MessageBubble({ message }: Props): JSX.Element {
  const isUser = message.role === 'user'

  return (
    <div className="mb-4">
      <div className="flex gap-3">
        {/* Avatar */}
        <div
          className={cn(
            'shrink-0 mt-0.5 h-6 w-6 rounded-md flex items-center justify-center',
            isUser ? 'bg-[hsl(0,0%,20%)]' : 'bg-[hsl(0,0%,14%)]',
          )}
        >
          <span className="text-[10px] font-semibold text-[hsl(0,0%,50%)]">
            {isUser ? 'U' : 'AI'}
          </span>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap leading-relaxed text-[hsl(0,0%,85%)]">
              {message.content}
            </p>
          ) : (
            <MarkdownContent
              content={message.content}
              className="desktop-markdown text-sm leading-relaxed text-[hsl(0,0%,78%)]"
            />
          )}

          {/* Tool call history — rendered after message is finalized */}
          {message.metadata?.toolCalls && message.metadata.toolCalls.length > 0 && (
            <div className="mt-2 flex flex-col gap-[3px]">
              {message.metadata.toolCalls.map((tool) => (
                <div
                  key={tool.id}
                  className="flex items-center gap-2 px-2 py-[5px] rounded-md bg-[hsl(0,0%,6%)] border border-[hsl(0,0%,10%)]"
                >
                  {tool.status === 'running' && (
                    <Loader2 size={11} className="text-[hsl(217,70%,55%)] animate-spin shrink-0" />
                  )}
                  {tool.status === 'completed' && (
                    <CheckCircle2 size={11} className="text-[hsl(142,55%,40%)] shrink-0" />
                  )}
                  {tool.status === 'failed' && (
                    <AlertCircle size={11} className="text-[hsl(0,55%,48%)] shrink-0" />
                  )}
                  {/* Fallback icon from map */}
                  {!['running', 'completed', 'failed'].includes(tool.status) && (
                    <span className="text-[hsl(0,0%,35%)]">
                      {ICON_MAP[tool.icon ?? ''] ?? <Zap size={11} className="shrink-0" />}
                    </span>
                  )}
                  <span className="text-xs text-[hsl(0,0%,32%)] font-mono truncate">
                    {tool.label || tool.name}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Lark doc references */}
          {message.metadata?.larkDocs && message.metadata.larkDocs.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {message.metadata.larkDocs.map((doc) => (
                <div
                  key={doc.documentId}
                  className="flex items-center gap-2 px-2 py-1 rounded bg-[hsl(0,0%,8%)] border border-[hsl(0,0%,14%)]"
                >
                  <FileText size={12} className="text-[hsl(38,80%,55%)]" />
                  <span className="text-xs text-[hsl(0,0%,60%)]">{doc.title}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {message.metadata?.error && (
            <div className="mt-2 px-2 py-1 rounded bg-[hsl(0,40%,10%)] border border-[hsl(0,40%,20%)]">
              <span className="text-xs text-[hsl(0,50%,60%)]">{message.metadata.error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
