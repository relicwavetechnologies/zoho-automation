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
  /**
   * The product's own colour, for the one accent a surface is allowed to spend
   * on it.
   *
   * Here rather than in a card because it is the same kind of fact as the label
   * and the logo: what this product looks like. A card that carried its own
   * table would drift from the mark beside it the first time a brand was added.
   *
   * Used at low opacity for tints and at full strength only on a single
   * element. It is identity, not a status colour: `--bui-red` still means
   * danger even on a card wearing Zoho's red.
   */
  accent: string
}

export const BRAND_CATALOG: Record<BrandKey, BrandDefinition> = {
  google: { label: 'Google', lookup: { kind: 'domain', value: 'google.com' }, short: 'G', accent: '#4285f4' },
  gmail: { label: 'Gmail', lookup: { kind: 'name', value: 'Gmail' }, short: 'G', fullBleed: true, accent: '#ea4335' },
  googleSheets: { label: 'Google Sheets', lookup: { kind: 'name', value: 'Google Sheets' }, short: 'S', fullBleed: true, accent: '#0f9d58' },
  googleDrive: { label: 'Google Drive', lookup: { kind: 'name', value: 'Google Drive' }, short: 'D', fullBleed: true, accent: '#1a73e8' },
  googleCalendar: { label: 'Google Calendar', lookup: { kind: 'name', value: 'Google Calendar' }, short: 'C', fullBleed: true, accent: '#4285f4' },
  googleDocs: { label: 'Google Docs', lookup: { kind: 'name', value: 'Google Docs' }, short: 'D', fullBleed: true, accent: '#1a73e8' },
  googleSlides: { label: 'Google Slides', lookup: { kind: 'name', value: 'Google Slides' }, short: 'S', fullBleed: true, accent: '#f4b400' },
  googleForms: { label: 'Google Forms', lookup: { kind: 'name', value: 'Google Forms' }, short: 'F', fullBleed: true, accent: '#7248b9' },
  googleTasks: { label: 'Google Tasks', lookup: { kind: 'name', value: 'Google Tasks' }, short: 'T', fullBleed: true, accent: '#2564cf' },
  googleContacts: { label: 'Google Contacts', lookup: { kind: 'name', value: 'Google Contacts' }, short: 'C', fullBleed: true, accent: '#1a73e8' },
  googleChat: { label: 'Google Chat', lookup: { kind: 'name', value: 'Google Chat' }, short: 'C', fullBleed: true, accent: '#00897b' },
  googleAppsScript: { label: 'Google Apps Script', lookup: { kind: 'name', value: 'Google Apps Script' }, short: 'A', fullBleed: true, accent: '#4285f4' },
  lark: { label: 'Lark', lookup: { kind: 'domain', value: 'larksuite.com' }, short: 'L', accent: '#3370ff' },
  canva: { label: 'Canva', lookup: { kind: 'domain', value: 'canva.com' }, short: 'C', fullBleed: true, accent: '#00c4cc' },
  airtable: { label: 'Airtable', lookup: { kind: 'domain', value: 'airtable.com' }, short: 'A', accent: '#18bfff' },
  aitable: { label: 'AITable', lookup: { kind: 'domain', value: 'aitable.ai' }, short: 'Ai', fullBleed: true, accent: '#7b67ee' },
  zoho: { label: 'Zoho', lookup: { kind: 'domain', value: 'zoho.com' }, short: 'Z', accent: '#e42527' },
  zohoBooks: { label: 'Zoho Books', lookup: { kind: 'name', value: 'Zoho Books' }, short: 'Z', accent: '#2e8ae6' },
  zohoCrm: { label: 'Zoho CRM', lookup: { kind: 'name', value: 'Zoho CRM' }, short: 'Z', accent: '#f0483e' },
  semrush: { label: 'Semrush', lookup: { kind: 'domain', value: 'semrush.com' }, short: 'Se', accent: '#ff642d' },
  shopify: { label: 'Shopify', lookup: { kind: 'domain', value: 'shopify.com' }, short: 'S', fullBleed: true, accent: '#95bf47' },
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
