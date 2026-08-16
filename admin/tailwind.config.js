/** @type {import('tailwindcss').Config} */

/*
  Names for the palette, and nothing that is not used.

  Every colour below resolves to a `--bui-*` value in `src/styles/palette.css`,
  which holds Beautiful UI's own hexes for both themes. Tailwind is a naming
  layer here — it decides nothing.

  Twenty colour groups were removed from this file in one pass: the shadcn set
  (`primary`, `secondary`, `accent`, `muted`, `card`, `popover`, `destructive`,
  `emphasis`, `mat`, `success`, `warning`, `input`), five chart hues, five
  pastel timeline stages, and a `sidebar` group whose tokens were never defined
  anywhere — `bg-sidebar` had been compiling to a literal `hsl()` with an empty
  argument. A scan of every `.ts`/`.tsx` found no use of any class they backed.

  What is left is the set the app actually writes: seven surfaces, three ink
  weights, two hairlines, two fills, the accent, and five shadows.
*/
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        studio: ['StudioFeixenSans', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      /*
        chip → control → card, the reference's own three radii, straight off the
        palette. `sm`/`md`/`lg` are aimed at the same three rather than being
        derived from a separate `--radius` that then had to be kept in agreement
        with them by arithmetic.
      */
      borderRadius: {
        sm: 'var(--bui-r-chip)',
        md: 'var(--bui-r-control)',
        lg: 'var(--bui-r-card)',
        chip: 'var(--bui-r-chip)',
        control: 'var(--bui-r-control)',
        card: 'var(--bui-r-card)',
      },
      boxShadow: {
        hairline: 'var(--bui-shadow-hairline)',
        btn: 'var(--bui-shadow-btn)',
        card: 'var(--bui-shadow-card)',
        raised: 'var(--bui-shadow-raised)',
        overlay: 'var(--bui-shadow-overlay)',
      },
      colors: {
        /* Planes. `--bui-page` has no name here on purpose: it is the sidebar's
           plane and the sidebar is styled in CSS, so a `bg-page` class would be
           an invitation to put a second surface on the rail's colour — which is
           what the chat pane was doing, sitting flush against it. */
        canvas: 'var(--bui-canvas)',
        /* The content plane, mostly opaque — what a sticky header floats on.
           Named because `bg-canvas/70` cannot work: see the note in palette.css. */
        veil: 'var(--bui-veil)',
        surface: 'var(--bui-surface)',
        inset: 'var(--bui-inset)',
        field: 'var(--bui-field)',
        fill: {
          DEFAULT: 'var(--bui-hover)',
          strong: 'var(--bui-hover-2)',
        },
        ink: {
          DEFAULT: 'var(--bui-ink)',
          2: 'var(--bui-ink-2)',
          3: 'var(--bui-ink-3)',
        },
        line: {
          DEFAULT: 'var(--bui-line)',
          strong: 'var(--bui-line-strong)',
        },
        /* The one chromatic name. Blue: links, focus, the active rail, anything
           that has to read as actionable before it is read as words. Divo's
           orange is `--bui-brand` and is deliberately not here — it marks the
           product, and a Tailwind class is an invitation to spend it. */
        accent: {
          DEFAULT: 'var(--bui-accent)',
          ink: 'var(--bui-accent-ink)',
          tint: 'var(--bui-accent-tint)',
        },
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
