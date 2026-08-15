/**
 * What a website's icon actually is, fetched once and remembered.
 *
 * The web surface draws a source as a letter in a coloured square when it has no
 * vendor mark for the domain, and that monogram was never a placeholder — it is
 * there because the alternative everyone reaches for, an `<img>` pointed at a
 * public favicon service, tells that service every domain appearing in this
 * company's answers, along with the reader's own IP and user agent. A 16-pixel
 * picture is not worth handing someone a log of what a company is researching.
 *
 * This gets the real icon and keeps that property, by moving the fetch to a
 * place the reader is not: the browser asks *us*, we ask the site, and the site
 * learns only that a server somewhere wanted its favicon. One request per
 * domain, ever, rather than one per reader per render.
 *
 * That last part is what makes this cheap rather than clever. Citation domains
 * are a long tail that barely moves — a few thousand in total, a handful new in
 * a week — so this is a per-*domain* workload with a hit rate near one, not a
 * per-request one. The paid services price the problem as if it were the latter.
 *
 * A miss is remembered too. Plenty of sites have no icon, or block anything
 * without a browser's fingerprint, and without a negative cache those are the
 * domains that get refetched forever while the ones that work never do.
 */
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import { guardedFetch } from '../../infrastructure/http/guarded-fetch';

/** Long, because a logo is not news. */
const HIT_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Short, because "no icon" is often "not today". */
const MISS_TTL_SECONDS = 7 * 24 * 60 * 60;

const PAGE_MAX_BYTES = 512 * 1_024;
const ICON_MAX_BYTES = 256 * 1_024;
const FETCH_TIMEOUT_MS = 5_000;

/** Enough to reach a CDN, not enough to be walked in a circle. */
const MAX_REDIRECTS = 3;

const ICON_TYPES = ['image/'] as const;
const PAGE_TYPES = ['text/html', 'application/xhtml+xml'] as const;

export interface SiteIcon {
  readonly body: Buffer;
  readonly contentType: string;
}

type CachedIcon =
  | { readonly found: true; readonly contentType: string; readonly base64: string }
  | { readonly found: false };

/**
 * A domain we are willing to look up.
 *
 * Deliberately stricter than the DNS spec allows: this value arrives in a URL
 * path from an unauthenticated caller and becomes the host of an outbound
 * request, so it is an allowlist of shapes rather than an escape of a string.
 * A label may not start or end with a hyphen, and there must be a dot — a
 * single-label name is either a local machine or a typo, never a website.
 */
export function normalizeDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (value.length === 0 || value.length > 253) return null;
  if (!value.includes('.')) return null;

  const labels = value.split('.');
  const wellFormed = labels.every(label =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/.test(label)
    && !label.startsWith('-')
    && !label.endsWith('-'));
  if (!wellFormed) return null;

  // The last label is the TLD, and a numeric one means this is an IP wearing a
  // domain's clothes. `guardedFetch` refuses those too; refusing here keeps a
  // pointless request off the wire.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;

  return value;
}

/**
 * The icon links a page declares, best first.
 *
 * Read with a regex rather than a parser, and the trade is deliberate: a real
 * parse of every homepage we cite is a lot of work to answer one question about
 * the `<head>`, and a malformed page costs a missing icon rather than an error.
 *
 * Ordered by what the tag says about itself rather than by document order.
 * `apple-touch-icon` is last despite usually being the largest and cleanest
 * image, because it is square, padded, and designed for a home screen — it
 * reads as the wrong shape beside 12px of text.
 */
export function iconHrefsIn(html: string, base: URL): string[] {
  const found: { href: string; rank: number; size: number }[] = [];
  const linkTags = html.slice(0, PAGE_MAX_BYTES).match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of linkTags) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!rel || !rel.split(/\s+/).some(token => token === 'icon' || token === 'shortcut' || token === 'apple-touch-icon')) {
      continue;
    }
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag)?.[1]?.trim();
    if (!href) continue;

    /* `sizes="32x32 16x16"` — take the largest it claims. A bigger source
       downsamples cleanly; a 16px one drawn at 18 looks like a mistake. */
    const sizes = /\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? '';
    const size = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/gi)].map(match => Number(match[1])));

    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }
    found.push({ href: absolute, rank: rel.includes('apple-touch-icon') ? 1 : 0, size });
  }

  return found
    .sort((a, b) => a.rank - b.rank || b.size - a.size)
    .map(entry => entry.href)
    .filter((href, index, all) => all.indexOf(href) === index);
}

export class SiteIconService {
  constructor(private readonly deps: {
    readonly cache: CachePort;
    readonly logger: Logger;
  }) {}

  /**
   * The icon for a domain, or null when it has none we could get.
   *
   * Null is an ordinary answer rather than a failure: the surface already has a
   * monogram for exactly this case, and it is the one that keeps working when
   * the far end is down.
   */
  async iconFor(domain: string): Promise<SiteIcon | null> {
    const key = `icon:v1:${domain}`;

    const cached = await this.deps.cache.get<CachedIcon>(key);
    if (cached.ok && cached.value) {
      return cached.value.found
        ? { body: Buffer.from(cached.value.base64, 'base64'), contentType: cached.value.contentType }
        : null;
    }

    const found = await this.resolve(domain);

    await this.deps.cache.set<CachedIcon>(
      key,
      found
        ? { found: true, contentType: found.contentType, base64: found.body.toString('base64') }
        : { found: false },
      found ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
    );

    return found;
  }

  /**
   * Ask the site, then fall back to the convention.
   *
   * The homepage first because a declared `<link rel="icon">` is the site
   * telling us which image it wants used, at which size, and is usually a PNG
   * rather than a 1998 `.ico`. `/favicon.ico` is the fallback rather than the
   * first try: it is a guess that happens to work often, and asking it first
   * means taking a worse image from every site that had a better one to offer.
   */
  private async resolve(domain: string): Promise<SiteIcon | null> {
    const candidates: string[] = [];

    const page = await guardedFetch(`https://${domain}/`, {
      accept: PAGE_TYPES,
      maxBytes: PAGE_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
    });
    if (page.ok) {
      candidates.push(...iconHrefsIn(page.value.body.toString('utf8'), new URL(page.value.url)));
    }
    candidates.push(`https://${domain}/favicon.ico`);

    for (const candidate of candidates.slice(0, 4)) {
      const icon = await guardedFetch(candidate, {
        accept: ICON_TYPES,
        maxBytes: ICON_MAX_BYTES,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
      });
      if (icon.ok) return { body: icon.value.body, contentType: icon.value.contentType };

      /* Worth knowing about, not worth an error: a site refusing us is the
         normal weather here, and the monogram covers it. */
      if (icon.error.reason === 'blocked_address' || icon.error.reason === 'unsafe_url') {
        this.deps.logger.warn('site_icon_refused', {
          domain,
          candidate,
          reason: icon.error.reason,
        });
      }
    }

    return null;
  }
}
