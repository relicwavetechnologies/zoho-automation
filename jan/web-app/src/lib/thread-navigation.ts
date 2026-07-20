/**
 * Decide where the workspace should go after a thread is deleted.
 *
 * A background deletion must never move the user. When the open thread is
 * deleted, stay in the conversation workspace by selecting the most recent
 * surviving thread; Home is only the empty-workspace fallback.
 */
export function getThreadDeletionDestination(
  threads: Thread[],
  deletedThreadId: string,
  activeThreadId?: string
): string | undefined {
  if (activeThreadId !== deletedThreadId) return undefined

  return threads
    .filter((thread) => thread.id !== deletedThreadId)
    .sort((left, right) => (right.updated ?? 0) - (left.updated ?? 0))[0]?.id
}
