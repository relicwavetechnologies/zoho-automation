/**
 * Guards the one assumption the whole Astryx setup rests on.
 *
 * Astryx ships UNCOMPILED StyleX in dist (it imports @stylexjs/stylex and
 * calls stylex.props / stylex.create at module scope). Its own styling docs
 * claim a compiler is only needed for swizzled or hand-authored StyleX, and
 * that consuming prebuilt components works off the shipped astryx.css.
 *
 * That claim is the load-bearing assumption behind wiring Astryx into Vite
 * without a StyleX plugin, so it gets tested rather than trusted: if the
 * component mounts and emits real class names, the theory holds.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from '@astryxdesign/core/Button'

describe('astryx setup', () => {
  it('mounts a prebuilt component without a StyleX compiler', () => {
    render(<Button label="Hello Astryx" />)

    const button = screen.getByRole('button', { name: 'Hello Astryx' })
    expect(button).toBeInTheDocument()

    // The real question is not "did it mount" but "did StyleX resolve".
    // An unresolved stylex.props() yields no atomic classes, so the element
    // would mount carrying only its semantic names. Asserting on the atomic
    // `x…` hashes is what actually distinguishes the two — a bare
    // "className is not empty" check passes either way.
    expect(button.className).toMatch(/\bx[a-z0-9]{6,}\b/)
  })
})
