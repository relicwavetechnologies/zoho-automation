/* eslint-disable react-refresh/only-export-components */
import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import {
  SparklesIcon,
  ChevronDownIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  SearchIcon,
  ExternalLinkIcon,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Streamdown } from 'streamdown'
import { Shimmer } from './shimmer'

// ── Types ──────────────────────────────────────────────────────────────────

export type ChainOfThoughtStepStatus = 'complete' | 'active' | 'pending'

// ── Streaming status label helpers ─────────────────────────────────────────

/**
 * Derive the human tool name from a tool part type, mirroring ToolHeader so the
 * rolling status label matches the "Used {tool}" copy in the expanded trace.
 */
export const toolTypeToName = (toolType: string): string =>
  toolType.split('-').slice(1).join('-').replaceAll('_', ' ')

/** Short, calm status shown while a tool step is the current one. */
export const toolStatusLabel = (toolType: string): string =>
  `Using ${toolTypeToName(toolType) || 'tool'}…`

// ── RollingStatus ───────────────────────────────────────────────────────────

export type RollingStatusProps = {
  /** The current status line. Changing it rolls the old line up and the new in. */
  label: string
}

/**
 * A single-line status that rolls: the current line slides up and out as the
 * next slides in from below, with a shimmer on the live line. Keys on `label`
 * so identical consecutive labels don't re-animate.
 */
export const RollingStatus = memo(({ label }: RollingStatusProps) => (
  <span className="relative flex-1 min-w-0 h-5 overflow-hidden block">
    <AnimatePresence initial={false}>
      <motion.span
        key={label}
        initial={{ y: '110%', opacity: 0 }}
        animate={{ y: '0%', opacity: 1 }}
        exit={{ y: '-110%', opacity: 0 }}
        transition={{ duration: 0.42, ease: [0.22, 0.61, 0.36, 1] }}
        className="absolute inset-0 flex items-center"
      >
        <Shimmer as="span" duration={2} className="capitalize truncate">
          {label}
        </Shimmer>
      </motion.span>
    </AnimatePresence>
  </span>
))

RollingStatus.displayName = 'RollingStatus'

// ── Context ────────────────────────────────────────────────────────────────

type ChainOfThoughtContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  isStreaming: boolean
  duration: number | undefined
}

const MS_IN_S = 1000

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(
  null
)

export const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext)
  if (!context) {
    throw new Error(
      'ChainOfThought components must be used within ChainOfThought'
    )
  }
  return context
}

// ── ChainOfThought (root) ──────────────────────────────────────────────────

export type ChainOfThoughtProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
  /** When true the collapsible auto-collapses (e.g. text content appeared after this CoT group). */
  shouldCollapse?: boolean
  /** When true the collapsible is forced open and overrides auto-collapse (e.g. a tool is awaiting approval). */
  forceOpen?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export const ChainOfThought = memo(
  ({
    className,
    isStreaming = false,
    shouldCollapse = false,
    forceOpen = false,
    open,
    defaultOpen = true,
    onOpenChange,
    children,
    ...props
  }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    })

    // Auto-collapse once text content appears after this CoT group, unless
    // something inside still needs the user's attention (forceOpen).
    useEffect(() => {
      if (forceOpen) {
        setIsOpen(true)
      } else if (shouldCollapse) {
        setIsOpen(false)
      }
    }, [forceOpen, shouldCollapse, setIsOpen])

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen)
    }

    const [startTime, setStartTime] = useState<number | null>(null)
    const [duration, setDuration] = useState<number | undefined>(undefined)

    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now())
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S))
        setStartTime(null)
      }
    }, [isStreaming, startTime])

    const contextValue = useMemo(
      () => ({ isStreaming, isOpen, setIsOpen, duration }),
      [isStreaming, isOpen, setIsOpen, duration]
    )

    return (
      <ChainOfThoughtContext.Provider value={contextValue}>
        <Collapsible
          className={cn('not-prose', className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ChainOfThoughtContext.Provider>
    )
  }
)

// ── ChainOfThoughtHeader ───────────────────────────────────────────────────

export type ChainOfThoughtHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  title?: string
  /** Label shown while streaming, e.g. "Working...". Defaults to "Reasoning...". */
  streamingLabel?: string
  /**
   * Live, per-step status shown while streaming. When provided, it rolls
   * (current line up, next in) in place of the static `streamingLabel`.
   */
  statusLabel?: string
  /** Past-tense verb for the completed state, e.g. "Worked". Defaults to "Thought". */
  completedVerb?: string
}

