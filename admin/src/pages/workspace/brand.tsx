/**
 * Compatibility names for mail and preview screens.
 * Rendering policy lives in BrandMark; these names only keep call sites clear.
 */
import { BrandMark } from '@/components/admin/brand-mark'

export function GoogleMark({ size = 16 }: { size?: number }) {
  return <BrandMark brand="google" size={size} decorative={false} />
}

export function GmailMark({ size = 16 }: { size?: number }) {
  return <BrandMark brand="gmail" size={size} decorative={false} />
}

export function LarkMark({ size = 16 }: { size?: number }) {
  return <BrandMark brand="lark" size={size} decorative={false} />
}
