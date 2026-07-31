import { useEffect, useRef } from 'react'
import type { ThreadMessage } from '@janhq/core'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'
import { computeActivePath } from '@/lib/message-branching'
import {
  listCompletedFileToolPaths,
  pathsEqual,
  readFileToolPath,
} from '@/lib/pi/artifact'
import { readArtifactFileContent } from '@/lib/pi/artifact-fs'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'
import type { ArtifactTab } from '@/lib/auxiliary/types'
import type { UIMessage } from 'ai'

type ArtifactFileRefreshProps = {
  messages: ThreadMessage[]
  activeRootId?: string
}

function fileToolFingerprint(messages: UIMessage[]): string {
  const keys: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts as Array<{
      type?: string
      toolName?: string
      state?: string
      input?: unknown
    }>) {
      const path = readFileToolPath(part)
      if (!path) continue
      keys.push(`${part.type ?? part.toolName}:${path}:${part.state ?? ''}`)
    }
  }
  return keys.join('|')
}

/**
 * When write/edit completes on a path that already has an open artifact tab,
 * reload that file from disk so the sidebar stays in sync without a re-badge.
 */
export function ArtifactFileRefresh({
  messages,
  activeRootId,
}: ArtifactFileRefreshProps) {
  const openArtifact = useAuxiliaryTabs((s) => s.openArtifact)
  const lastFingerprintRef = useRef<string>('')

  useEffect(() => {
    const uiMessages = convertThreadMessagesToUIMessages(
      computeActivePath(messages, activeRootId)
    )
    const fingerprint = fileToolFingerprint(uiMessages)
    if (!fingerprint || fingerprint === lastFingerprintRef.current) return
    lastFingerprintRef.current = fingerprint

    const paths = listCompletedFileToolPaths(uiMessages)
    if (paths.length === 0) return

    const tabs = useAuxiliaryTabs
      .getState()
      .tabs.filter(
        (t): t is ArtifactTab => t.kind === 'artifact' && Boolean(t.path)
      )
    if (tabs.length === 0) return

    let cancelled = false
    void (async () => {
      for (const path of paths) {
        const tab = tabs.find((t) => t.path && pathsEqual(t.path, path))
        if (!tab?.path) continue
        try {
          const content = await readArtifactFileContent(tab.path)
          if (cancelled) return
          openArtifact({
            artifactId: tab.artifactId,
            title: tab.title,
            content,
            mime: tab.mime,
            path: tab.path,
            language: tab.language,
          })
        } catch (error) {
          console.warn('Failed to refresh artifact from path', tab.path, error)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [messages, activeRootId, openArtifact])

  return null
}
