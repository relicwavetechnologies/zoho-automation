import { FileCode2Icon } from 'lucide-react'
import type { UIMessage } from 'ai'
import {
  basenamePath,
  isArtifactUpdateInMessage,
  listDivoArtifactDetails,
} from '@/lib/pi/artifact'
import { readArtifactFileContent } from '@/lib/pi/artifact-fs'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'
import { cn } from '@/lib/utils'

type ArtifactLinksProps = {
  message: UIMessage
  className?: string
}

/**
 * Post-answer chips for files badged during this assistant turn.
 * Click reloads from disk and opens/focuses the Auxiliary Surface.
 */
export function ArtifactLinks({ message, className }: ArtifactLinksProps) {
  const openArtifact = useAuxiliaryTabs((s) => s.openArtifact)
  const artifacts = listDivoArtifactDetails(message)

  if (artifacts.length === 0) return null

  const anyUpdate = artifacts.some((a) => isArtifactUpdateInMessage(message, a))
  const label = anyUpdate && artifacts.length === 1 ? 'Updated' : 'Created'

  return (
    <div
      className={cn('mt-3 flex flex-wrap items-center gap-2', className)}
      data-testid="artifact-links"
    >
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {artifacts.map((artifact) => {
        const updated = isArtifactUpdateInMessage(message, artifact)
        return (
          <button
            key={artifact.artifactId}
            type="button"
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/80',
              'bg-muted/40 px-2 py-1 text-left text-xs text-foreground',
              'transition-colors hover:border-violet-500/40 hover:bg-violet-500/10'
            )}
            title={`${updated ? 'Updated' : 'Open'} ${basenamePath(artifact.path)}`}
            onClick={() => {
              void (async () => {
                try {
                  const content = await readArtifactFileContent(artifact.path)
                  openArtifact({
                    artifactId: artifact.artifactId,
                    title: artifact.title,
                    content,
                    mime: artifact.mime,
                    path: artifact.path,
                  })
                } catch (error) {
                  console.warn(
                    'Failed to open artifact from path',
                    artifact.path,
                    error
                  )
                }
              })()
            }}
          >
            <FileCode2Icon className="size-3.5 shrink-0 text-violet-400" />
            <span className="truncate">{artifact.title}</span>
            <span className="truncate text-muted-foreground">
              {basenamePath(artifact.path)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
