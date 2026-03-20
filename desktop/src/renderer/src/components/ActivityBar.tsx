import { CheckCircle2, Loader2, XCircle, Search, Globe, FilePen, FileText, Share2, BarChart2, List, UserPlus, Edit, Zap } from 'lucide-react'
import { cn } from '../lib/utils'
import TextShimmer from './TextShimmer'

const ICON_MAP: Record<string, React.ReactNode> = {
    'search': <Search size={11} />,
    'globe': <Globe size={11} />,
    'file-text': <FileText size={11} />,
    'file-pen': <FilePen size={11} />,
    'share-2': <Share2 size={11} />,
    'bar-chart-2': <BarChart2 size={11} />,
    'list': <List size={11} />,
    'user-plus': <UserPlus size={11} />,
    'edit': <Edit size={11} />,
    'zap': <Zap size={11} />,
}

interface Props {
    steps: { id: string; icon: string; label: string; status: 'running' | 'done' | 'error' }[]
}

function StepIcon({ icon, status }: { icon: string; status: 'running' | 'done' | 'error' }) {
    if (status === 'running') {
        return <Loader2 size={11} className="text-primary/60 animate-spin shrink-0" />
    }
    if (status === 'done') {
        return <CheckCircle2 size={11} className="text-emerald-500/50 shrink-0" />
    }
    if (status === 'error') {
        return <XCircle size={11} className="text-red-500/50 shrink-0" />
    }
    return <span className="shrink-0 text-muted-foreground/30">{ICON_MAP[icon] ?? <Zap size={11} />}</span>
}

/**
 * ActivityBar — renders the live agentic step feed during streaming.
 * Tool steps are deliberately dim so the bright AI text stands out.
 */
export function ActivityBar({ steps }: Props): JSX.Element | null {
    if (steps.length === 0) return null

    return (
        <div className="mb-2 flex flex-col gap-1 ml-1">
            {steps.map((step) => {
                const isRunning = step.status === 'running'
                return (
                    <div
                        key={step.id}
                        className="flex items-center gap-2 py-0.5"
                    >
                        <StepIcon icon={step.icon} status={step.status} />

                        {isRunning ? (
                            <TextShimmer className="text-[11px] font-medium text-primary/60" duration={1.5} spread={2}>
                                {step.label}
                            </TextShimmer>
                        ) : (
                            <span
                                className={cn(
                                    'text-[11px] font-medium truncate transition-colors duration-300',
                                    step.status === 'done'
                                        ? 'text-muted-foreground/40'
                                        : 'text-red-500/40',
                                )}
                            >
                                {step.label}
                            </span>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

/** ThinkingShimmer — shimmer text shown before the AI produces any output */
export function ThinkingShimmer({ label = 'Reasoning...' }: { label?: string }): JSX.Element {
    return (
        <div className="pt-0.5 pb-0.5">
            <TextShimmer
                className="text-[11px] font-bold text-muted-foreground/30"
                duration={1.8}
                spread={3}
            >
                {label}
            </TextShimmer>
        </div>
    )
}
