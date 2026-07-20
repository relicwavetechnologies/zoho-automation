import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PI_EXTENSIONS_BUNDLE_ID_FILE = '.divo-bundle-id'

function isNonRuntimePiFile(fileName) {
  return fileName.endsWith('.d.ts') || fileName.endsWith('.map')
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
