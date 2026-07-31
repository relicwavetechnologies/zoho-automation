import type { AuxiliaryTab } from '@/lib/auxiliary/types'
import { ArtifactSurface } from './surfaces/ArtifactSurface'
import { SideChatSurface } from './surfaces/SideChatSurface'

export function AuxiliarySurfaceRouter({ tab }: { tab: AuxiliaryTab }) {
  switch (tab.kind) {
    case 'artifact':
      return <ArtifactSurface tab={tab} />
    case 'sideChat':
      return <SideChatSurface tab={tab} />
    default: {
      const _exhaustive: never = tab
      return _exhaustive
    }
  }
}
