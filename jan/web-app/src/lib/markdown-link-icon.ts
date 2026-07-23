import type { ComponentType, SVGProps } from 'react'
import {
  ExternalLinkIcon,
  FileTextIcon,
  GithubIcon,
  GlobeIcon,
  MailIcon,
  VideoIcon,
} from 'lucide-react'
import {
  CanvaIcon,
  GmailIcon,
  GoogleAppsScriptIcon,
  GoogleCalendarIcon,
  GoogleChatIcon,
  GoogleContactsIcon,
  GoogleDocsIcon,
  GoogleDriveIcon,
  GoogleFormsIcon,
  GoogleIcon,
  GoogleSheetsIcon,
  GoogleSlidesIcon,
  GoogleTasksIcon,
  LarkIcon,
  SemrushIcon,
  ZohoIcon,
} from '@/components/brand-icons'

export type LinkIconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { className?: string; title?: string }
>

type HostRule = {
  /** Host suffix match (e.g. `docs.google.com`). */
  host: string | RegExp
  /** Optional path prefix / substring for product disambiguation. */
  pathIncludes?: string[]
  icon: LinkIconComponent
}

/**
 * Curated map reusing the same brand marks as ToolIcon — not a 300-icon pack,
 * and not favicon fetches. Unknown hosts get a quiet external-link glyph.
 */
const HOST_RULES: HostRule[] = [
  { host: 'mail.google.com', icon: GmailIcon },
  { host: 'gmail.com', icon: GmailIcon },
  {
    host: 'docs.google.com',
    pathIncludes: ['/spreadsheets', '/sheets'],
    icon: GoogleSheetsIcon,
  },
  {
    host: 'docs.google.com',
    pathIncludes: ['/presentation', '/slides'],
    icon: GoogleSlidesIcon,
  },
  {
    host: 'docs.google.com',
    pathIncludes: ['/forms'],
    icon: GoogleFormsIcon,
  },
  {
    host: 'docs.google.com',
    pathIncludes: ['/document'],
    icon: GoogleDocsIcon,
  },
  { host: 'docs.google.com', icon: GoogleDocsIcon },
  { host: 'sheets.google.com', icon: GoogleSheetsIcon },
  { host: 'drive.google.com', icon: GoogleDriveIcon },
  { host: 'calendar.google.com', icon: GoogleCalendarIcon },
  { host: 'chat.google.com', icon: GoogleChatIcon },
  { host: 'contacts.google.com', icon: GoogleContactsIcon },
  { host: 'tasks.google.com', icon: GoogleTasksIcon },
  { host: 'script.google.com', icon: GoogleAppsScriptIcon },
  { host: /(^|\.)google\./, icon: GoogleIcon },

  { host: /(^|\.)(larksuite|feishu)\./, icon: LarkIcon },
  { host: /(^|\.)zoho\./, icon: ZohoIcon },
  { host: /(^|\.)canva\./, icon: CanvaIcon },
  { host: /(^|\.)semrush\./, icon: SemrushIcon },

  { host: /(^|\.)github\./, icon: GithubIcon },
  { host: /(^|\.)notion\./, icon: FileTextIcon },
  { host: /(^|\.)zoom\./, icon: VideoIcon },
]

function hostMatches(ruleHost: string | RegExp, hostname: string): boolean {
  if (typeof ruleHost === 'string') {
    return hostname === ruleHost || hostname.endsWith(`.${ruleHost}`)
  }
  return ruleHost.test(hostname)
}

/**
 * Pick a link icon from an href. Citations (`#cite-…`) and non-http schemes
 * (except mailto) get no brand mark — the renderer decides fallbacks.
 */
export function resolveMarkdownLinkIcon(
  href: string | undefined
): LinkIconComponent | undefined {
  if (!href) return undefined
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#cite-')) return undefined

  if (trimmed.toLowerCase().startsWith('mailto:')) return MailIcon

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

  const hostname = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()

  for (const rule of HOST_RULES) {
    if (!hostMatches(rule.host, hostname)) continue
    if (rule.pathIncludes?.length) {
      if (!rule.pathIncludes.some((fragment) => path.includes(fragment))) {
        continue
      }
    }
    return rule.icon
  }

  return ExternalLinkIcon
}

/** Visible when we have no host match but still want a soft external cue. */
export const DefaultLinkIcon: LinkIconComponent = GlobeIcon
