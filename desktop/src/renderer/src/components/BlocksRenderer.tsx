import { useState, useRef, useEffect } from 'react'
import {
    CheckCircle2, ChevronRight, ChevronDown,
    Loader2, XCircle, Search, Globe, FilePen,
    FileText, Share2, BarChart2, List, UserPlus, Edit, Zap, ShieldAlert, TerminalSquare, Brain,
} from 'lucide-react'
import type { ContentBlock } from '../types'
import { cn } from '../lib/utils'
import { MarkdownContent } from './MarkdownContent'
import { ThinkingShimmer } from './ActivityBar'
import TextShimmer from './TextShimmer'
import { useChat } from '../context/ChatContext'

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
    if (status === 'running') return <Loader2 size={11} className="text-primary/60 animate-spin shrink-0" />
    if (status === 'done') return <CheckCircle2 size={11} className="text-emerald-500/60 shrink-0" />
    if (status === 'failed') return <XCircle size={11} className="text-red-500/60 shrink-0" />
    return <span className="text-muted-foreground/50">{ICON_MAP[icon] ?? <Zap size={11} className="shrink-0" />}</span>
}

function ApprovalBlockCard({ block }: { block: Extract<ContentBlock, { type: 'approval' }> }): JSX.Element {
    const { approveCommand, rejectCommand } = useChat()
    const isPending = block.status === 'pending'
    const statusLabel = block.status === 'approved' ? 'Approved' : block.status === 'rejected' ? 'Rejected' : 'Awaiting approval'
    const statusTone = block.status === 'approved'
        ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
        : block.status === 'rejected'
            ? 'bg-red-500/10 text-red-500 border-red-500/20'
            : 'bg-amber-500/10 text-amber-500 border-amber-500/20'

    return (
        <div className="my-3 rounded-2xl border border-border bg-secondary/20 p-4 shadow-sm">
            <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-amber-500/10 p-2 text-amber-500/80">
                    <ShieldAlert size={16} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-foreground/90">
                            {block.title}
                        </div>
                        <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', statusTone)}>
                            {statusLabel}
                        </span>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                        {block.description}
                    </div>
                    <div className="mt-3 rounded-xl border border-border bg-black/20 px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground/80">
                        {block.subject}
                    </div>
                    <div className="mt-2 text-[10px] text-muted-foreground/50">
                        {block.footer}
                    </div>

                    {isPending && (
                        <div className="mt-4 flex items-center gap-2">
                            <button
                                onClick={() => void approveCommand(block.id)}
                                className="rounded-lg bg-primary/10 border border-primary/20 px-3 py-1.5 text-xs font-semibold text-primary/90 hover:bg-primary/20 transition-colors"
                            >
                                Approve
                            </button>
                            <button
                                onClick={() => rejectCommand(block.id)}
                                className="rounded-lg border border-border bg-secondary/50 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

function TerminalBlockCard({ block }: { block: Extract<ContentBlock, { type: 'terminal' }> }): JSX.Element {
    const { killCommand } = useChat()
    const output = `${block.stdout}${block.stderr ? `${block.stdout ? '\n' : ''}${block.stderr}` : ''}`.trimEnd()
    const footerLabel = block.status === 'running'
        ? 'Running...'
        : `Exit code ${block.exitCode ?? 'unknown'}${block.durationMs ? ` in ${Math.max(1, Math.round(block.durationMs / 1000))}s` : ''}`
    const statusTone = block.status === 'running'
        ? 'bg-primary/10 text-primary border-primary/20'
        : block.status === 'done'
            ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
            : 'bg-red-500/10 text-red-500 border-red-500/20'

    return (
        <div className="my-3 overflow-hidden rounded-2xl border border-border bg-black/20 shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                    <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest">Terminal</div>
                    <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider', statusTone)}>
                        {block.status === 'running' ? 'Running' : block.status === 'done' ? 'Success' : 'Failed'}
                    </span>
                </div>
                {block.status === 'running' && (
                    <button
                        onClick={() => void killCommand(block.id)}
                        className="shrink-0 rounded-lg border border-border bg-secondary/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                    >
                        Stop
                    </button>
                )}
            </div>
            <div className="px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground/90">
                <div className="mb-3 rounded-lg border border-border bg-black/40 px-3 py-2 whitespace-pre-wrap break-words text-primary/80">$ {block.command}</div>
                {output ? (
                    <pre className="max-h-[20rem] overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground/80 text-[12px]">{output}</pre>
                ) : (
                    <div className="flex items-center gap-2 text-muted-foreground/40">
                        {block.status === 'running' ? <Loader2 size={13} className="animate-spin" /> : <TerminalSquare size={13} />}
                        <span className="text-[12px]">{block.status === 'running' ? 'Executing...' : 'No output'}</span>
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between px-4 pb-2 text-[10px] text-muted-foreground/30 font-medium">
                <span className="truncate max-w-[70%]">{block.cwd}</span>
                <span className="shrink-0">{footerLabel}</span>
            </div>
        </div>
    )
}

// ── Tool block row ────────────────────────────────────────────────────────────
function ToolBlockRow({ block }: { block: Extract<ContentBlock, { type: 'tool' }> }): JSX.Element {
    const [open, setOpen] = useState(() => block.name === 'planner-agent' || block.status === 'failed')
    const [showAllSources, setShowAllSources] = useState(false)
    const isRunning = block.status === 'running'
    const hasSummary = !!block.resultSummary && !isRunning

    // Check if result summary is one of our structured citation payloads
    let structuredData: any = null
    if (hasSummary) {
        try {
            const parsed = JSON.parse(block.resultSummary!)
            if (parsed.type === 'structured_search' || parsed.type === 'structured_knowledge') {
                structuredData = parsed
            }
        } catch (e) { /* not JSON */ }
    }

    // Convert to past tense if done (e.g. "Search" -> "Searched")
    let displayLabel = block.label || block.name
    if (!isRunning) {
        if (displayLabel.toLowerCase().startsWith('search ')) {
            displayLabel = displayLabel.replace(/^search /i, 'Searched ')
        } else if (displayLabel.toLowerCase().startsWith('generate ')) {
            displayLabel = displayLabel.replace(/^generate /i, 'Generated ')
        } else if (!displayLabel.endsWith('ed')) {
            displayLabel = `${displayLabel} completed`
        }
    }

    // Custom UI for search citations matching reference image
    if (structuredData) {
        const sourcesCount = structuredData.sources?.length || 0
        const visibleSources = showAllSources ? structuredData.sources : structuredData.sources.slice(0, 6)
        const hiddenSourcesCount = Math.max(0, sourcesCount - visibleSources.length)
        return (
            <div className="py-1 my-0.5 flex flex-col items-start w-full">
                <button
                    onClick={() => setOpen((o) => !o)}
                    className={cn(
                        'flex items-center gap-1.5 group select-none text-left w-full',
                        'transition-colors cursor-pointer'
                    )}
                >
                    <div className="flex items-center justify-start shrink-0 w-[24px] gap-1 text-muted-foreground/40">
                        {open
                            ? <ChevronDown size={10} className="shrink-0" />
                            : <ChevronRight size={10} className="shrink-0" />
                        }
                        <ToolIcon icon={block.icon} status={block.status} />
                    </div>

                    <span className="text-xs font-medium text-muted-foreground/60 group-hover:text-muted-foreground transition-colors mr-2">
                        {displayLabel}
                    </span>

                    <span className="text-[11px] font-medium text-muted-foreground/30 group-hover:text-muted-foreground/40 transition-colors">
                        — {sourcesCount} sources reviewed
                    </span>
                </button>

                {open && sourcesCount > 0 && (
                    <div className={cn(
                        'mt-2 w-full max-w-[600px] border border-border rounded-xl',
                        'bg-secondary/20 overflow-hidden flex flex-col',
                    )}>
                        {visibleSources.map((src: any, idx: number) => {
                            let domain = ''
                            try { domain = new URL(src.url).hostname.replace('www.', '') } catch (e) { }
                            return (
                                <a
                                    key={idx}
                                    href={src.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center gap-3 px-3 py-2 hover:bg-secondary/40 border-b border-border/50 last:border-b-0 transition-colors"
                                >
                                    <div className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center bg-secondary border border-border overflow-hidden">
                                        <img
                                            src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
                                            className="w-full h-full object-cover"
                                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                            alt=""
                                        />
                                    </div>
                                    <span className="text-[12px] text-foreground/70 truncate flex-1 font-medium">{src.title || src.url}</span>
                                    <span className="text-[10px] text-muted-foreground/40 shrink-0 font-mono">{domain}</span>
                                </a>
                            )
                        })}
                        {sourcesCount > 6 && (
                            <button
                                onClick={() => setShowAllSources((value) => !value)}
                                className="m-2 self-start rounded-lg border border-border bg-secondary/30 px-3 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                            >
                                {showAllSources
                                    ? 'Fewer sources'
                                    : `+${hiddenSourcesCount} more sources`}
                            </button>
                        )}
                    </div>
                )}
            </div>
        )
    }

    // Default Tool UI (for Zoho, Custom tools, etc)
    return (
        <div className="py-1 my-0.5">
            <button
                onClick={() => setOpen((o) => !o)}
                disabled={!hasSummary}
                className={cn(
                    'flex items-center gap-1.5 group select-none text-left w-full',
                    hasSummary ? 'cursor-pointer' : 'cursor-default',
                )}
            >
                <div className="flex items-center justify-start shrink-0 w-[24px] gap-1 text-muted-foreground/40">
                    {hasSummary ? (
                        open
                            ? <ChevronDown size={10} className="shrink-0" />
                            : <ChevronRight size={10} className="shrink-0" />
                    ) : (
                        <div className="w-[10px] shrink-0" />
                    )}
                    <ToolIcon icon={block.icon} status={block.status} />
                </div>

                {isRunning ? (
                    <TextShimmer className="text-xs font-medium text-primary/60" duration={1.5} spread={2}>
                        {displayLabel}
                    </TextShimmer>
                ) : (
                    <span className={cn(
                        'text-xs font-medium transition-colors',
                        block.status === 'done'
                            ? (hasSummary ? 'text-muted-foreground/60 group-hover:text-muted-foreground' : 'text-muted-foreground/50')
                            : 'text-red-500/60',
                    )}>
                        {displayLabel}
                    </span>
                )}
            </button>

            {open && hasSummary && (
                <div className={cn(
                    'mt-2 ml-6 pl-3 border-l border-border',
                    'desktop-markdown break-words [overflow-wrap:anywhere] text-[12px] text-muted-foreground/70 leading-relaxed',
                )}>
                    <MarkdownContent content={block.resultSummary!} />
                </div>
            )}
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
    const [open, setOpen] = useState(!!isLive)
    const scrollRef = useRef<HTMLDivElement>(null)
    const hasContent = !!block.text

    useEffect(() => {
        if (!isLive) setOpen(false)
    }, [isLive])

    // Auto-scroll to bottom as new tokens arrive
    useEffect(() => {
        if (isLive && open && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [block.text, isLive, open])

    if (isLive) {
        return (
            <div className="py-1 my-0.5">
                <button
                    onClick={() => setOpen((o) => !o)}
                    className="flex items-center gap-1.5 group select-none cursor-pointer text-left w-full"
                >
                    <div className="flex items-center justify-start shrink-0 w-[24px] gap-1 text-muted-foreground/40">
                        {open
                            ? <ChevronDown size={10} className="shrink-0" />
                            : <ChevronRight size={10} className="shrink-0" />
                        }
                        <div className="w-3.5 h-3.5 shrink-0" />
                    </div>
                    <ThinkingShimmer />
                </button>

                {open && hasContent && (
                    <div 
                        ref={scrollRef}
                        className={cn(
                            'mt-2 ml-6 pl-3 border-l border-border',
                            'text-[13px] text-muted-foreground/60 leading-relaxed',
                            'max-h-48 overflow-y-auto scroll-smooth custom-scrollbar',
                        )}
                    >
                        <MarkdownContent 
                            content={block.text!} 
                            className="desktop-markdown-thinking opacity-80"
                        />
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="py-1 my-0.5">
            <button
                onClick={() => setOpen((o) => !o)}
                disabled={!hasContent}
                className={cn(
                    'flex items-center gap-1.5 group select-none text-left w-full',
                    hasContent ? 'cursor-pointer' : 'cursor-default',
                )}
            >
                <div className="flex items-center justify-start shrink-0 w-[24px] gap-1 text-muted-foreground/40">
                    {hasContent ? (
                        open
                            ? <ChevronDown size={10} className="shrink-0" />
                            : <ChevronRight size={10} className="shrink-0" />
                    ) : (
                        <div className="w-[10px] shrink-0" />
                    )}
                    <Brain size={12} strokeWidth={2} className={cn(
                        "shrink-0 transition-colors",
                        hasContent ? 'text-muted-foreground/40 group-hover:text-muted-foreground/60' : 'text-muted-foreground/20'
                    )} />
                </div>
                <span className={cn(
                    'text-[11px] font-bold',
                    hasContent ? 'text-muted-foreground/30 group-hover:text-muted-foreground/50' : 'text-muted-foreground/20',
                    'transition-colors',
                )}>
                    Reasoning · {formatDuration(block.durationMs)}
                </span>
            </button>

            {open && hasContent && (
                <div className={cn(
                    'mt-2 ml-6 pl-3 border-l border-border',
                    'text-[13px] text-muted-foreground/60 leading-relaxed',
                )}>
                    <MarkdownContent 
                        content={block.text!} 
                        className="desktop-markdown-thinking opacity-80"
                    />
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
                className="desktop-markdown break-words [overflow-wrap:anywhere] text-[14px] leading-relaxed text-foreground/85"
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

                if (block.type === 'approval') {
                    return <ApprovalBlockCard key={`approval-${block.id}-${i}`} block={block} />
                }

                if (block.type === 'terminal') {
                    return <TerminalBlockCard key={`terminal-${block.id}-${i}`} block={block} />
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
