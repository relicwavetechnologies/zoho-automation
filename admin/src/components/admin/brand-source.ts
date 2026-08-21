import { buildLogoDevUrl, type BrandKey } from './brand-catalog'

export type LocalBrandSource = 'asset' | 'component' | null

/**
 * Bundled product marks are authoritative. Remote logo services are useful for
 * brands we do not carry locally, but they must not replace a known good mark.
 */
export function remoteBrandLogoUrl(
  brand: BrandKey,
  token: string,
  size: number,
  localSource: LocalBrandSource,
): string | null {
  if (localSource) return null
  return buildLogoDevUrl(brand, token, size)
}
