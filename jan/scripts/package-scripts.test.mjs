import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)

function mustVendorBeforeTauri(scriptName) {
  const script = packageJson.scripts[scriptName]
  assert.equal(typeof script, 'string', `${scriptName} must be defined`)
  const vendorIndex = script.indexOf('yarn vendor:pi')
  const tauriIndex = script.indexOf('yarn tauri build')
  assert.ok(vendorIndex >= 0, `${scriptName} must vendor Pi resources`)
  assert.ok(tauriIndex >= 0, `${scriptName} must build a Tauri package`)
  assert.ok(vendorIndex < tauriIndex, `${scriptName} must vendor before Tauri packages resources`)
}

describe('desktop package scripts', () => {
  it('vendors tracked Pi extension sources before every desktop package build', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      mustVendorBeforeTauri(`build:tauri:${platform}`)
    }
  })

  it('vendors Pi before the desktop development runtime starts', () => {
    assert.match(packageJson.scripts['dev:tauri'], /yarn vendor:pi/)
  })
})
