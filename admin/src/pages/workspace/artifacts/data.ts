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
}

export type ArtifactDocument = ArtifactSummary & { body: string }

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
