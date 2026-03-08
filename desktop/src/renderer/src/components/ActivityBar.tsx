import { CheckCircle2, Loader2, XCircle, Search, Globe, FilePen, FileText, Share2, BarChart2, List, UserPlus, Edit, Zap } from 'lucide-react'
import type { ActivityStep } from '../types'
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
    steps: ActivityStep[]
}

function StepIcon({ icon, status }: { icon: string; status: ActivityStep['status'] }) {
    if (status === 'running') {
        return <Loader2 size={11} className="text-[hsl(217,70%,55%)] animate-spin shrink-0" />
    }
    if (status === 'done') {
        return <CheckCircle2 size={11} className="text-[hsl(142,55%,42%)] shrink-0" />
    }
    if (status === 'error') {
        return <XCircle size={11} className="text-[hsl(0,55%,48%)] shrink-0" />
    }
    return <span className="shrink-0 text-[hsl(0,0%,35%)]">{ICON_MAP[icon] ?? <Zap size={11} />}</span>
}

/**
 * ActivityBar — renders the live agentic step feed during streaming.
 * Tool steps are deliberately dim (zinc-500) so the bright AI text stands out.
 */
export function ActivityBar({ steps }: Props): JSX.Element | null {
    if (steps.length === 0) return null

    return (
        <div className="mb-2 flex flex-col gap-[3px]">
            {steps.map((step) => (
                <div
                    key={step.id}
                    className={cn(
                        'flex items-center gap-2 px-2 py-[5px] rounded-md text-xs font-mono',
                        'bg-[hsl(0,0%,6%)] border border-[hsl(0,0%,11%)]',
                        'transition-all duration-300 ease-out',
                    )}
                >
                    <StepIcon icon={step.icon} status={step.status} />
                    <span
                        className={cn(
                            'truncate transition-colors duration-300',
                            step.status === 'running'
                                ? 'text-[hsl(0,0%,42%)]'
                                : step.status === 'done'
                                    ? 'text-[hsl(0,0%,32%)]'
                                    : 'text-[hsl(0,50%,42%)]',
                        )}
                    >
                        {step.label}
                        {step.status === 'running' && (
                            <span className="activity-dot inline-block ml-[2px]">…</span>
                        )}
                    </span>
                </div>
            ))}
        </div>
    )
}

/** ThinkingShimmer — shimmer text shown before the AI produces any output */
export function ThinkingShimmer(): JSX.Element {
    return (
        <div className="pt-1 pb-1">
            <TextShimmer
                className="text-sm font-medium"
                duration={1.8}
                spread={3}
            >
                Thinking...
            </TextShimmer>
        </div>
    )
}
