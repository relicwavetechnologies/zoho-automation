/**
 * Reading a document back from the store the run filed it in.
 *
 * Two calls and nothing else. The panel never reads a filesystem, because there
 * is not one on this side — the desktop app opens the file the container wrote,
 * and the browser opens the copy the badge tool lifted out of it. That single
 * difference is the whole of what the web port had to replace.
 *
 * `/api/artifacts`, not `/api/desktop/artifacts`: the route is named for the
 * resource because both callers — this panel and the container that wrote the
 * document — are the same signed-in member, and neither of them is a desktop.
 */
import { API_BASE_URL } from '@/lib/api-base'

export type ArtifactSummary = {
  artifactId: string
  title: string
  mime: string
  version: number
  threadId?: string
  createdAt: string
  updatedAt: string
  publishedUrl?: string
  publishedAt?: string
  publishDeploymentId?: string
  /**
   * The opening of the document, cut by the server.
   *
   * A list of titles alone makes somebody open four things to find the one they
   * meant. This is enough to recognise a document by and far too little to read
   * one from — the panel is still the only place a document is shown.
   */
  preview: string
}

export type ArtifactDocument = ArtifactSummary & { body: string }

export function withDocumentTheme(markup: string, theme: 'light' | 'dark'): string {
  return markup.replace(
    /(<html\b[^>]*\bdata-theme=")([^"]*)(")/i,
    `$1${theme}$3`,
  )
}

export type PublishedArtifact = { url: string }

const base = `${API_BASE_URL}/api/artifacts`

async function read<T>(url: string, token: string, key: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) return null
    const payload = await response.json() as Record<string, unknown>
    return (payload[key] as T | undefined) ?? null
  } catch {
    // A document that will not load is reported by the panel, in the panel.
    // There is nothing useful to say about it from here.
    return null
  }
}

export function getArtifact(artifactId: string, token: string): Promise<ArtifactDocument | null> {
  return read<ArtifactDocument>(`${base}/${encodeURIComponent(artifactId)}`, token, 'artifact')
}

/**
 * The finished page, wrapped by the backend and ready for the frame.
 *
 * `read` already returns the value at the key, so what comes back here is the
 * markup itself. Naming a `{ document: string }` type and unwrapping a second
 * time returned `undefined` for every document ever fetched, and the panel
 * reported that as "could not be loaded" — a failure that looked like the
 * network and was a shape.
 */
export function getArtifactDocument(artifactId: string, token: string): Promise<string | null> {
  return read<string>(
    `${base}/${encodeURIComponent(artifactId)}/document`,
    token,
    'document',
  )
}

/**
 * Everything this conversation produced.
 *
 * Read when a thread is opened, so a reader coming back tomorrow finds the
 * documents rather than only the sentence that mentioned them. The live stream
 * covers the run they are watching; this covers every run before it.
 */
export async function listArtifacts(threadId: string, token: string): Promise<ArtifactSummary[]> {
  const found = await read<ArtifactSummary[]>(
    `${base}?threadId=${encodeURIComponent(threadId)}`,
    token,
    'artifacts',
  )
  return found ?? []
}

/**
 * The last few things this person has made, whatever conversation made them.
 *
 * The same route without the thread filter, which is the whole of the
 * difference: an artifact belongs to the member, and the thread it came out of
 * is a fact about it rather than the way in. That is what lets a landing page
 * show them without knowing anything about chats.
 */
export async function recentArtifacts(token: string, limit: number): Promise<ArtifactSummary[]> {
  const found = await read<ArtifactSummary[]>(`${base}?limit=${limit}`, token, 'artifacts')
  return found ?? []
}

export async function publishArtifact(artifactId: string, token: string): Promise<PublishedArtifact> {
  const response = await fetch(`${base}/${encodeURIComponent(artifactId)}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const payload = await response.json().catch(() => ({})) as {
    publication?: { url?: unknown }
    message?: unknown
  }
  if (!response.ok || typeof payload.publication?.url !== 'string') {
    throw new Error(typeof payload.message === 'string' ? payload.message : 'Could not publish document')
  }
  return { url: payload.publication.url }
}
