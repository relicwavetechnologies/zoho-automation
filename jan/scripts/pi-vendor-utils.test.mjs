import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  computePiExtensionsBundleId,
  patchBundledPiPromptLifecycle,
  PI_EXTENSIONS_BUNDLE_ID_FILE,
  pruneBundledPiNonRuntimeFiles,
  syncExecutablePiExtensions,
  writePiExtensionsBundleId,
} from './pi-vendor-utils.mjs'

test('patches Pi with an authoritative post-turn lifecycle signal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'divo-pi-lifecycle-'))
  const dist = path.join(
    root,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist'
  )
  const sessionPath = path.join(dist, 'core', 'agent-session.js')
  const rpcPath = path.join(dist, 'modes', 'rpc', 'rpc-mode.js')
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.mkdirSync(path.dirname(rpcPath), { recursive: true })
  fs.writeFileSync(
    sessionPath,
    `    get isStreaming() {
        return this.agent.state.isStreaming;
    }
    async _runAgentPrompt(messages) {
        try {
            await this.agent.prompt(messages);
        }
        finally {
            this._systemPromptOverride = undefined;
        }
    }
    async prompt(text, options) {
        const preflightResult = options?.preflightResult;
        let messages;
        try {
            if (text === "/handled") {
                preflightResult?.(true);
                return;
            }
            if (text === "/invalid") {
                throw new Error("invalid preflight");
            }
            messages = [{ role: "user", content: text }];
        }
        catch (error) {
            preflightResult?.(false);
            throw error;
        }
        if (!messages) {
            return;
        }
        preflightResult?.(true);
        await this._runAgentPrompt(messages);
    }`
  )
  fs.writeFileSync(
    rpcPath,
    `                const state = {
                    isStreaming: session.isStreaming,
                    isCompacting: session.isCompacting,
                };`
  )

  try {
    patchBundledPiPromptLifecycle(root)
    patchBundledPiPromptLifecycle(root)

    const session = fs.readFileSync(sessionPath, 'utf8')
    const rpc = fs.readFileSync(rpcPath, 'utf8')
    assert.equal(
      session.match(/this\._divoPromptLifecycleActive = true;/g)?.length,
      2
    )
    assert.equal(
      session.match(/this\._divoPromptLifecycleActive = false;/g)?.length,
      1
    )
    const failedPreflight = session.indexOf('preflightResult?.(false)')
    const admittedLifecycle = session.lastIndexOf(
      'this._divoPromptLifecycleActive = true;'
    )
    assert.ok(
      admittedLifecycle > failedPreflight,
      'preflight rejection and handled-command exits must occur before lifecycle ownership begins'
    )
    assert.match(session, /get divoPromptLifecycleActive\(\)/)
    assert.equal(
      rpc.match(/isPromptLifecycleActive: session\.divoPromptLifecycleActive/g)
        ?.length,
      1
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

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

test('replaces stale bundled extensions and skips retired source directories without entrypoints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'divo-pi-extension-sync-'))
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  const active = path.join(source, 'divo-gateway')
  const retired = path.join(source, 'divo-python-automation')
  fs.mkdirSync(active, { recursive: true })
  fs.mkdirSync(path.join(active, 'node_modules', 'ignored-package'), { recursive: true })
  fs.mkdirSync(path.join(active, '.yarn', 'cache'), { recursive: true })
  fs.mkdirSync(path.join(active, 'src'), { recursive: true })
  fs.mkdirSync(path.join(retired, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(destination, 'divo-python-automation'), { recursive: true })
  fs.writeFileSync(path.join(active, 'index.ts'), 'export default 1')
  fs.writeFileSync(path.join(active, 'src', 'runtime.ts'), 'export const runtime = true')
  fs.writeFileSync(path.join(active, 'node_modules', 'ignored-package', 'index.js'), 'ignored')
  fs.writeFileSync(path.join(active, '.yarn', 'cache', 'ignored.zip'), 'ignored')
  fs.writeFileSync(path.join(retired, 'node_modules', 'leftover.js'), 'ignored')
  fs.writeFileSync(path.join(destination, 'divo-python-automation', 'index.ts'), 'stale')

  try {
    assert.deepEqual(syncExecutablePiExtensions(source, destination), ['divo-gateway'])
    assert.ok(fs.existsSync(path.join(destination, 'divo-gateway', 'index.ts')))
    assert.ok(fs.existsSync(path.join(destination, 'divo-gateway', 'src', 'runtime.ts')))
    assert.ok(!fs.existsSync(path.join(destination, 'divo-gateway', 'node_modules')))
    assert.ok(!fs.existsSync(path.join(destination, 'divo-gateway', '.yarn')))
    assert.ok(!fs.existsSync(path.join(destination, 'divo-python-automation')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