export const ChainOfThoughtHeader = memo(
  ({
    className,
    title,
    streamingLabel = 'Reasoning...',
    statusLabel,
    completedVerb = 'Thought',
    children,
    ...props
  }: ChainOfThoughtHeaderProps) => {
    const { isStreaming, isOpen, duration } = useChainOfThought()
    const streaming = isStreaming || duration === 0

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <SparklesIcon className="size-4 shrink-0" />
            {streaming ? (
              statusLabel ? (
                <RollingStatus label={statusLabel} />
              ) : (
                <Shimmer duration={1}>{streamingLabel}</Shimmer>
              )
            ) : title ? (
              <p>{title}</p>
            ) : duration === undefined ? (
              <p>{completedVerb} for a few seconds</p>
            ) : (
              <p>
                {completedVerb} for {duration} seconds
              </p>
            )}
            <ChevronDownIcon
              className={cn(
                'size-4 shrink-0 transition-transform',
                isOpen ? 'rotate-180' : 'rotate-0'
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    )
  }
)

// ── ChainOfThoughtContent ──────────────────────────────────────────────────

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>

export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => (
    <CollapsibleContent
      className={cn(
        'mt-4 text-sm relative',
        'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
        className
      )}
      {...props}
    >
      <div className="ml-2 pl-4 border-l-2 border-dotted space-y-3">
        {children}
      </div>
    </CollapsibleContent>
  )
)

// ── ChainOfThoughtText ─────────────────────────────────────────────────────

export type ChainOfThoughtTextProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string
}

export const ChainOfThoughtText = memo(
  ({ className, children, ...props }: ChainOfThoughtTextProps) => (
    <CollapsibleContent
      className={cn(
        'mt-4 text-sm relative',
        'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
        className
      )}
      {...props}
    >
      <div className="ml-2 pl-4 border-l-2 border-dotted">
        <Streamdown animate={true} animationDuration={500}>
          {children}
        </Streamdown>
      </div>
    </CollapsibleContent>
  )
)

// ── ChainOfThoughtStep ─────────────────────────────────────────────────────

export type ChainOfThoughtStepProps = ComponentProps<'div'> & {
  icon?: ReactNode
  label: string
  status: ChainOfThoughtStepStatus
}

const statusIcons: Record<ChainOfThoughtStepStatus, ReactNode> = {
  complete: <CheckCircle2Icon className="size-4 text-green-500 shrink-0" />,
  active: (
    <CircleDotIcon className="size-4 text-blue-500 animate-pulse shrink-0" />
  ),
  pending: <CircleIcon className="size-4 text-muted-foreground/50 shrink-0" />,
}

export const ChainOfThoughtStep = memo(
  ({ className, icon, label, status, children, ...props }: ChainOfThoughtStepProps) => (
    <div
      className={cn(
        'flex flex-col gap-2',
        className
      )}
      {...props}
    >
      <div className="flex items-start gap-2">
        {icon ?? statusIcons[status]}
        <span
          className={cn(
            'text-sm leading-snug',
            status === 'active' && 'text-foreground',
            status === 'pending' && 'text-muted-foreground/50'
          )}
        >
          {label}
        </span>
      </div>
      {children && <div className="ml-6">{children}</div>}
    </div>
  )
)

// ── ChainOfThoughtSearchResults ────────────────────────────────────────────

export type ChainOfThoughtSearchResultsProps = ComponentProps<'div'> & {
  title?: string
}

export const ChainOfThoughtSearchResults = memo(
  ({
    className,
    title,
    children,
    ...props
  }: ChainOfThoughtSearchResultsProps) => (
    <div className={cn('space-y-1.5', className)} {...props}>
      {title && (
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {title}
        </h4>
      )}
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
)

// ── ChainOfThoughtSearchResult ─────────────────────────────────────────────

export type ChainOfThoughtSearchResultProps = ComponentProps<'a'>

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, href, ...props }: ChainOfThoughtSearchResultProps) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
        className
      )}
      {...props}
    >
      <SearchIcon className="size-3 shrink-0" />
      <span className="truncate max-w-[200px]">{children}</span>
      <ExternalLinkIcon className="size-3 shrink-0 opacity-50" />
    </a>
  )
)

// ── ChainOfThoughtImage ────────────────────────────────────────────────────

export type ChainOfThoughtImageProps = ComponentProps<'figure'> & {
  caption?: string
  children: ReactNode
}

export const ChainOfThoughtImage = memo(
  ({ className, caption, children, ...props }: ChainOfThoughtImageProps) => (
    <figure className={cn('space-y-1.5', className)} {...props}>
      {children}
      {caption && (
        <figcaption className="text-xs text-muted-foreground text-center">
          {caption}
        </figcaption>
      )}
    </figure>
  )
)

// ── Display names ──────────────────────────────────────────────────────────

ChainOfThought.displayName = 'ChainOfThought'
ChainOfThoughtHeader.displayName = 'ChainOfThoughtHeader'
ChainOfThoughtContent.displayName = 'ChainOfThoughtContent'
ChainOfThoughtText.displayName = 'ChainOfThoughtText'
ChainOfThoughtStep.displayName = 'ChainOfThoughtStep'
ChainOfThoughtSearchResults.displayName = 'ChainOfThoughtSearchResults'
ChainOfThoughtSearchResult.displayName = 'ChainOfThoughtSearchResult'
ChainOfThoughtImage.displayName = 'ChainOfThoughtImage'
