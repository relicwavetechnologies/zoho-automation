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

/**
 * Google's G, at its official proportions and colours.
 *
 * Safe to draw because this one is published as a fixed, unchanging path — the
 * same four arcs everybody embeds. It is the mark for the whole Google Workspace
 * connection, where `GmailMark` is specifically the mail product.
 */
export function GoogleMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Google"
      style={{ flexShrink: 0, display: 'block' }}>
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </svg>
  )
}

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
