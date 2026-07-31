/**
 * Artifact markdown helpers — file-link detection and citation enhancement.
 *
 * Agents often write research citations as bare `[1][2]` plus a Sources list.
 * We turn those into real markdown links when we can resolve a URL, and treat
 * path-like hrefs as Cursor-style file chips in the renderer.
 */

const CODE_FENCE = /(```[\s\S]*?```|`[^`\n]+`)/g
const SOURCES_HEADING =
  /^#{1,6}\s+(?:sources|references|citations|bibliography|works cited)\s*$/im

const FILE_EXT =
  /\.(?:rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|md|mdx|json|ya?ml|toml|lock|css|scss|html|svg|sql|sh|bash|zsh|fish|rb|php|cs|cpp|c|h|hpp|txt|xml|proto|graphql|vue|svelte|astro)$/i

export function isFileMarkdownHref(href: string | undefined): boolean {
  if (!href) return false
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#')) return false
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return false

  // Absolute or relative workspace / repo paths
  if (trimmed.startsWith('file:')) return true
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true
  }
  if (trimmed.includes('/') && FILE_EXT.test(trimmed)) return true
  if (FILE_EXT.test(trimmed) && !trimmed.includes('://')) return true
  return false
}

export function fileLinkLabel(href: string, childrenText?: string): string {
  const child = childrenText?.trim()
  if (child && child !== href) return child
  const cleaned = href.replace(/^file:\/\//, '').replace(/\\/g, '/')
  const parts = cleaned.split('/')
  return parts[parts.length - 1] || cleaned
}

type SourceEntry = { index: number; url?: string; title?: string }

function parseSourceEntries(sourcesBody: string): Map<number, SourceEntry> {
  const map = new Map<number, SourceEntry>()
  const lines = sourcesBody.split('\n')

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // [1]: https://...  or  [1] Title https://...
    const def = line.match(
      /^\[(\d+)\]\s*:?\s*(.*)$/
    )
    if (def) {
      const index = Number(def[1])
      const rest = def[2].trim()
      const url = rest.match(/https?:\/\/\S+/)?.[0]
      map.set(index, {
        index,
        url,
        title: rest.replace(url ?? '', '').trim() || undefined,
      })
      continue
    }

    // 1. Title — https://...   or  1) https://...
    const numbered = line.match(/^(\d+)[.)]\s+(.*)$/)
    if (numbered) {
      const index = Number(numbered[1])
      const rest = numbered[2].trim()
      const url = rest.match(/https?:\/\/\S+/)?.[0]
      map.set(index, {
        index,
        url,
        title: rest.replace(url ?? '', '').replace(/[—–-]\s*$/, '').trim() || undefined,
      })
    }
  }

  return map
}

/**
 * Convert bare `[n]` markers into markdown links when a Sources section
 * defines those indices with http(s) URLs. Code/inline-code is preserved.
 */
export function enhanceArtifactMarkdown(content: string): string {
  if (!content.includes('[')) return content

  const chunks: string[] = []
  const masked = content.replace(CODE_FENCE, (m) => {
    chunks.push(m)
    return `\uE000${chunks.length - 1}\uE000`
  })

  const headingMatch = SOURCES_HEADING.exec(masked)
  if (!headingMatch || headingMatch.index === undefined) {
    return content
  }

  const body = masked.slice(0, headingMatch.index)
  const sourcesAndAfter = masked.slice(headingMatch.index)
  const sources = parseSourceEntries(sourcesAndAfter)
  if (sources.size === 0) return content

  const linkedBody = body.replace(/\[(\d+)\](?!\()/g, (full, numStr: string) => {
    const entry = sources.get(Number(numStr))
    if (!entry?.url) return full
    return `[${numStr}](${entry.url})`
  })

  return `${linkedBody}${sourcesAndAfter}`.replace(
    /\uE000(\d+)\uE000/g,
    (_, n) => chunks[Number(n)] ?? ''
  )
}

/** True when link children are a plain citation number (e.g. "1"). */
export function isNumericCitationLabel(childrenText: string | undefined): boolean {
  return Boolean(childrenText && /^\d{1,3}$/.test(childrenText.trim()))
}
