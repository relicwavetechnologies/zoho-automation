/**
 * The panel beside the conversation.
 *
 * Three layers, and the boundaries between them are the design:
 *
 *   `ArtifactWorkspace` — where the split is and how wide. Knows nothing about
 *                         documents.
 *   `ArtifactPanel`     — which tabs exist and which one is showing. Knows
 *                         nothing about how any of them draw.
 *   `Surface`           — one kind of thing, drawn.
 *
 * A second kind of thing — a side chat, a dataset, an embedded page — arrives as
 * a new tab kind and a new surface, and neither of the first two layers changes.
 * That is the test; if adding one means editing the workspace, the split was
 * decorative.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Code2, Copy, Eye, FileText, PanelRight, X } from 'lucide-react'
import { Markdown } from '../chat/parts'
import { DocumentSkeleton } from '../chat/loading.view'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import {
  RENDERABLE_MIME, activeTab, closeTab, focusTab, setOpen, setWidth, useArtifacts,
  type ArtifactTab, type Tab,
} from './store'
import { loadArtifactBody } from './open'

/**
 * Below this the split stops being a split — two columns of 300px are two
 * things you cannot read rather than two things you can.
 */
const SPLIT_MIN_PX = 900

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < SPLIT_MIN_PX,
  )
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${SPLIT_MIN_PX - 1}px)`)
    const sync = () => setNarrow(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return narrow
}

export function ArtifactWorkspace({ children }: { children: React.ReactNode }) {
  const { open, tabs, widthPercent } = useArtifacts()
  const narrow = useIsNarrow()
  const [dragging, setDragging] = useState(false)
  const frame = useRef<HTMLDivElement>(null)

  const onDrag = useCallback((event: React.PointerEvent) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    const move = (moved: PointerEvent) => {
      setWidth(((box.right - moved.clientX) / box.width) * 100)
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  const showing = open && tabs.length > 0

  if (narrow) {
    // A sheet over the conversation rather than beside it. Nothing about the
    // panel changes — only where it is put.
    return (
      <div ref={frame} className="bui-scope relative flex h-full min-h-0 w-full">
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
        {showing && (
          <>
            <button
              type="button"
              aria-label="Close document"
              className="absolute inset-0 z-40 bg-black/25"
              onClick={() => setOpen(false)}
            />
            <div className="absolute inset-y-0 right-0 z-50 w-[min(100vw,26rem)] shadow-2xl">
              <ArtifactPanel />
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div ref={frame} className="bui-scope relative flex h-full min-h-0 w-full">
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      {showing && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize document panel"
            onPointerDown={onDrag}
            className="w-px shrink-0 cursor-col-resize bg-line transition-colors hover:bg-ink-3"
          />
          <div
            className="min-h-0 min-w-0 shrink-0"
            style={{ width: `${widthPercent}%` }}
          >
            <ArtifactPanel />
          </div>
          {/*
            While dragging, this sits over everything so the pointer keeps
            reaching the window rather than being swallowed by whatever the
            document happens to contain — a code block's own selection handling
            is enough to lose a drag halfway across the screen.
          */}
          {dragging && <div className="fixed inset-0 z-[100] cursor-col-resize" aria-hidden />}
        </>
      )}
    </div>
  )
}

function ArtifactPanel() {
  const state = useArtifacts()
  const { token } = useAdminAuth()
  const tab = activeTab(state)

  return (
    <aside
      aria-label="Documents"
      className="flex h-full min-h-0 w-full flex-col border-l border-line bg-page"
    >
      <TabStrip tabs={state.tabs} activeId={tab?.id ?? null} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab ? <Surface tab={tab} token={token} /> : null}
      </div>
    </aside>
  )
}

function TabStrip({ tabs, activeId }: { tabs: readonly Tab[]; activeId: string | null }) {
  return (
    <div className="flex h-10 shrink-0 items-stretch gap-1 border-b border-line px-1.5 pt-1.5">
      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId
          return (
            <div
              key={tab.id}
              className={`group flex min-w-0 max-w-[12rem] items-center gap-1 rounded-t-control px-2 ${
                active ? 'bg-surface text-ink shadow-hairline' : 'text-ink-3 hover:bg-fill hover:text-ink'
              }`}
            >
              <button
                type="button"
                onClick={() => focusTab(tab.id)}
                aria-current={active ? 'page' : undefined}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
              >
                <FileText size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{tab.title}</span>
              </button>
              {/*
                Revealed on hover, except on the tab being read.
                A close control on every tab at rest turns a row you glance at
                into a row you have to aim at.
              */}
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={() => closeTab(tab.id)}
                className={`shrink-0 rounded p-0.5 text-ink-3 transition-opacity hover:text-ink group-hover:opacity-100 ${
                  active ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label="Hide documents"
        title="Hide"
        onClick={() => setOpen(false)}
        className="my-auto shrink-0 rounded-control p-1 text-ink-3 hover:bg-fill hover:text-ink"
      >
        <PanelRight size={14} />
      </button>
    </div>
  )
}

