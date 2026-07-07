/**
 * Vendor Pi runtime into src-tauri/resources/pi for bundled dev + release builds.
 * Run via: yarn vendor:pi
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const janRoot = path.resolve(__dirname, '..')
const versions = JSON.parse(
  fs.readFileSync(path.join(janRoot, 'pi-versions.json'), 'utf8')
)

const resourcesPi = path.join(janRoot, 'src-tauri/resources/pi')
const resourcesExtensions = path.join(janRoot, 'src-tauri/resources/pi-extensions')
const sourceExtensions = path.join(janRoot, 'pi-extensions')

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
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

const cliJs = path.join(
  resourcesPi,
  'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
)
if (!fs.existsSync(cliJs)) {
  throw new Error(`Pi CLI missing after install: ${cliJs}`)
}

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
      defaultModel: 'deepseek-v4-pro',
      defaultThinkingLevel: 'medium',
    },
    null,
    2
  )
)
// mcp.json is generated at runtime into ~/Library/.../Jan/pi-agent/mcp.json

// Copy Jan Pi extensions (browser-brave is replaced by bundled MCP).
rmrf(resourcesExtensions)
fs.mkdirSync(resourcesExtensions, { recursive: true })
if (fs.existsSync(sourceExtensions)) {
  for (const name of fs.readdirSync(sourceExtensions)) {
    if (name === 'browser-brave') continue
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

console.log('Pi vendored successfully.')
console.log(`  CLI: ${cliJs}`)
