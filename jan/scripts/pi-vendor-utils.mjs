import fs from 'node:fs'
import path from 'node:path'

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
