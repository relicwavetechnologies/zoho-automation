/**
 * How a document of a given type is drawn.
 *
 * A registry rather than a branch inside the surface, because the surface
 * already varies along one axis — loading, failed, source, read — and putting
 * type on the same `if` chain makes it a grid that grows on both sides. Here a
 * new type is one entry, and the surface never learns its name.
 *
 * A type with no entry is not a failure. The store may hold something a newer
 * runtime filed, and the honest answer is the document's own source with a note
 * saying why — never a blank panel, and never dropping it.
 */
import { useEffect, useState } from 'react'
import { Markdown } from '../chat/answer/answer.view'
import { getArtifactDocument, withDocumentTheme } from './data'

export const DOCUMENT_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'
export type DocumentTheme = 'light' | 'dark'

export type DocumentRenderContext = {
  readonly artifactId?: string
  readonly token?: string | null
  readonly version?: number
}

export type DocumentFormat = {
  /**
   * The renderer draws into a fixed-height box and handles its own overflow.
   *
   * True for a frame, which scrolls internally; wrapping one in a scrolling
   * container gives the reader two scrollbars and a document that cannot reach
   * its own end.
   */
  readonly selfScrolling: boolean
  readonly render: (body: string, context?: DocumentRenderContext) => React.ReactNode
}

const FORMATS: Readonly<Record<string, DocumentFormat>> = {
  'text/markdown': {
    selfScrolling: false,
    render: (body) => (
      <div className="bui-doc px-5 py-5 text-[13.5px] leading-[1.65] text-ink">
        <Markdown>{body}</Markdown>
      </div>
    ),
  },
  'text/html': {
    selfScrolling: true,
    render: (_body, context) => (
      <HtmlDocument
        artifactId={context?.artifactId ?? ''}
        token={context?.token ?? null}
        version={context?.version ?? 1}
      />
    ),
  },
}

/** The renderer for a type, or nothing if this build has none. */
export function formatFor(mime: string): DocumentFormat | undefined {
  return FORMATS[mime]
}

/** Every type this build can draw. The skill's promise is checked against it. */
export const RENDERABLE_MIMES: readonly string[] = Object.keys(FORMATS)

function HtmlDocument({
  artifactId,
  token,
  version,
}: {
  readonly artifactId: string
  readonly token: string | null
  readonly version: number
}) {
  const theme = useDocumentTheme()
  const [documentMarkup, setDocumentMarkup] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setDocumentMarkup(null)
    setFailed(false)
    if (!token || !artifactId) {
      setFailed(true)
      return () => { live = false }
    }
    void getArtifactDocument(artifactId, token).then(markup => {
      if (!live) return
      if (markup) setDocumentMarkup(markup)
      else setFailed(true)
    })
    return () => { live = false }
  }, [artifactId, token, version])

  if (failed) return <p className="px-5 py-6 text-[13px] text-ink-3">This document could not be loaded.</p>
  if (!documentMarkup) return <p className="px-5 py-6 text-[13px] text-ink-3">Loading document…</p>
  return (
    <iframe
      title="Document"
      // Without `allow-same-origin` this runs on an opaque origin, which is the
      // control that matters — see the note in `document.ts`.
      sandbox={DOCUMENT_SANDBOX}
      srcDoc={withDocumentTheme(documentMarkup, theme)}
      className="h-full w-full border-0 bg-canvas"
    />
  )
}

/**
 * The theme the app is actually showing, read off the class the theme hook sets.
 *
 * Reading the class rather than calling `useTheme` on purpose: that hook writes
 * to `localStorage` on mount, so a second caller would be a second writer of a
 * setting it only wants to observe. The class is the rendered truth either way.
 */
function useDocumentTheme(): DocumentTheme {
  const [theme, setTheme] = useState<DocumentTheme>(
    () => (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'),
  )

  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      setTheme(root.classList.contains('dark') ? 'dark' : 'light')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return theme
}
