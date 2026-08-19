export type BrandKey =
  | 'google' | 'gmail' | 'googleSheets' | 'googleDrive' | 'googleCalendar'
  | 'googleDocs' | 'googleSlides' | 'googleForms' | 'googleTasks'
  | 'googleContacts' | 'googleChat' | 'googleAppsScript'
  | 'lark' | 'canva' | 'airtable' | 'aitable' | 'zoho' | 'zohoBooks'
  | 'zohoCrm' | 'semrush' | 'shopify'

type LogoLookup = { kind: 'domain' | 'name'; value: string }

export type BrandDefinition = {
  label: string
  lookup: LogoLookup
  short: string
  /** Finished app icons fill a tile; transparent company glyphs need breathing room. */
  fullBleed?: boolean
}

export const BRAND_CATALOG: Record<BrandKey, BrandDefinition> = {
  google: { label: 'Google', lookup: { kind: 'domain', value: 'google.com' }, short: 'G' },
  gmail: { label: 'Gmail', lookup: { kind: 'name', value: 'Gmail' }, short: 'G', fullBleed: true },
  googleSheets: { label: 'Google Sheets', lookup: { kind: 'name', value: 'Google Sheets' }, short: 'S', fullBleed: true },
  googleDrive: { label: 'Google Drive', lookup: { kind: 'name', value: 'Google Drive' }, short: 'D', fullBleed: true },
  googleCalendar: { label: 'Google Calendar', lookup: { kind: 'name', value: 'Google Calendar' }, short: 'C', fullBleed: true },
  googleDocs: { label: 'Google Docs', lookup: { kind: 'name', value: 'Google Docs' }, short: 'D', fullBleed: true },
  googleSlides: { label: 'Google Slides', lookup: { kind: 'name', value: 'Google Slides' }, short: 'S', fullBleed: true },
  googleForms: { label: 'Google Forms', lookup: { kind: 'name', value: 'Google Forms' }, short: 'F', fullBleed: true },
  googleTasks: { label: 'Google Tasks', lookup: { kind: 'name', value: 'Google Tasks' }, short: 'T', fullBleed: true },
  googleContacts: { label: 'Google Contacts', lookup: { kind: 'name', value: 'Google Contacts' }, short: 'C', fullBleed: true },
  googleChat: { label: 'Google Chat', lookup: { kind: 'name', value: 'Google Chat' }, short: 'C', fullBleed: true },
  googleAppsScript: { label: 'Google Apps Script', lookup: { kind: 'name', value: 'Google Apps Script' }, short: 'A', fullBleed: true },
  lark: { label: 'Lark', lookup: { kind: 'domain', value: 'larksuite.com' }, short: 'L' },
  canva: { label: 'Canva', lookup: { kind: 'domain', value: 'canva.com' }, short: 'C', fullBleed: true },
  airtable: { label: 'Airtable', lookup: { kind: 'domain', value: 'airtable.com' }, short: 'A' },
  aitable: { label: 'AITable', lookup: { kind: 'domain', value: 'aitable.ai' }, short: 'Ai', fullBleed: true },
  zoho: { label: 'Zoho', lookup: { kind: 'domain', value: 'zoho.com' }, short: 'Z' },
  zohoBooks: { label: 'Zoho Books', lookup: { kind: 'name', value: 'Zoho Books' }, short: 'Z' },
  zohoCrm: { label: 'Zoho CRM', lookup: { kind: 'name', value: 'Zoho CRM' }, short: 'Z' },
  semrush: { label: 'Semrush', lookup: { kind: 'domain', value: 'semrush.com' }, short: 'Se' },
  shopify: { label: 'Shopify', lookup: { kind: 'domain', value: 'shopify.com' }, short: 'S', fullBleed: true },
}

const clampSize = (size: number) => Math.max(8, Math.min(800, Math.round(size)))

export function buildLogoDevUrl(brand: BrandKey, token: string, size: number): string | null {
  const publishableKey = token.trim()
  if (!/^pk_[A-Za-z0-9]+$/.test(publishableKey)) return null

  const { lookup } = BRAND_CATALOG[brand]
  const path = lookup.kind === 'domain'
    ? lookup.value
    : `name/${encodeURIComponent(lookup.value)}`
  const params = new URLSearchParams({
    token: publishableKey,
    size: String(clampSize(size)),
    format: 'png',
    retina: 'true',
    fallback: '404',
  })
  return `https://img.logo.dev/${path}?${params.toString()}`
}
