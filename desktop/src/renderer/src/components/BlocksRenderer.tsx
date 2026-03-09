import { useState } from 'react'
import {
    CheckCircle2, ChevronRight, ChevronDown,
    Loader2, XCircle, Search, Globe, FilePen,
    FileText, Share2, BarChart2, List, UserPlus, Edit, Zap,
} from 'lucide-react'
import type { ContentBlock } from '../types'
import { cn } from '../lib/utils'
import { MarkdownContent } from './MarkdownContent'
import { ThinkingShimmer } from './ActivityBar'

// ── Icon lookup ───────────────────────────────────────────────────────────────
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

function ToolIcon({ icon, status }: { icon: string; status: 'running' | 'done' | 'failed' }): JSX.Element {
    if (status === 'running') return <Loader2 size={11} className="text-[hsl(217,70%,55%)] animate-spin shrink-0" />
    if (status === 'done') return <CheckCircle2 size={11} className="text-[hsl(142,55%,40%)] shrink-0" />
    if (status === 'failed') return <XCircle size={11} className="text-[hsl(0,55%,48%)] shrink-0" />
    return <span className="text-[hsl(0,0%,35%)]">{ICON_MAP[icon] ?? <Zap size={11} className="shrink-0" />}</span>
}

// ── Tool block row ────────────────────────────────────────────────────────────
function ToolBlockRow({ block }: { block: Extract<ContentBlock, { type: 'tool' }> }): JSX.Element {
    return (
        <div className={cn(
            'flex items-center gap-2 px-2.5 py-[5px] rounded-md my-[3px]',
            'bg-[hsl(0,0%,6%)] border border-[hsl(0,0%,10%)]',
        )}>
            <ToolIcon icon={block.icon} status={block.status} />
            <span className={cn(
                'text-xs font-mono truncate',
                block.status === 'done' ? 'text-[hsl(0,0%,30%)]' : 'text-[hsl(0,0%,42%)]',
            )}>
                {block.label || block.name}
            </span>
        </div>
    )
}

// ── Thinking block ────────────────────────────────────────────────────────────
function formatDuration(ms?: number): string {
    if (!ms) return 'a moment'
    const s = Math.round(ms / 1000)
    if (s < 1) return 'a moment'
    return `${s}s`
}

function ThinkingBlockRow({
    block,
    isLive,
}: {
    block: Extract<ContentBlock, { type: 'thinking' }>
    isLive?: boolean
}): JSX.Element {
    const [open, setOpen] = useState(false)
    const hasContent = !!block.text

    if (isLive) {
        // Active shimmer while streaming this thinking period
        return <ThinkingShimmer />
    }

    // Finalized — show collapsible "Thought for Xs"
    return (
        <div className="my-[3px]">
            <button
                onClick={() => setOpen((o) => !o)}
                disabled={!hasContent}
                className={cn(
                    'flex items-center gap-1.5 group select-none',
                    hasContent ? 'cursor-pointer' : 'cursor-default',
                )}
            >
                {hasContent ? (
                    open
                        ? <ChevronDown size={11} className="text-[hsl(0,0%,28%)] shrink-0 transition-transform" />
                        : <ChevronRight size={11} className="text-[hsl(0,0%,28%)] shrink-0 transition-transform" />
                ) : (
                    <ChevronRight size={11} className="text-[hsl(0,0%,18%)] shrink-0" />
                )}
                <span className={cn(
                    'text-xs font-mono',
                    hasContent ? 'text-[hsl(0,0%,28%)] group-hover:text-[hsl(0,0%,38%)]' : 'text-[hsl(0,0%,20%)]',
                    'transition-colors',
                )}>
                    Thought for {formatDuration(block.durationMs)}
                </span>
            </button>

            {open && hasContent && (
                <div className={cn(
                    'mt-1.5 ml-4 pl-3 border-l border-[hsl(0,0%,12%)]',
                    'text-[11px] text-[hsl(0,0%,30%)] font-mono leading-relaxed',
                    'whitespace-pre-wrap',
                )}>
                    {block.text}
                </div>
            )}
        </div>
    )
}

// ── Text block row ────────────────────────────────────────────────────────────
function TextBlockRow({
    block, isLast, isStreaming,
}: {
    block: Extract<ContentBlock, { type: 'text' }>
    isLast?: boolean
    isStreaming?: boolean
}): JSX.Element {
    return (
        <div className={cn(isLast && isStreaming ? 'streaming-cursor' : '', 'mt-1 mb-1')}>
            <MarkdownContent
                content={block.content}
                className="desktop-markdown text-sm leading-relaxed text-[hsl(0,0%,85%)]"
            />
        </div>
    )
}

// ── Main exports ──────────────────────────────────────────────────────────────
interface BlocksRendererProps {
    blocks: ContentBlock[]
    isStreaming?: boolean
}

export function BlocksRenderer({ blocks, isStreaming }: BlocksRendererProps): JSX.Element {
    return (
        <div className="flex flex-col">
            {blocks.map((block, i) => {
                const isLastBlock = i === blocks.length - 1

                if (block.type === 'tool') {
                    return <ToolBlockRow key={`tool-${block.id}-${i}`} block={block} />
                }

                if (block.type === 'thinking') {
                    return (
                        <ThinkingBlockRow
                            key={`thinking-${i}`}
                            block={block}
                            // Live shimmer only when this is the last block and we are still streaming
                            isLive={isStreaming === true && isLastBlock}
                        />
                    )
                }

                // type === 'text'
                return (
                    <TextBlockRow
                        key={`text-${i}`}
                        block={block}
                        isLast={isLastBlock}
                        isStreaming={isStreaming}
                    />
                )
            })}
        </div>
    )
}
