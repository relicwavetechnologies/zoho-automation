import { defineTheme } from '@astryxdesign/core/theme'

/**
 * Divo's brand applied to Astryx.
 *
 * Astryx components colour themselves from Astryx theme tokens via StyleX,
 * NOT from Jan's Tailwind tokens — so the token-collision fix in index.css,
 * which makes Jan's `--primary` win for utilities, does nothing for them. Left
 * alone, an Astryx <Button> renders in Astryx's stock blue while the rest of
 * the app runs on Divo's coral: two accents in one screen, which is the fastest
 * way to make a product feel assembled rather than designed.
 *
 * The accent below is Jan's `--primary` — oklch(0.7003 0.1611 35.09) — resolved
 * to hex, so both systems point at one colour. The pair is [light, dark]: the
 * dark entry is the same hue and chroma lifted in lightness, because the stock
 * coral is mixed against a near-black surface (#181818) where it loses contrast.
 *
 * Rebuild after editing: `yarn astryx theme build src/styles/divo.theme.ts`
 */
export default defineTheme({
  name: 'divo',
  color: {
    accent: '#f17455',
    // Divo's greys are neutral, not tinted — a warm neutral ramp under a warm
    // accent turns the whole UI sepia.
    neutralStyle: 'neutral',
  },
  // Explicit overrides beat the generated scale. Two things are pinned here:
  //
  // 1. The accent, so Astryx components match Jan's coral --primary.
  //
  // 2. Every surface, to Jan's OWN neutral palette. Left to the scale, a warm
  //    accent drags the whole neutral ramp warm — the surfaces came out
  //    #201A19 / #160F0D (a brown tint), so the Astryx ChatComposer rendered
  //    visibly warmer than Jan's neutral page sitting right behind it. Jan's
  //    greys are true neutral (equal RGB), so pinning the background tokens to
  //    them makes an Astryx surface indistinguishable from a Jan one.
  //    Each value is [light, dark].
  tokens: {
    '--color-accent': ['#f17455', '#ff8d6d'],
    '--color-background-body': ['#ffffff', '#181818'],
    '--color-background-surface': ['#ffffff', '#1f1f1f'],
    '--color-background-card': ['#ffffff', '#1f1f1f'],
    '--color-background-popover': ['#ffffff', '#242424'],
    '--color-background-muted': ['#f4f4f5', '#262626'],
    '--color-border': ['#e4e4e5', '#ffffff12'],
    // The warm ramp tints more than surfaces — text and icons came out
    // #E9E1DF (a cream), and the overlays were brown-alpha. Pin the visible
    // foreground tokens to Jan's neutral grey and rebuild the overlays on
    // neutral black/white alpha, so nothing Astryx draws reads warm.
    '--color-text-primary': ['#1a1c1f', '#ededed'],
    '--color-text-secondary': ['#818284', '#9b9b9b'],
    '--color-icon-primary': ['#1a1c1f', '#ededed'],
    '--color-background-inverted': ['#1a1c1f', '#ededed'],
    '--color-neutral': ['#0000001a', '#ffffff1a'],
    '--color-overlay': ['#00000066', '#00000099'],
    '--color-overlay-hover': ['#0000000d', '#ffffff0d'],
    '--color-overlay-pressed': ['#0000001a', '#ffffff1a'],
  },
})
