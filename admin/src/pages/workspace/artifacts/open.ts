/**
 * The two moments a document reaches the panel.
 *
 * **Live** — a run announces one it has just filed, and it opens now.
 * **On arrival** — a thread is opened and whatever it produced before is put
 * back, quietly, without taking the screen.
 *
 * Kept out of both the store and the chat: the store is state and knows nothing
 * about the network, and the chat is a conversation and should not know how a
 * document is fetched. This is the seam between them, and it is the only file
 * that holds both halves.
 */
import { getArtifact, listArtifacts } from './data'
import { failArtifact, fillArtifact, openArtifact, restoreArtifacts } from './store'

export type ArtifactAnnouncement = {
  readonly artifactId: string
  readonly title: string
  readonly mime: string
  readonly version: number
}

/**
 * Show a document the run has just finished.
 *
 * The tab opens on the announcement and the body follows, rather than the panel
 * waiting for a round trip: the reader is looking at the sentence that mentions
 * the document at exactly the moment this arrives, and a panel that appears a
 * second later reads as one that missed it.
 */
export async function showArtifact(
  announced: ArtifactAnnouncement,
  threadId: string,
  token: string | null,
): Promise<void> {
  openArtifact({
    artifactId: announced.artifactId,
    title: announced.title,
    mime: announced.mime,
    version: announced.version,
    threadId,
  })
  if (!token) return
  const document = await getArtifact(announced.artifactId, token)
  if (document) fillArtifact(document.artifactId, document.version, document.body)
  else failArtifact(announced.artifactId)
}

/** Fetch one tab's body on demand — what the panel calls when it first draws one. */
export async function loadArtifactBody(artifactId: string, token: string | null): Promise<void> {
  if (!token) return
  const document = await getArtifact(artifactId, token)
  if (document) fillArtifact(document.artifactId, document.version, document.body)
  else failArtifact(artifactId)
}

/** Everything a conversation produced before this visit. */
export async function restoreThreadArtifacts(threadId: string, token: string | null): Promise<void> {
  if (!token) return
  const summaries = await listArtifacts(threadId, token)
  restoreArtifacts(
    summaries.map(summary => ({
      artifactId: summary.artifactId,
      title: summary.title,
      mime: summary.mime,
      version: summary.version,
    })),
    threadId,
  )
}
