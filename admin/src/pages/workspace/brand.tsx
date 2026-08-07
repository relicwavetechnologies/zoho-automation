/**
 * Brand marks, for the two places a logo says more than a word does.
 *
 * The workspace's own rule is wordmark initials — see `ProviderMark` — because
 * a screen listing six providers in six brand palettes stops being one design.
 * These are the exception, and only on the Mail screens: the account being
 * connected *is* Gmail, "connect your Gmail" is a sentence somebody scans for a
 * logo rather than reads, and the mark is what tells them at a glance that Divo
 * is asking for mail and not for their whole Google account.
 *
 * Drawn rather than fetched: no network dependency, correct in both themes, and
 * it scales with the row it sits in.
 */

/** Gmail's envelope, at its official proportions. */
export function GmailMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Gmail"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7a3 3 0 0 0 3-3z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6a3 3 0 0 1-3-3z" />
      <path fill="#e53935" d="M35 11.2L24 19.45 13 11.2l-1 5.8 1 6.7 11 8.25 11-8.25 1-6.7z" />
      <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859A4.298 4.298 0 0 0 3 12.298z" />
      <path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341A4.298 4.298 0 0 1 45 12.298z" />
    </svg>
  )
}

/**
 * Lark's own mark — the three-panel bird, in teal, navy and blue.
 *
 * The real file, taken from Lark's own CDN (`larksuitecdn.com`, the icon their
 * marketing site links as its favicon) and served from `public/brand`. It is a
 * 700px transparent PNG, so it stays crisp at every size these screens ask for.
 *
 * A raster rather than a path, and that is the honest trade. Lark publish no
 * open SVG; the ones on logo-aggregator sites are a different company's Lark.
 * A mark redrawn from memory would be worse than either — recognisable enough
 * to be trusted and wrong enough to be somebody else's product.
 */
export function LarkMark({ size = 16 }: { size?: number }) {
  return (
    <img
      src="/brand/lark.png"
      width={size}
      height={size}
      alt=""
      aria-label="Lark"
      role="img"
      loading="lazy"
      decoding="async"
      style={{ flexShrink: 0, display: 'block', width: size, height: size }}
    />
  )
}
