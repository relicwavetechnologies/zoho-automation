import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from 'react'
import {
  GmailIcon, GoogleAppsScriptIcon, GoogleCalendarIcon,
  GoogleChatIcon, GoogleContactsIcon, GoogleDocsIcon, GoogleDriveIcon, GoogleFormsIcon,
  GoogleIcon, GoogleSheetsIcon, GoogleSlidesIcon, GoogleTasksIcon, ZohoIcon,
} from '@/components/brand-icons'
import { API_BASE_URL } from '@/lib/api-base'
import { logoDevPublishableKey } from '@/lib/runtime-config'
import { BRAND_CATALOG, buildLogoDevUrl, type BrandKey } from './brand-catalog'

type SvgMark = ComponentType<SVGProps<SVGSVGElement>>

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
  zoho: ZohoIcon,
  zohoBooks: ZohoIcon,
  zohoCrm: ZohoIcon,
}

const LOCAL_ASSET: Partial<Record<BrandKey, string>> = {
  lark: '/brand/lark.png',
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
 * Callers name a brand and a placement; this module owns remote lookup,
 * dimensions, loading, accessibility, and a local/monogram failure state.
 */
export function BrandMark({
  brand, size = 16, placement = 'inline', className = '', dim = false, decorative = true,
}: BrandMarkProps) {
  const definition = BRAND_CATALOG[brand]
  const glyphSize = placement === 'tile' && !definition.fullBleed ? Math.round(size * 0.62) : size
  const token = logoDevPublishableKey()
  const src = buildLogoDevUrl(brand, token, Math.max(glyphSize, 32))
  const Fallback = LOCAL_FALLBACK[brand]
  const fallbackAsset = LOCAL_ASSET[brand]
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const label = decorative ? undefined : definition.label

  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [src])

  const mark = (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden ${dim ? 'opacity-70 transition-opacity duration-100 group-hover:opacity-100' : ''} ${className}`}
      style={{ width: glyphSize, height: glyphSize }}
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : 'img'}
      aria-label={label}
    >
      {fallbackAsset
        ? <img src={fallbackAsset} alt="" width={glyphSize} height={glyphSize} className="block h-full w-full object-contain" />
        : Fallback
          ? <Fallback width={glyphSize} height={glyphSize} className="block h-full w-full" aria-hidden />
        : (
          <span className="grid h-full w-full place-items-center rounded-[3px] bg-secondary text-[0.55em] font-medium text-muted-foreground">
            {definition.short}
          </span>
          )}
      {src && !failed ? (
        <img
          key={src}
          src={src}
          alt=""
          width={glyphSize}
          height={glyphSize}
          loading="lazy"
          decoding="async"
          referrerPolicy="origin"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-contain"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      ) : null}
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
  const [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading')
  useEffect(() => setState('loading'), [domain])
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      {state !== 'shown' ? fallback : null}
      {state !== 'failed' ? (
        <img
          src={`${API_BASE_URL}/api/icon/${encodeURIComponent(domain)}`}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onLoad={() => setState('shown')}
          onError={() => setState('failed')}
          className="absolute inset-0 rounded-[3px] object-contain"
          style={{ opacity: state === 'shown' ? 1 : 0 }}
        />
      ) : null}
    </span>
  )
}
