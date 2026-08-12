/**
 * Where an answer got its information.
 *
 * When Divo searches the web it writes ordinary markdown links, and a raw URL
 * in the middle of a sentence is the least readable thing on the page — a line
 * of punctuation the eye has to step over. A link is a *source*, so it is drawn
 * as one: the site's mark and its domain, in a chip the width of a word.
 *
 * The distinction that matters is whether the link text is doing any work. A
 * link the model wrote prose for ("last quarter's filing") keeps its prose and
 * stays underlined; a link whose text is the URL itself is saying nothing the
 * chip would not say better.
 */

export type Source = { href: string; domain: string }

/** The site a link points at, or null if it does not point at a site. */
export function domainOf(href: string): string | null {
  const match = /^https?:\/\/([^/?#\s]+)/i.exec(href.trim())
  if (!match) return null
  const host = match[1]!.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')
  return host.includes('.') ? host : null
}

/** A link whose text is just its own address, and so has nothing to lose. */
export function isBareLink(text: string, href: string): boolean {
  const value = text.trim().replace(/\/+$/, '')
  if (!value) return true
  if (value === href.trim().replace(/\/+$/, '')) return true
  if (/^https?:\/\//i.test(value)) return true
  return value.toLowerCase() === domainOf(href)
}

/** How many sites the strip under an answer will name before it stops. */
const MAX_SOURCES = 12

/**
 * Every site an answer drew on, once each, in the order they were cited.
 *
 * Read off the markdown rather than the rendered tree, because the strip sits
 * outside the answer and is built before any of it is drawn. One entry per
 * domain: an answer citing six pages of the same filing has one source, and a
 * strip that said "6 sources" would be flattering itself.
 */
export function sourcesIn(markdown: string): Source[] {
  const found = new Map<string, Source>()

  const remember = (href: string) => {
    const domain = domainOf(href)
    if (!domain || found.has(domain)) return
    found.set(domain, { href: href.trim(), domain })
  }

  for (const [, href] of markdown.matchAll(/\[[^\]]*\]\(\s*(<?[^)\s]+)>?\s*(?:"[^"]*")?\)/g)) {
    remember(href!.replace(/^</, ''))
  }
  for (const [href] of markdown.matchAll(/https?:\/\/[^\s<>()[\]"']+/g)) {
    remember(href)
  }

  return [...found.values()].slice(0, MAX_SOURCES)
}

/**
 * A stable tint for a site with no mark of its own.
 *
 * Identity, not measurement — nothing here encodes a quantity, so a hue chosen
 * by name is honest. It has to be stable, though: the same site keeps the same
 * colour in every answer, or the strip becomes a lucky dip.
 */
export function tintOf(domain: string): number {
  let hash = 0
  for (const char of domain) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

/** The letter on the tile. */
export function initialOf(domain: string): string {
  return (domain.replace(/^(www|m|en)\./, '')[0] ?? '?').toUpperCase()
}
