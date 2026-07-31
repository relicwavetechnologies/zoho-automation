import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PI_EXTENSIONS_BUNDLE_ID_FILE = '.divo-bundle-id'

function isNonRuntimePiFile(fileName) {
  return fileName.endsWith('.d.ts') || fileName.endsWith('.map')
}

const IGNORED_EXTENSION_DEPENDENCY_DIRS = new Set(['node_modules', '.yarn'])

function shouldCopyExtensionPath(extensionDir, sourcePath) {
  if (sourcePath === extensionDir) return true
  return !path
    .relative(extensionDir, sourcePath)
    .split(path.sep)
    .some(segment => IGNORED_EXTENSION_DEPENDENCY_DIRS.has(segment))
}

/**
 * Replace the bundled extension directory from executable source extensions.
 * A retired source directory that contains only ignored dependencies or other
 * leftovers is deliberately excluded because it has no index.ts entrypoint.
 */
export function syncExecutablePiExtensions(sourceDir, destinationDir) {
  fs.rmSync(destinationDir, { recursive: true, force: true })
  fs.mkdirSync(destinationDir, { recursive: true })
  if (!fs.existsSync(sourceDir)) return []

  const copied = []
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const extensionDir = path.join(sourceDir, entry.name)
    if (!fs.existsSync(path.join(extensionDir, 'index.ts'))) continue
    fs.cpSync(extensionDir, path.join(destinationDir, entry.name), {
      recursive: true,
      filter: sourcePath => shouldCopyExtensionPath(extensionDir, sourcePath),
    })
    copied.push(entry.name)
  }
  return copied
}

/**
 * npm packages commonly ship declarations and source maps beside their runtime
 * JavaScript. Pi executes the JavaScript only; these files add no runtime
 * value, materially increase the installer size, and can exceed NSIS's legacy
 * Windows source-path limit when deeply nested dependencies are bundled.
 */
export function pruneBundledPiNonRuntimeFiles(resourcesPiDir) {
  const nodeModulesDir = path.join(resourcesPiDir, 'node_modules')
  if (!fs.existsSync(nodeModulesDir)) return 0

  let removed = 0
  const pending = [nodeModulesDir]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(fullPath)
      } else if (entry.isFile() && isNonRuntimePiFile(entry.name)) {
        fs.rmSync(fullPath)
        removed += 1
      }
    }
  }

  return removed
}

/**
 * Pi emits `agent_end` before its post-turn compaction/queued-message work is
 * complete. Its public `isStreaming` flag is already false in that interval,
 * which makes an RPC host unable to distinguish a settled turn from a turn
 * that is about to compact. Add one narrow lifecycle signal to the vendored
 * runtime so Jan can retain run ownership until `AgentSession._runAgentPrompt`
 * has actually returned.
 *
 * Keep this compatibility patch exact and fail closed when Pi changes its
 * generated output. That makes dependency upgrades surface here instead of
 * silently reintroducing the prompt-admission race.
 */