/** One kind of thing, drawn. The only place in the panel that knows a kind. */
function Surface({ tab, token }: { tab: Tab; token: string | null }) {
  switch (tab.kind) {
    case 'artifact':
      return <ArtifactSurface tab={tab} token={token} />
    default: {
      const exhaustive: never = tab.kind
      return exhaustive
    }
  }
}

function ArtifactSurface({ tab, token }: { tab: ArtifactTab; token: string | null }) {
  const readable = tab.mime === RENDERABLE_MIME
  const [source, setSource] = useState(!readable)
  const [copied, setCopied] = useState(false)

  // A revision is a different document in the same tab. Reading its source and
  // then having it replaced would leave the reader looking at the old text under
  // a new version number, so the view resets with the body.
  useEffect(() => { setSource(!readable) }, [tab.version, readable])

  /* A restored tab has no body until somebody looks at it. Fetching every one on
     thread open would cost a round trip per document for documents nobody
     opened, so the surface fetches its own the first time it is drawn. */
  useEffect(() => {
    if (tab.body === undefined && !tab.failed) void loadArtifactBody(tab.artifactId, token)
  }, [tab.artifactId, tab.body, tab.failed, token])

  const copy = async () => {
    if (!tab.body) return
    try {
      await navigator.clipboard.writeText(tab.body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch { /* denied clipboard permission; the button simply does nothing */ }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2" role="tablist">
        {readable && (
          <ViewTab on={!source} onClick={() => setSource(false)} icon={<Eye size={12} />} label="Read" />
        )}
        <ViewTab on={source} onClick={() => setSource(true)} icon={<Code2 size={12} />} label="Source" />
        <div className="ml-auto flex items-center gap-1 pr-1">
          {/* The version is here because it is the answer to "is this the one it
              just changed?" — the question a reader asks when a document they
              are reading is rewritten under them mid-run. */}
          {tab.version > 1 && (
            <span className="pr-1 text-[10px] tabular-nums text-ink-3">v{tab.version}</span>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!tab.body}
            aria-label={copied ? 'Copied' : 'Copy document'}
            className="rounded-control p-1.5 text-ink-3 hover:bg-fill hover:text-ink disabled:opacity-40"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab.failed ? (
          <Note>This document could not be loaded. It may have been removed.</Note>
        ) : tab.body === undefined ? (
          <DocumentSkeleton />
        ) : source || !readable ? (
          <>
            {/* A type this build has no renderer for is shown as itself, with a
                reason. Dropping it would hide a document that exists. */}
            {!readable && <Note>Shown as source — this app cannot render {tab.mime} yet.</Note>}
            <pre className="overflow-x-auto px-4 py-4 text-[12px] leading-relaxed text-ink-2">
              <code>{tab.body}</code>
            </pre>
          </>
        ) : (
          <div className="bui-doc px-5 py-5 text-[13.5px] leading-[1.65] text-ink">
            <Markdown>{tab.body}</Markdown>
          </div>
        )}
      </div>
    </div>
  )
}

function ViewTab({ on, onClick, icon, label }: {
  on: boolean; onClick: () => void; icon: React.ReactNode; label: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
        on ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-[13px] leading-relaxed text-ink-3">{children}</p>
}
