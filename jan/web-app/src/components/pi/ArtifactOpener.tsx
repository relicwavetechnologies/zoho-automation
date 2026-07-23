import { useEffect, useRef } from 'react'
import type { ThreadMessage } from '@janhq/core'
import {
  artifactOpenKey,
  latestDivoArtifactDetailsForThread,
} from '@/lib/pi/artifact'
import { readArtifactFileContent } from '@/lib/pi/artifact-fs'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'

type ArtifactOpenerProps = {
  messages: ThreadMessage[]
  activeRootId?: string
}

/**
 * Side-effect host: when the agent badges a workspace file via divo_artifact,
 * load that file from disk and open/focus it in the Auxiliary Surface.
 */
export function ArtifactOpener({ messages, activeRootId }: ArtifactOpenerProps) {
  const openArtifact = useAuxiliaryTabs((s) => s.openArtifact)
  const lastKeyRef = useRef<string | null>(null)
  const inFlightRef = useRef<string | null>(null)

  useEffect(() => {
    const details = latestDivoArtifactDetailsForThread(messages, activeRootId)
    if (!details) return

    const key = artifactOpenKey(details)
    if (lastKeyRef.current === key || inFlightRef.current === key) return
    inFlightRef.current = key

    let cancelled = false
    void (async () => {
      try {
        const content = await readArtifactFileContent(details.path)
        if (cancelled) return
        lastKeyRef.current = key
        openArtifact({
          artifactId: details.artifactId,
          title: details.title,
          content,
          mime: details.mime,
          path: details.path,
        })
      } catch (error) {
        console.warn('Failed to open artifact from path', details.path, error)
      } finally {
        if (inFlightRef.current === key) inFlightRef.current = null
      }
    })()

    return () => {
      cancelled = true
    }
  }, [messages, activeRootId, openArtifact])

  return null
}
