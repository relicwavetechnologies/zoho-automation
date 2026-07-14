/**
 * Vendor Pi runtime into src-tauri/resources/pi for bundled dev + release builds.
 * Run via: yarn vendor:pi
 */
import { execFileSync, execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pruneBundledPiNonRuntimeFiles } from './pi-vendor-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const janRoot = path.resolve(__dirname, '..')
const versions = JSON.parse(
  fs.readFileSync(path.join(janRoot, 'pi-versions.json'), 'utf8')
)

const resourcesPi = path.join(janRoot, 'src-tauri/resources/pi')
const resourcesExtensions = path.join(janRoot, 'src-tauri/resources/pi-extensions')
const resourcesSkills = path.join(janRoot, 'src-tauri/resources/pi-skills')
const resourcesLarkCli = path.join(janRoot, 'src-tauri/resources/lark-cli')
const sourceExtensions = path.join(janRoot, 'pi-extensions')
const sourceSkills = path.join(janRoot, 'pi-skills')

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

function collectDirectories(root, shouldRemove, matches = []) {
  if (!fs.existsSync(root)) return matches
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const fullPath = path.join(root, entry.name)
    if (shouldRemove(entry.name)) matches.push(fullPath)
    else collectDirectories(fullPath, shouldRemove, matches)
  }
  return matches
}

function prepareMacNativePackages(resourcesPiDir) {
  const target = process.env.JAN_MACOS_TARGET
  if (!['x86_64', 'aarch64', 'universal'].includes(target)) return

  const recheckPackage = JSON.parse(
    fs.readFileSync(path.join(resourcesPiDir, 'node_modules/recheck/package.json'), 'utf8')
  )
  const packages =
    target === 'universal'
      ? ['recheck-macos-arm64', 'recheck-macos-x64']
      : [target === 'x86_64' ? 'recheck-macos-x64' : 'recheck-macos-arm64']

  for (const packageName of packages) {
    const version = recheckPackage.optionalDependencies?.[packageName]
    if (!version) throw new Error(`Unable to resolve ${packageName} from recheck`)
    execFileSync(
      'npm',
      [
        'install',
        '--no-save',
        '--omit=dev',
        '--no-package-lock',
        '--force',
        `${packageName}@${version}`,
      ],
      {
        cwd: resourcesPiDir,
        stdio: 'inherit',
      }
    )
  }

  if (target === 'universal') return

  const excludedArchitecture = target === 'x86_64' ? 'arm64' : 'x64'
  const excludedNames =
    excludedArchitecture === 'arm64'
      ? ['darwin-arm64', 'darwin_arm64', 'macos-arm64']
      : ['darwin-x64', 'darwin_x64', 'macos-x64']
  const directories = collectDirectories(
    path.join(resourcesPiDir, 'node_modules'),
    (name) => excludedNames.some((excludedName) => name.includes(excludedName))
  ).sort((left, right) => right.length - left.length)

  for (const directory of directories) {
    console.log(`Removing non-target Pi native package: ${path.relative(resourcesPiDir, directory)}`)
    rmrf(directory)
  }
}

