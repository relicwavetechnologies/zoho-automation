import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { pruneBundledPiNonRuntimeFiles } from './pi-vendor-utils.mjs'

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
