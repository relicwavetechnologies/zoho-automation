/**
 * What Divo has made, as a row of cards can show it.
 *
 * A document is the one thing on this page that is not a number or a status —
 * it has contents, and the contents are the reason to open it. So a card shows
 * the opening of the file rather than an icon and a date.
 *
 * The text arrives already plain: `domain/artifact/preview.ts` flattens the
 * markup where the body is, because reaching the first word of an HTML document
 * means reading past four thousand characters of stylesheet, and a browser that
 * could do that is a browser holding the document. What is left here is how a
 * card lays those lines out, which is the reader's business and only ever the
 * reader's.
 */
import { useEffect, useState } from 'react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { recentArtifacts, type ArtifactSummary } from '../artifacts/data'

/** How many lines of a document a card has room for. */
export const PREVIEW_LINES = 5

/**
 * What to call a document, in two words, from its type.
 *
 * Unknown types are called "Document" rather than shown raw. A card is not the
 * place somebody learns that a mime type exists, and the store deliberately
 * accepts types this build has no renderer for.
 */
export function kindLabel(mime: string): string {
  if (mime === 'text/html') return 'Page'
  return 'Document'
}

/**
 * The preview, as the lines a card draws.
 *
 * The title is passed in so a document whose first line *is* its title does not
 * spend its thumbnail repeating the name printed directly under it — which is
 * what nearly every generated report does.
 */
export function previewLines(preview: string, title: string, max = PREVIEW_LINES): string[] {
  const lines: string[] = []
  for (const raw of (preview ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // Only the first line, and only when it is the title: a document that says
    // its own name again three paragraphs down is quoting itself, and that is
    // content.
    if (lines.length === 0 && line.toLowerCase() === title.trim().toLowerCase()) continue
    lines.push(line)
    if (lines.length === max) break
  }
  return lines
}

export type MadeItem = {
  readonly artifactId: string
  readonly title: string
  readonly mime: string
  readonly version: number
  readonly threadId?: string
  readonly kind: string
  readonly lines: readonly string[]
  readonly updatedAt: string
  /** True once Divo has been back to it. "v3" is a fact about the work. */
  readonly revised: boolean
}

/** The summaries the route returned, shaped for the band. Order is the route's. */
export function madeItems(summaries: readonly ArtifactSummary[]): MadeItem[] {
  return summaries.map((summary) => ({
    artifactId: summary.artifactId,
    title: summary.title,
    mime: summary.mime,
    version: summary.version,
    ...(summary.threadId ? { threadId: summary.threadId } : {}),
    kind: kindLabel(summary.mime),
    lines: previewLines(summary.preview, summary.title),
    updatedAt: summary.updatedAt,
    revised: summary.version > 1,
  }))
}

/**
 * The last few documents, for whoever is signed in.
 *
 * No polling and no refresh. A document appears while a run is going, and while
 * a run is going the reader is watching it in the chat, where the panel opens on
 * its own — this band is what they find when they come back tomorrow.
 */
export function useMade(limit = 4): { items: MadeItem[]; loading: boolean } {
  const { token } = useAdminAuth()
  const [items, setItems] = useState<MadeItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let live = true
    void (async () => {
      const summaries = await recentArtifacts(token, limit)
      if (!live) return
      setItems(madeItems(summaries))
      setLoading(false)
    })()
    return () => { live = false }
  }, [token, limit])

  return { items, loading }
}