function prepareMacLarkCli(resourcesLarkCliDir) {
  const target = process.env.JAN_MACOS_TARGET
  if (!['x86_64', 'aarch64', 'universal'].includes(target)) return

  const packageDir = path.join(resourcesLarkCliDir, 'node_modules/@larksuite/cli')
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  const checksums = fs.readFileSync(path.join(packageDir, 'checksums.txt'), 'utf8')
  const architectures =
    target === 'universal'
      ? ['arm64', 'amd64']
      : [target === 'x86_64' ? 'amd64' : 'arm64']
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jan-lark-cli-'))
  const binaries = new Map()

  try {
    for (const architecture of architectures) {
      const archiveName = `lark-cli-${packageJson.version}-darwin-${architecture}.tar.gz`
      const expectedHash = checksums
        .split('\n')
        .find((line) => line.trim().endsWith(`  ${archiveName}`))
        ?.trim()
        .split(/\s+/)[0]
      if (!expectedHash) throw new Error(`Missing checksum for ${archiveName}`)

      const archivePath = path.join(tempDir, archiveName)
      execFileSync(
        'curl',
        [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--output',
          archivePath,
          `https://github.com/larksuite/cli/releases/download/v${packageJson.version}/${archiveName}`,
        ],
        { stdio: 'inherit' }
      )
      const actualHash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(archivePath))
        .digest('hex')
      if (actualHash !== expectedHash) throw new Error(`Checksum mismatch for ${archiveName}`)

      const extractDir = path.join(tempDir, architecture)
      fs.mkdirSync(extractDir, { recursive: true })
      execFileSync('tar', ['-xzf', archivePath, '-C', extractDir])
      binaries.set(architecture, path.join(extractDir, 'lark-cli'))
    }

    const destination = path.join(packageDir, 'bin/lark-cli')
    if (target === 'universal') {
      execFileSync('lipo', [
        '-create',
        binaries.get('arm64'),
        binaries.get('amd64'),
        '-output',
        destination,
      ])
    } else {
      fs.copyFileSync(binaries.values().next().value, destination)
    }
    fs.chmodSync(destination, 0o755)
    console.log(`Staged Lark CLI for ${target}`)
  } finally {
    rmrf(tempDir)
  }
}

function patchBundledPiReadTool(resourcesPiDir) {
  const readToolPath = path.join(
    resourcesPiDir,
    'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js'
  )
  const originalDescription =
    'description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,'
  const patchedDescription =
    'description: `Read the contents of a text file. Do not use this tool to understand image contents unless the current model explicitly supports native image input. For non-vision models, image reading is unsupported; use local image/OCR helper scripts instead. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,'
  const originalGuidelines =
    'promptGuidelines: ["Use read to examine files instead of cat or sed."],'
  const patchedGuidelines = `promptGuidelines: [
            "Use read to examine text files instead of cat or sed.",
            "For non-vision models, do not use read for images; use local image/OCR helper scripts instead.",
        ],`

  let source = fs.readFileSync(readToolPath, 'utf8')
  if (!source.includes(originalDescription) && !source.includes(patchedDescription)) {
    throw new Error(`Unexpected Pi read tool description format: ${readToolPath}`)
  }
  source = source
    .replace(originalDescription, patchedDescription)
    .replace(originalGuidelines, patchedGuidelines)
  fs.writeFileSync(readToolPath, source)
}

console.log('Vendoring Pi into src-tauri/resources/pi ...')

rmrf(resourcesPi)
fs.mkdirSync(resourcesPi, { recursive: true })

const pkg = {
  name: 'jan-bundled-pi',
  private: true,
  type: 'module',
  dependencies: {
    '@earendil-works/pi-coding-agent': versions.piCodingAgent,
    'pi-mcp-adapter': versions.piMcpAdapter,
    'chrome-devtools-mcp': 'latest',
  },
}
fs.writeFileSync(
  path.join(resourcesPi, 'package.json'),
  JSON.stringify(pkg, null, 2)
)

execSync('npm install --omit=dev --no-package-lock', {
  cwd: resourcesPi,
  stdio: 'inherit',
})
prepareMacNativePackages(resourcesPi)

const cliJs = path.join(
  resourcesPi,
  'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
)
if (!fs.existsSync(cliJs)) {
  throw new Error(`Pi CLI missing after install: ${cliJs}`)
}
patchBundledPiReadTool(resourcesPi)
const prunedPiFiles = pruneBundledPiNonRuntimeFiles(resourcesPi)
console.log(`Pruned ${prunedPiFiles} non-runtime Pi declaration/source-map files`)