export function patchBundledPiPromptLifecycle(resourcesPiDir) {
  const packageRoot = path.join(
    resourcesPiDir,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist'
  )
  const sessionPath = path.join(packageRoot, 'core', 'agent-session.js')
  const rpcPath = path.join(packageRoot, 'modes', 'rpc', 'rpc-mode.js')

  const sessionOriginal = `    async _runAgentPrompt(messages) {
        try {
            await this.agent.prompt(messages);`
  const sessionPatched = `    async _runAgentPrompt(messages) {
        this._divoPromptLifecycleActive = true;
        try {
            await this.agent.prompt(messages);`
  const finallyOriginal = `        finally {
            this._systemPromptOverride = undefined;`
  const finallyPatched = `        finally {
            this._divoPromptLifecycleActive = false;
            this._systemPromptOverride = undefined;`
  // This anchor is after prompt preflight's catch/early-return paths. Set the
  // flag immediately before acknowledging admission so the Rust host can
  // never observe an accepted prompt as idle.
  const admissionOriginal = `        preflightResult?.(true);
        await this._runAgentPrompt(messages);`
  const admissionPatched = `        this._divoPromptLifecycleActive = true;
        preflightResult?.(true);
        await this._runAgentPrompt(messages);`
  const getterAnchor = `    get isStreaming() {
        return this.agent.state.isStreaming;
    }`
  const getterPatched = `    get isStreaming() {
        return this.agent.state.isStreaming;
    }
    /** Divo RPC host lifecycle: true through post-turn compaction and queued continuations. */
    get divoPromptLifecycleActive() {
        return this._divoPromptLifecycleActive === true;
    }`

  let sessionSource = fs.readFileSync(sessionPath, 'utf8')
  if (!sessionSource.includes(sessionPatched)) {
    if (!sessionSource.includes(sessionOriginal)) {
      throw new Error(`Unexpected Pi prompt lifecycle format: ${sessionPath}`)
    }
    sessionSource = sessionSource.replace(sessionOriginal, sessionPatched)
  }
  if (!sessionSource.includes(finallyPatched)) {
    if (!sessionSource.includes(finallyOriginal)) {
      throw new Error(`Unexpected Pi prompt lifecycle cleanup format: ${sessionPath}`)
    }
    sessionSource = sessionSource.replace(finallyOriginal, finallyPatched)
  }
  if (!sessionSource.includes(admissionPatched)) {
    if (!sessionSource.includes(admissionOriginal)) {
      throw new Error(`Unexpected Pi prompt admission format: ${sessionPath}`)
    }
    sessionSource = sessionSource.replace(admissionOriginal, admissionPatched)
  }
  if (!sessionSource.includes(getterPatched)) {
    if (!sessionSource.includes(getterAnchor)) {
      throw new Error(`Unexpected Pi prompt lifecycle getter format: ${sessionPath}`)
    }
    sessionSource = sessionSource.replace(getterAnchor, getterPatched)
  }
  fs.writeFileSync(sessionPath, sessionSource)

  const rpcOriginal = `                    isStreaming: session.isStreaming,
                    isCompacting: session.isCompacting,`
  const rpcPatched = `                    isStreaming: session.isStreaming,
                    isCompacting: session.isCompacting,
                    isPromptLifecycleActive: session.divoPromptLifecycleActive,`
  let rpcSource = fs.readFileSync(rpcPath, 'utf8')
  if (!rpcSource.includes(rpcPatched)) {
    if (!rpcSource.includes(rpcOriginal)) {
      throw new Error(`Unexpected Pi RPC state format: ${rpcPath}`)
    }
    rpcSource = rpcSource.replace(rpcOriginal, rpcPatched)
    fs.writeFileSync(rpcPath, rpcSource)
  }
}

/**
 * Produce a deterministic identity for the exact extension bundle shipped in
 * the app. Runtime uses this small marker to avoid rewriting a several-hundred
 * megabyte shared mirror every time another chat starts.
 */
export function computePiExtensionsBundleId(extensionsDir) {
  const hash = createHash('sha256')
  const pending = [extensionsDir]
  const files = []

  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === extensionsDir && entry.name === PI_EXTENSIONS_BUNDLE_ID_FILE) {
        continue
      }
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(fullPath)
      else if (entry.isFile()) files.push(fullPath)
      else if (entry.isSymbolicLink()) {
        const target = fs.statSync(fullPath)
        if (target.isDirectory()) {
          throw new Error(`Directory symlinks are unsupported in bundled Pi extensions: ${fullPath}`)
        }
        if (target.isFile()) files.push(fullPath)
      }
    }
  }

  files.sort((left, right) =>
    path.relative(extensionsDir, left).localeCompare(path.relative(extensionsDir, right))
  )
  for (const file of files) {
    const relative = path.relative(extensionsDir, file).split(path.sep).join('/')
    hash.update(relative)
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function writePiExtensionsBundleId(extensionsDir) {
  const bundleId = computePiExtensionsBundleId(extensionsDir)
  fs.writeFileSync(
    path.join(extensionsDir, PI_EXTENSIONS_BUNDLE_ID_FILE),
    `${bundleId}\n`
  )
  return bundleId
}
