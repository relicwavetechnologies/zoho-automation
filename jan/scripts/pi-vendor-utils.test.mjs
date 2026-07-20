import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  computePiExtensionsBundleId,
  PI_EXTENSIONS_BUNDLE_ID_FILE,
  pruneBundledPiNonRuntimeFiles,
  writePiExtensionsBundleId,
} from './pi-vendor-utils.mjs'

test('prunes Pi declaration and source-map files while preserving runtime JavaScript', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'divo-pi-prune-'))
  const nested = path.join(root, 'node_modules', 'deep', 'package')
  fs.mkdirSync(nested, { recursive: true })

  const runtimeFile = path.join(nested, 'index.js')
  const declarationFile = path.join(nested, 'index.d.ts')
  const mapFile = path.join(nested, 'index.js.map')
  fs.writeFileSync(runtimeFile, 'export default 1')
  fs.writeFileSync(declarationFile, 'declare const value: number')
  fs.writeFileSync(mapFile, '{}')

  try {
    assert.equal(pruneBundledPiNonRuntimeFiles(root), 2)
    assert.ok(fs.existsSync(runtimeFile))
    assert.ok(!fs.existsSync(declarationFile))
    assert.ok(!fs.existsSync(mapFile))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writes a deterministic extension bundle identity that changes with content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'divo-pi-extension-id-'))
  const nested = path.join(root, 'divo-gateway')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'index.ts'), 'export default 1')
  fs.writeFileSync(path.join(nested, 'package.json'), '{"name":"gateway"}')

  try {
    const first = writePiExtensionsBundleId(root)
    assert.match(first, /^[a-f0-9]{64}$/)
    assert.equal(
      fs.readFileSync(path.join(root, PI_EXTENSIONS_BUNDLE_ID_FILE), 'utf8'),
      `${first}\n`
    )
    assert.equal(computePiExtensionsBundleId(root), first)

    fs.writeFileSync(path.join(nested, 'index.ts'), 'export default 2')
    const second = writePiExtensionsBundleId(root)
    assert.notEqual(second, first)
    assert.equal(computePiExtensionsBundleId(root), second)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