// Stage pi-mcp-adapter where Pi's package manager expects it under the agent dir.
const agentNpmDir = path.join(resourcesPi, 'agent-npm')
rmrf(agentNpmDir)
fs.mkdirSync(agentNpmDir, { recursive: true })
const mcpAdapterSrc = path.join(resourcesPi, 'node_modules/pi-mcp-adapter')
if (fs.existsSync(mcpAdapterSrc)) {
  copyDir(mcpAdapterSrc, path.join(agentNpmDir, 'pi-mcp-adapter'))
}

// Default agent settings (packages + empty mcp — user can extend via Jan MCP sync later).
const agentTemplate = path.join(resourcesPi, 'agent-template')
rmrf(agentTemplate)
fs.mkdirSync(agentTemplate, { recursive: true })
fs.copyFileSync(
  path.join(janRoot, 'scripts/pi-chrome-devtools-bridge.mjs'),
  path.join(resourcesPi, 'pi-chrome-devtools-bridge.mjs')
)
fs.writeFileSync(
  path.join(agentTemplate, 'settings.json'),
  JSON.stringify(
    {
      packages: ['npm:pi-mcp-adapter'],
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      defaultThinkingLevel: 'medium',
    },
    null,
    2
  )
)
// mcp.json is generated at runtime into ~/Library/.../Jan/pi-agent/mcp.json

// Copy Jan Pi extensions.
rmrf(resourcesExtensions)
fs.mkdirSync(resourcesExtensions, { recursive: true })
if (fs.existsSync(sourceExtensions)) {
  for (const name of fs.readdirSync(sourceExtensions)) {
    copyDir(path.join(sourceExtensions, name), path.join(resourcesExtensions, name))
  }
}
fs.writeFileSync(path.join(resourcesExtensions, '.gitkeep'), '')
for (const name of fs.readdirSync(resourcesExtensions)) {
  if (name === '.gitkeep') continue
  const extDir = path.join(resourcesExtensions, name)
  if (!fs.statSync(extDir).isDirectory()) continue
  if (!fs.existsSync(path.join(extDir, 'package.json'))) continue
  console.log(`Installing extension deps: ${name}`)
  execSync('npm install --omit=dev --no-package-lock', {
    cwd: extDir,
    stdio: 'inherit',
  })
}

// Copy Jan-owned Pi skills. Runtime installs these into ~/.divo/skills/company.
rmrf(resourcesSkills)
fs.mkdirSync(resourcesSkills, { recursive: true })
if (fs.existsSync(sourceSkills)) {
  for (const name of fs.readdirSync(sourceSkills)) {
    copyDir(path.join(sourceSkills, name), path.join(resourcesSkills, name))
  }
}
fs.writeFileSync(path.join(resourcesSkills, '.gitkeep'), '')

console.log('Pi vendored successfully.')
console.log(`  CLI: ${cliJs}`)

console.log('Vendoring Lark CLI into src-tauri/resources/lark-cli ...')

rmrf(resourcesLarkCli)
fs.mkdirSync(resourcesLarkCli, { recursive: true })

const larkPkg = {
  name: 'jan-bundled-lark-cli',
  private: true,
  dependencies: {
    '@larksuite/cli': versions.larkCli,
  },
}
fs.writeFileSync(
  path.join(resourcesLarkCli, 'package.json'),
  JSON.stringify(larkPkg, null, 2)
)

execSync('npm install --omit=dev --no-package-lock', {
  cwd: resourcesLarkCli,
  stdio: 'inherit',
})
prepareMacLarkCli(resourcesLarkCli)

const larkCliBinaryName = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
const larkCli = path.join(
  resourcesLarkCli,
  `node_modules/@larksuite/cli/bin/${larkCliBinaryName}`
)
if (!fs.existsSync(larkCli)) {
  throw new Error(`Lark CLI missing after install: ${larkCli}`)
}

console.log('Lark CLI vendored successfully.')
console.log(`  CLI: ${larkCli}`)
