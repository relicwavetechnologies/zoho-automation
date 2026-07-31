import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  macArchitecturesForTarget,
  resolveMacTarget,
} from './download-bin.mjs'

describe('macOS binary target selection', () => {
  it('uses the explicit Intel target instead of the build host architecture', () => {
    assert.equal(resolveMacTarget({ JAN_MACOS_TARGET: 'x86_64' }, 'arm64'), 'x86_64')
    assert.deepEqual(
      macArchitecturesForTarget('x86_64').map((architecture) => architecture.triple),
      ['x86_64-apple-darwin']
    )
  })

  it('downloads both architecture assets for a universal package', () => {
    assert.deepEqual(
      macArchitecturesForTarget(resolveMacTarget({ JAN_MACOS_TARGET: 'universal' }, 'arm64')).map(
        (architecture) => architecture.triple
      ),
      ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    )
  })

  it('falls back to the host architecture for development downloads', () => {
    assert.equal(resolveMacTarget({}, 'arm64'), 'aarch64')
    assert.equal(resolveMacTarget({}, 'x64'), 'x86_64')
  })

  it('rejects unsupported target names', () => {
    assert.throws(
      () => resolveMacTarget({ JAN_MACOS_TARGET: 'powerpc' }, 'arm64'),
      /Unsupported JAN_MACOS_TARGET/
    )
  })
})
