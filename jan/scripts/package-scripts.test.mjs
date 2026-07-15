import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)
const macosConfig = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.macos.conf.json', import.meta.url), 'utf8')
)
const vendorScript = readFileSync(new URL('./vendor-pi.mjs', import.meta.url), 'utf8')

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
    mustVendorBeforeTauri('build:tauri:darwin:aarch64')
    mustVendorBeforeTauri('build:tauri:darwin:x86_64')
  })

  it('uses explicit and isolated architecture targets for macOS packages', () => {
    assert.match(packageJson.scripts['build:tauri:darwin'], /JAN_MACOS_TARGET=universal/)
    assert.match(packageJson.scripts['build:tauri:darwin'], /tauri\.macos\.conf\.json/)
    assert.match(packageJson.scripts['build:tauri:darwin:aarch64'], /JAN_MACOS_TARGET=aarch64/)
    assert.match(packageJson.scripts['build:tauri:darwin:aarch64'], /--target aarch64-apple-darwin/)
    assert.match(packageJson.scripts['build:tauri:darwin:aarch64'], /--bundles app/)
    assert.match(packageJson.scripts['build:tauri:darwin:aarch64'], /tauri\.macos\.conf\.json/)
    assert.match(packageJson.scripts['build:tauri:darwin:x86_64'], /JAN_MACOS_TARGET=x86_64/)
    assert.match(packageJson.scripts['build:tauri:darwin:x86_64'], /--target x86_64-apple-darwin/)
    assert.match(packageJson.scripts['build:tauri:darwin:x86_64'], /--bundles app/)
    assert.match(
      packageJson.scripts['build:tauri:darwin:x86_64'],
      /JAN_MACOS_TARGET=x86_64 yarn vendor:pi/
    )
    assert.doesNotMatch(packageJson.scripts['build:tauri:darwin:x86_64'], /mlx/i)
    assert.match(packageJson.scripts['build:tauri:plugin:api:darwin'], /--exclude @janhq\/tauri-plugin-mlx-api/)
    assert.match(packageJson.scripts['build:tauri:plugin:api:darwin:x86_64'], /yarn install/)
    assert.match(packageJson.scripts['build:extensions:darwin:aarch64'], /yarn install/)
    assert.match(packageJson.scripts['build:extensions:darwin:aarch64'], /--exclude @janhq\/mlx-extension/)
    assert.match(packageJson.scripts['build:extensions:darwin:x86_64'], /--exclude @janhq\/mlx-extension/)
  })

  it('ships the Divo runtime resources without local model binaries', () => {
    const resources = macosConfig.bundle.resources
    for (const requiredResource of [
      'resources/bin/sqlite-vec.dylib',
      'resources/pi/node_modules/**/*',
    ]) {
      assert.ok(resources.includes(requiredResource), `${requiredResource} must be bundled`)
    }
    assert.ok(!resources.some((resource) => resource.includes('lark-cli')))
    assert.ok(!resources.some((resource) => resource.includes('jan-cli')))
    assert.ok(!resources.some((resource) => resource.includes('mlx')))
  })

  it('does not install the retired local Lark CLI', () => {
    assert.doesNotMatch(vendorScript, /@larksuite\/cli/)
    assert.doesNotMatch(vendorScript, /Vendoring Lark CLI/)
  })

  it('vendors Pi before the desktop development runtime starts', () => {
    assert.match(packageJson.scripts['dev:tauri'], /yarn vendor:pi/)
  })

  it('has a complete Windows x64 build without unused local-model extensions', () => {
    const script = packageJson.scripts['build:windows:x64']
    assert.equal(typeof script, 'string')
    assert.match(script, /build:tauri:plugin:api:win32/)
    assert.match(script, /build:extensions:win32/)
    assert.match(script, /build:tauri:win32/)
    assert.match(packageJson.scripts['build:tauri:plugin:api:win32'], /yarn install/)
    assert.match(packageJson.scripts['build:extensions:win32'], /yarn install/)
    assert.match(packageJson.scripts['build:extensions:win32'], /--exclude @janhq\/llamacpp-extension/)
    assert.match(packageJson.scripts['build:extensions:win32'], /--exclude @janhq\/mlx-extension/)
  })
})
