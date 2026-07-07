/**
 * MCP stdio bridge: reads DevToolsActivePort at spawn time and launches
 * chrome-devtools-mcp with --wsEndpoint (Brave/Chrome 144+ remote debugging).
 *
 * Usage (from pi-agent mcp.json):
 *   bun run <this-script> <chrome-devtools-mcp.js>
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const mcpScript = process.argv[2]
if (!mcpScript) {
  process.stderr.write(
    'pi-chrome-devtools-bridge: missing chrome-devtools-mcp.js path\n'
  )
  process.exit(1)
}

function profileDirs() {
  const override = process.env.PI_BROWSER_USER_DATA_DIR?.trim()
  if (override) return [override]

  const home = homedir()
  if (process.platform === 'darwin') {
    return [
      join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
      join(home, 'Library/Application Support/Google/Chrome'),
      join(home, 'Library/Application Support/Microsoft Edge'),
    ]
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData/Local')
    return [
      join(local, 'BraveSoftware/Brave-Browser/User Data'),
      join(local, 'Google/Chrome/User Data'),
      join(local, 'Microsoft/Edge/User Data'),
    ]
  }
  return [
    join(home, '.config/BraveSoftware/Brave-Browser'),
    join(home, '.config/google-chrome'),
    join(home, '.config/microsoft-edge'),
  ]
}

function readWsEndpoint(profileDir) {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const raw = readFileSync(portFile, 'utf8')
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const port = lines[0]
  const wsPath = lines[1]
  if (!port || !wsPath || !/^\d+$/.test(port)) {
    throw new Error(`Invalid DevToolsActivePort in ${portFile}`)
  }
  return `ws://127.0.0.1:${port}${wsPath}`
}

function resolveWsEndpoint() {
  for (const dir of profileDirs()) {
    const portFile = join(dir, 'DevToolsActivePort')
    if (!existsSync(portFile)) continue
    try {
      return { ws: readWsEndpoint(dir), profile: dir }
    } catch {
      continue
    }
  }
  throw new Error(
    'No browser CDP endpoint found. Open Brave, go to brave://inspect/#remote-debugging, ' +
      'enable "Allow remote debugging for this browser instance", then retry.'
  )
}

let wsEndpoint
try {
  const resolved = resolveWsEndpoint()
  wsEndpoint = resolved.ws
  process.stderr.write(
    `[jan-pi-browser] attaching via ${wsEndpoint} (${resolved.profile})\n`
  )
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[jan-pi-browser] ${message}\n`)
  process.exit(1)
}

const runner = process.execPath
const child = spawn(
  runner,
  ['run', mcpScript, `--wsEndpoint=${wsEndpoint}`],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  }
)

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)

child.on('error', (err) => {
  process.stderr.write(`[jan-pi-browser] failed to spawn MCP: ${err.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

process.stdin.on('end', () => {
  child.stdin.end()
})

process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
