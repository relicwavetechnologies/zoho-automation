import { useState, type ComponentProps, type ComponentType, type ReactNode, type SVGProps } from 'react'
import {
  GmailIcon, GoogleAppsScriptIcon, GoogleCalendarIcon,
  GoogleChatIcon, GoogleContactsIcon, GoogleDocsIcon, GoogleDriveIcon, GoogleFormsIcon,
  GoogleIcon, GoogleSheetsIcon, GoogleSlidesIcon, GoogleTasksIcon, LarkIcon, ZohoIcon,
} from '@/components/brand-icons'
import { API_BASE_URL } from '@/lib/api-base'
import { logoDevPublishableKey } from '@/lib/runtime-config'
import { BRAND_CATALOG, type BrandKey } from './brand-catalog'
import { remoteBrandLogoUrl, type LocalBrandSource } from './brand-source'
import { remoteImageLayers, remoteImagePhase, type RemoteImagePhase, type RemoteImageState } from './remote-image'

type SvgMark = ComponentType<SVGProps<SVGSVGElement>>

/**
 * Tracks one remote image by URL, so a late event from an old URL cannot mark
 * the current image as loaded. The fallback is allowed to remain visible while
 * the image loads, but the caller must remove it once `phase` becomes `shown`.
 */
function useRemoteImage(src: string | null): {
  phase: RemoteImagePhase | 'disabled'
  onLoad: () => void
  onError: () => void
} {
  const [state, setState] = useState<RemoteImageState>(null)
  const phase = remoteImagePhase(src, state)

  return {
    phase,
    onLoad: () => {
      if (src) setState({ src, phase: 'shown' })
    },
    onError: () => {
      if (src) setState({ src, phase: 'failed' })
    },
  }
}

type RemoteImageProps = {
  src: string | null
  fallback: ReactNode
  width: number
  height: number
  className: string
  referrerPolicy: ComponentProps<'img'>['referrerPolicy']
}

/**
 * One remote-image policy for product marks and site icons. The fallback and a
 * successfully loaded remote image are mutually exclusive; opacity only hides
 * the remote image while it loads and never leaves two logos visible together.
 */
function RemoteImage({ src, fallback, width, height, className, referrerPolicy }: RemoteImageProps) {
  const remoteImage = useRemoteImage(src)
  const layers = remoteImageLayers(src, remoteImage.phase)
  return (
    <>
      {layers.showFallback ? fallback : null}
      {layers.showRemote && src ? (
        <img
          key={src}
          src={src}
          alt=""
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          referrerPolicy={referrerPolicy}
          onLoad={remoteImage.onLoad}
          onError={remoteImage.onError}
          className={className}
          style={{ opacity: remoteImage.phase === 'shown' ? 1 : 0 }}
        />
      ) : null}
    </>
  )
}

const LOCAL_FALLBACK: Partial<Record<BrandKey, SvgMark>> = {
  google: GoogleIcon,
  gmail: GmailIcon,
  googleSheets: GoogleSheetsIcon,
  googleDrive: GoogleDriveIcon,
  googleCalendar: GoogleCalendarIcon,
  googleDocs: GoogleDocsIcon,
  googleSlides: GoogleSlidesIcon,
  googleForms: GoogleFormsIcon,
  googleTasks: GoogleTasksIcon,
  googleContacts: GoogleContactsIcon,
  googleChat: GoogleChatIcon,
  googleAppsScript: GoogleAppsScriptIcon,
  lark: LarkIcon,
  zoho: ZohoIcon,
  zohoBooks: ZohoIcon,
  zohoCrm: ZohoIcon,
}

const LOCAL_ASSET: Partial<Record<BrandKey, string>> = {
  canva: '/brand/canva.png',
  airtable: '/brand/airtable.png',
  aitable: '/brand/aitable.png',
  zoho: '/brand/zoho.png',
  zohoBooks: '/brand/zoho.png',
  zohoCrm: '/brand/zoho.png',
  semrush: '/brand/semrush.png',
  shopify: '/brand/shopify.png',
}

type BrandMarkProps = {
  brand: BrandKey
  size?: number
  placement?: 'inline' | 'tile'
  className?: string
  dim?: boolean
  decorative?: boolean
}

/**
 * The one rendering boundary for third-party product and company identity.
 * Callers name a brand and a placement; this module owns source choice,
 * dimensions, loading, accessibility, and a local/monogram failure state.
 */
export function BrandMark({
  brand, size = 16, placement = 'inline', className = '', dim = false, decorative = true,
}: BrandMarkProps) {
  const definition = BRAND_CATALOG[brand]
  const glyphSize = placement === 'tile' && !definition.fullBleed ? Math.round(size * 0.62) : size
  const Fallback = LOCAL_FALLBACK[brand]
  const fallbackAsset = LOCAL_ASSET[brand]
  const localSource: LocalBrandSource = fallbackAsset ? 'asset' : Fallback ? 'component' : null
  const token = localSource ? '' : logoDevPublishableKey()
  const src = remoteBrandLogoUrl(brand, token, Math.max(glyphSize, 32), localSource)
  const label = decorative ? undefined : definition.label

  const fallback = fallbackAsset
    ? <img src={fallbackAsset} alt="" width={glyphSize} height={glyphSize} className="block h-full w-full object-contain" />
    : Fallback
      ? <Fallback width={glyphSize} height={glyphSize} className="block h-full w-full" aria-hidden />
      : (
        <span className="grid h-full w-full place-items-center rounded-[3px] bg-secondary text-[0.55em] font-medium text-muted-foreground">
          {definition.short}
        </span>
      )

  const mark = (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden ${dim ? 'opacity-70 transition-opacity duration-100 group-hover:opacity-100' : ''} ${className}`}
      style={{ width: glyphSize, height: glyphSize }}
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : 'img'}
      aria-label={label}
    >
      <RemoteImage
        src={src}
        fallback={fallback}
        width={glyphSize}
        height={glyphSize}
        referrerPolicy="origin"
        className="absolute inset-0 h-full w-full object-contain"
      />
    </span>
  )

  if (placement === 'inline') return mark
  return (
    <span
      className="ws-app"
      data-plain="true"
      data-fill={definition.fullBleed ? 'true' : undefined}
      style={{ ['--ws-app' as string]: `${size}px` }}
      aria-hidden={decorative || undefined}
    >
      {mark}
    </span>
  )
}

/** Arbitrary websites stay behind Divo's favicon proxy; Logo.dev sees known brands only. */
export function SiteBrandMark({ domain, size = 14, fallback }: {
  domain: string
  size?: number
  fallback: ReactNode
}) {
  const src = `${API_BASE_URL}/api/icon/${encodeURIComponent(domain)}`
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      <RemoteImage
        src={src}
        fallback={fallback}
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className="absolute inset-0 rounded-[3px] object-contain"
      />
    </span>
  )
}
