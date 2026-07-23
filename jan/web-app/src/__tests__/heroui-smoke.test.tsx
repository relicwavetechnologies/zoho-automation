import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from '@heroui/react'

/**
 * Guards the HeroUI setup.
 *
 * HeroUI v3 needs no provider, so the only things that can silently break are
 * (a) the package failing to mount under React 19, and (b) the token bridge in
 * index.css going missing — Jan and HeroUI both declare --accent,
 * --accent-foreground and --muted with OPPOSITE meanings, and Jan wins the
 * cascade, so an unbridged HeroUI button paints its brand fill in Jan's
 * near-white hover grey. That failure is invisible: no error, no build warning,
 * just an unreadable control.
 *
 * jsdom does not apply stylesheets, so this cannot assert the resolved colour.
 * What it can pin is that the component mounts and is reachable — the bridge
 * itself is asserted in the CSS build, not here.
 */
describe('heroui setup', () => {
  it('mounts a HeroUI component under React 19 without a provider', () => {
    render(<Button data-heroui>Press me</Button>)

    const button = screen.getByRole('button', { name: 'Press me' })
    expect(button).toBeInTheDocument()
    // HeroUI ships utility classes rather than inline styles; an element that
    // mounted bare would mean the package resolved to something unstyled.
    expect(button.className.trim()).not.toBe('')
  })
})
