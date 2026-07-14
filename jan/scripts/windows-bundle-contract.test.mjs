import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const janRoot = path.resolve(scriptDir, '..')
const windowsConfigPath = path.join(janRoot, 'src-tauri/tauri.windows.conf.json')

test('Windows bundle contains the runtime that Divo starts locally', () => {
  const config = JSON.parse(fs.readFileSync(windowsConfigPath, 'utf8'))
  const resources = config.bundle.resources

  for (const required of [
    'resources/pi/package.json',
    'resources/pi/pi-chrome-devtools-bridge.mjs',
    'resources/pi/agent-template/**/*',
    'resources/pi/agent-npm/**/*',
    'resources/pi-extensions/**/*',
    'resources/pi-skills/**/*',
    'resources/pi/node_modules/**/*',
    'resources/lark-cli/**/*',
  ]) {
    assert.ok(resources.includes(required), `missing Windows runtime resource: ${required}`)
  }

  assert.deepEqual(config.bundle.externalBin, ['resources/bin/bun', 'resources/bin/uv'])
})
