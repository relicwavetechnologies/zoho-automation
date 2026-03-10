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
    if (status === 'running') return <Loader2 size={11} className="text-[hsl(217,70%,55%)] animate-spin shrink-0" />
    if (status === 'done') return <CheckCircle2 size={11} className="text-[hsl(142,55%,40%)] shrink-0" />
    if (status === 'failed') return <XCircle size={11} className="text-[hsl(0,55%,48%)] shrink-0" />
    return <span className="text-[hsl(0,0%,35%)]">{ICON_MAP[icon] ?? <Zap size={11} className="shrink-0" />}</span>
}

function ApprovalBlockCard({ block }: { block: Extract<ContentBlock, { type: 'approval' }> }): JSX.Element {
    const { approveCommand, rejectCommand } = useChat()
    const isPending = block.status === 'pending'

    return (
        <div className="my-2 rounded-2xl border border-[hsl(44,52%,24%)] bg-[linear-gradient(180deg,hsl(40,22%,10%),hsl(0,0%,7%))] p-4">
            <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-xl bg-[hsl(44,68%,18%)] p-2 text-[hsl(44,90%,66%)]">
                    <ShieldAlert size={16} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[hsl(0,0%,90%)]">
                        {block.status === 'approved'
                            ? `${block.title} approved`
                            : block.status === 'rejected'
                                ? `${block.title} rejected`
                                : block.title}
                    </div>
                    <div className="mt-1 text-sm text-[hsl(0,0%,58%)]">
                        {block.description}
                    </div>
                    <div className="mt-3 rounded-xl border border-[hsl(0,0%,14%)] bg-[hsl(0,0%,5%)] px-3 py-2 font-mono text-[13px] text-[hsl(0,0%,86%)]">
                        {block.subject}
                    </div>
                    <div className="mt-2 text-[11px] text-[hsl(0,0%,38%)]">
                        {block.footer}
                    </div>

                    {isPending && (
                        <div className="mt-4 flex items-center gap-2">
                            <button
                                onClick={() => void approveCommand(block.id)}
                                className="rounded-xl bg-[hsl(138,67%,48%)] px-3 py-2 text-xs font-medium text-[hsl(0,0%,8%)] hover:bg-[hsl(138,67%,44%)]"
                            >
                                Approve
                            </button>
                            <button
                                onClick={() => rejectCommand(block.id)}
                                className="rounded-xl border border-[hsl(0,0%,18%)] bg-[hsl(0,0%,8%)] px-3 py-2 text-xs font-medium text-[hsl(0,0%,68%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,86%)]"
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

    return (
        <div className="my-2 overflow-hidden rounded-3xl border border-[hsl(0,0%,14%)] bg-[linear-gradient(180deg,hsl(0,0%,18%),hsl(0,0%,12%))] shadow-[0_14px_40px_rgba(0,0,0,0.28)]">
            <div className="border-b border-[hsl(0,0%,14%)] px-5 py-3">
                <div className="text-[12px] font-medium text-[hsl(0,0%,72%)]">Shell</div>
            </div>
            <div className="px-5 py-4 font-mono text-[14px] leading-8 text-[hsl(0,0%,92%)]">
                <div className="mb-4 whitespace-pre-wrap break-words">$ {block.command}</div>
                {output ? (
                    <pre className="whitespace-pre-wrap break-words text-[hsl(0,0%,70%)]">{output}</pre>
                ) : (
                    <div className="flex items-center gap-2 text-[hsl(0,0%,44%)]">
                        {block.status === 'running' ? <Loader2 size={14} className="animate-spin" /> : <TerminalSquare size={14} />}
                        <span>{block.status === 'running' ? 'Waiting for output...' : 'No output'}</span>
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between px-5 pb-3 text-[12px] text-[hsl(0,0%,46%)]">
                <span className="truncate">{block.cwd}</span>
                <div className="flex items-center gap-3">
                    {block.status === 'running' && (
                        <button
                            onClick={() => void killCommand(block.id)}
                            className="shrink-0 rounded-lg border border-[hsl(0,0%,18%)] px-2.5 py-1 text-[11px] font-medium text-[hsl(0,0%,72%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,90%)]"
                        >
                            Stop
                        </button>
                    )}
                    <span className="shrink-0">{footerLabel}</span>
                </div>
            </div>
        </div>
    )
}

// ── Tool block row ────────────────────────────────────────────────────────────
function ToolBlockRow({ block }: { block: Extract<ContentBlock, { type: 'tool' }> }): JSX.Element {
    const [open, setOpen] = useState(false)
    const isRunning = block.status === 'running'
    const hasSummary = !!block.resultSummary && !isRunning

    // Check if result summary is our structured search JSON
    let structuredData: any = null
    if (hasSummary) {
        try {
            const parsed = JSON.parse(block.resultSummary!)
            if (parsed.type === 'structured_search') {
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
        return (
            <div className="py-1 my-0.5 flex flex-col items-start w-full">
                <button
                    onClick={() => setOpen((o) => !o)}
                    className={cn(
                        'flex items-center gap-1.5 group select-none text-left w-full',
                        'transition-colors cursor-pointer'
                    )}
                >
                    <div className="flex items-center justify-start shrink-0 w-[28px] gap-1.5 text-[hsl(0,0%,35%)]">
                        {open
                            ? <ChevronDown size={11} className="text-[hsl(0,0%,35%)] shrink-0 transition-transform" />
                            : <ChevronRight size={11} className="text-[hsl(0,0%,35%)] shrink-0 transition-transform" />
                        }
                        <ToolIcon icon={block.icon} status={block.status} />
                    </div>

                    <span className="text-xs font-mono text-[hsl(0,0%,35%)] group-hover:text-[hsl(0,0%,45%)] transition-colors mr-2">
                        {displayLabel}
                    </span>

                    <span className="text-xs font-medium text-[hsl(0,0%,25%)] group-hover:text-[hsl(0,0%,35%)] transition-colors">
                        — Reviewed {sourcesCount} sources
                    </span>
                </button>

                {open && sourcesCount > 0 && (
                    <div className={cn(
                        'mt-2 w-[90%] max-w-[600px] border border-[hsl(0,0%,12%)] rounded-xl',
                        'bg-[hsl(0,0%,6%)] overflow-hidden flex flex-col',
                    )}>
                        {structuredData.sources.map((src: any, idx: number) => {
                            let domain = ''
                            try { domain = new URL(src.url).hostname.replace('www.', '') } catch (e) { }

                            // A simple deterministic color for the fallback icon based on domain length
                            const hue = (domain.length * 25) % 360;

                            return (
                                <a
                                    key={idx}
                                    href={src.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-[hsl(0,0%,10%)] border-b border-[hsl(0,0%,10%)] last:border-b-0 transition-colors"
                                >
                                    {/* Simulated Google Favicon proxy or generic initial dot */}
                                    <div
                                        className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white overflow-hidden"
                                        style={{ backgroundColor: `hsl(${hue}, 60%, 40%)` }}
                                    >
                                        <img
                                            src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
                                            className="w-full h-full object-cover"
                                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                            alt=""
                                        />
                                        <span className="absolute mix-blend-difference">{domain[0]?.toUpperCase() || 'S'}</span>
                                    </div>
                                    <span className="text-[13px] text-[hsl(0,0%,70%)] truncate flex-1 font-medium">{src.title || src.url}</span>
                                    <span className="text-[11px] text-[hsl(0,0%,40%)] shrink-0">{domain}</span>
                                </a>
                            )
                        })}
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
                <div className="flex items-center justify-start shrink-0 w-[28px] gap-1.5">
                    {hasSummary ? (
                        open
                            ? <ChevronDown size={11} className="text-[hsl(0,0%,35%)] shrink-0 transition-transform" />
                            : <ChevronRight size={11} className="text-[hsl(0,0%,35%)] shrink-0 transition-transform" />
                    ) : (
                        <div className="w-[11px] shrink-0" />
                    )}
                    <ToolIcon icon={block.icon} status={block.status} />
                </div>

                {isRunning ? (
                    <TextShimmer className="text-xs font-mono font-medium" duration={1.5} spread={2}>
                        {displayLabel}
                    </TextShimmer>
                ) : (
                    <span className={cn(
                        'text-xs font-mono truncate transition-colors',
                        block.status === 'done'
                            ? (hasSummary ? 'text-[hsl(0,0%,35%)] group-hover:text-[hsl(0,0%,45%)]' : 'text-[hsl(0,0%,35%)]')
                            : 'text-[hsl(0,50%,45%)]',
                    )}>
                        {displayLabel}
                    </span>
                )}
            </button>

            {open && hasSummary && (
                <div className={cn(
                    'mt-1.5 ml-[32px] pl-3 border-l border-[hsl(0,0%,12%)]',
                    'desktop-markdown text-[12px] text-[hsl(0,0%,60%)] leading-relaxed',
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
    // While live: auto-open to show streaming reasoning
    // When finalized: auto-collapse (user can re-open to read)
    const [open, setOpen] = useState(!!isLive)
    const hasContent = !!block.text

    // Auto-collapse when thinking finishes (live → finalized transition)
    useEffect(() => {
        if (!isLive) setOpen(false)
    }, [isLive])

    if (isLive) {
        return (
            <div className="py-1 my-0.5">
                <button
                    onClick={() => setOpen((o) => !o)}
                    className="flex items-center gap-1.5 group select-none cursor-pointer text-left w-full"
                >
                    <div className="flex items-center justify-start shrink-0 w-[28px] gap-1.5">
                        {open
                            ? <ChevronDown size={11} className="text-[hsl(0,0%,22%)] shrink-0" />
                            : <ChevronRight size={11} className="text-[hsl(0,0%,22%)] shrink-0" />
                        }
                        {/* Spacing placeholder to match ToolIcon width (w-3.5) */}
                        <div className="w-3.5 h-3.5 shrink-0" />
                    </div>
                    <ThinkingShimmer />
                </button>

                {open && hasContent && (
                    <div className={cn(
                        'mt-1.5 ml-4 pl-3 border-l border-[hsl(0,0%,12%)]',
                        'text-[11px] text-[hsl(0,0%,28%)] font-mono leading-relaxed',
                        'whitespace-pre-wrap max-h-48 overflow-y-auto',
                    )}>
                        {block.text}
                    </div>
                )}
            </div>
        )
    }

    // Finalized — show collapsible "Thought for Xs"
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
                <div className="flex items-center justify-start shrink-0 w-[28px] gap-1.5">
                    {hasContent ? (
                        open
                            ? <ChevronDown size={11} className="text-[hsl(0,0%,28%)] shrink-0 transition-transform" />
                            : <ChevronRight size={11} className="text-[hsl(0,0%,28%)] shrink-0 transition-transform" />
                    ) : (
                        <div className="w-[11px] shrink-0" />
                    )}
                    {/* Brain icon instead of placeholder space */}
                    <Brain size={13} strokeWidth={2.5} className={cn(
                        "shrink-0 transition-colors",
                        hasContent ? 'text-[hsl(0,0%,32%)] group-hover:text-[hsl(0,0%,42%)]' : 'text-[hsl(0,0%,22%)]'
                    )} />
                </div>
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
