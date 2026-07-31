import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import tar from 'tar'
import unzipper from 'unzipper'

const BIN_DIR = 'src-tauri/resources/bin'
const TEMP_DIR = 'scripts/dist'

const MAC_ARCHITECTURES = {
  aarch64: {
    bunAsset: 'darwin-aarch64',
    nodeArch: 'arm64',
    triple: 'aarch64-apple-darwin',
    uvAsset: 'aarch64-apple-darwin',
  },
  x86_64: {
    bunAsset: 'darwin-x64',
    nodeArch: 'x64',
    triple: 'x86_64-apple-darwin',
    uvAsset: 'x86_64-apple-darwin',
  },
}

export function resolveMacTarget(env = process.env, hostArch = os.arch()) {
  const requested = env.JAN_MACOS_TARGET || env.TAURI_ENV_TARGET_TRIPLE

  if (!requested) return hostArch === 'arm64' ? 'aarch64' : 'x86_64'
  if (requested === 'universal' || requested === 'universal-apple-darwin') {
    return 'universal'
  }
  if (requested === 'aarch64' || requested === 'aarch64-apple-darwin') {
    return 'aarch64'
  }
  if (requested === 'x86_64' || requested === 'x86_64-apple-darwin') {
    return 'x86_64'
  }

  throw new Error(`Unsupported JAN_MACOS_TARGET: ${requested}`)
}

export function macArchitecturesForTarget(target) {
  if (target === 'universal') {
    return [MAC_ARCHITECTURES.aarch64, MAC_ARCHITECTURES.x86_64]
  }
  return [MAC_ARCHITECTURES[target]]
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const partialDestination = `${destination}.partial`
    fs.rmSync(partialDestination, { force: true })

    const request = (currentUrl) => {
      https
        .get(currentUrl, (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume()
            request(new URL(response.headers.location, currentUrl).toString())
            return
          }
          if (response.statusCode !== 200) {
            response.resume()
            reject(new Error(`Failed to get '${currentUrl}' (${response.statusCode})`))
            return
          }

          const file = fs.createWriteStream(partialDestination)
          response.pipe(file)
          file.on('finish', () => {
            file.close(() => {
              fs.renameSync(partialDestination, destination)
              resolve()
            })
          })
          file.on('error', (error) => {
            fs.rmSync(partialDestination, { force: true })
            reject(error)
          })
        })
        .on('error', (error) => {
          fs.rmSync(partialDestination, { force: true })
          reject(error)
        })
    }

    console.log(`Downloading ${url} to ${destination}`)
    request(url)
  })
}

async function decompress(archivePath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  console.log(`Decompressing ${archivePath} to ${targetDir}`)
  if (archivePath.endsWith('.zip')) {
    await fs
      .createReadStream(archivePath)
      .pipe(unzipper.Extract({ path: targetDir }))
      .promise()
    return
  }
  if (archivePath.endsWith('.tar.gz')) {
    await tar.x({ file: archivePath, cwd: targetDir })
    return
  }
  throw new Error(`Unsupported archive format: ${archivePath}`)
}

async function downloadAndExtract(url, archivePath, extractDir) {
  if (!fs.existsSync(archivePath)) await download(url, archivePath)
  if (!fs.existsSync(extractDir)) await decompress(archivePath, extractDir)
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'jan-app',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`

    https
      .get(
        url,
        {
          headers,
        },
        (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume()
            getJson(new URL(response.headers.location, url).toString()).then(resolve, reject)
            return
          }
          if (response.statusCode !== 200) {
            response.resume()
            reject(new Error(`GET ${url} failed with status ${response.statusCode}`))
            return
          }

          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => {
            try {
              resolve(JSON.parse(body))
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      .on('error', reject)
  })
}

function copyExecutable(source, destination) {
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o755)
}

function createUniversalBinary(armPath, intelPath, outputPath) {
  execFileSync('lipo', ['-create', armPath, intelPath, '-output', outputPath], {
    stdio: 'inherit',
  })
  fs.chmodSync(outputPath, 0o755)
}

async function stageMacBun(architectures, target) {
  const staged = new Map()
  for (const architecture of architectures) {
    const archive = path.join(TEMP_DIR, `bun-${architecture.bunAsset}.zip`)
    const extractDir = path.join(TEMP_DIR, `bun-extract-${architecture.bunAsset}`)
    const url = `https://github.com/oven-sh/bun/releases/latest/download/bun-${architecture.bunAsset}.zip`
    await downloadAndExtract(url, archive, extractDir)

    const source = path.join(extractDir, `bun-${architecture.bunAsset}`, 'bun')
    const destination = path.join(BIN_DIR, `bun-${architecture.triple}`)
    copyExecutable(source, destination)
    staged.set(architecture.triple, destination)
  }

  if (target === 'universal') {
    const universal = path.join(BIN_DIR, 'bun-universal-apple-darwin')
    createUniversalBinary(
      staged.get('aarch64-apple-darwin'),
      staged.get('x86_64-apple-darwin'),
      universal
    )
    copyExecutable(universal, path.join(BIN_DIR, 'bun'))
  } else {
    copyExecutable(staged.values().next().value, path.join(BIN_DIR, 'bun'))
  }
}

async function stageMacUv(architectures, target) {
  const staged = new Map()
  for (const architecture of architectures) {
    const archive = path.join(TEMP_DIR, `uv-${architecture.uvAsset}.tar.gz`)
    const extractDir = path.join(TEMP_DIR, `uv-extract-${architecture.uvAsset}`)
    const url = `https://github.com/astral-sh/uv/releases/latest/download/uv-${architecture.uvAsset}.tar.gz`
    await downloadAndExtract(url, archive, extractDir)

    const source = path.join(extractDir, `uv-${architecture.uvAsset}`, 'uv')
    const destination = path.join(BIN_DIR, `uv-${architecture.triple}`)
    copyExecutable(source, destination)
    staged.set(architecture.triple, destination)
  }

  if (target === 'universal') {
    const universal = path.join(BIN_DIR, 'uv-universal-apple-darwin')
    createUniversalBinary(
      staged.get('aarch64-apple-darwin'),
      staged.get('x86_64-apple-darwin'),
      universal
    )
    copyExecutable(universal, path.join(BIN_DIR, 'uv'))
  } else {
    copyExecutable(staged.values().next().value, path.join(BIN_DIR, 'uv'))
  }
}

function findFile(root, suffix) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(fullPath, suffix)
      if (nested) return nested
    } else if (entry.name.endsWith(suffix)) {
      return fullPath
    }
  }
  return null
}

async function sqliteVecAssetUrl(nodeArch) {
  const release = await getJson('https://api.github.com/repos/asg017/sqlite-vec/releases/latest')
  const architecture = nodeArch === 'arm64' ? 'aarch64' : 'x86_64'
  const suffix = `loadable-macos-${architecture}.tar.gz`
  const asset = release.assets?.find((candidate) => candidate.name.endsWith(suffix))
  return asset?.browser_download_url || null
}

async function stageMacSqliteVec(architectures, target) {
  const overrideUrl = process.env.SQLVEC_URL || process.env.JAN_SQLITE_VEC_URL
  const staged = new Map()

  for (const architecture of architectures) {
    const archive = path.join(TEMP_DIR, `sqlite-vec-${architecture.triple}.tar.gz`)
    const extractDir = path.join(TEMP_DIR, `sqlite-vec-extract-${architecture.triple}`)
    if (!fs.existsSync(archive)) {
      const url = overrideUrl || (await sqliteVecAssetUrl(architecture.nodeArch))
      if (!url) throw new Error(`No sqlite-vec asset found for ${architecture.triple}`)
      await download(url, archive)
    } else {
      console.log(`Reusing cached sqlite-vec archive for ${architecture.triple}`)
    }
    if (!fs.existsSync(extractDir)) await decompress(archive, extractDir)

    const source = findFile(extractDir, '.dylib')
    if (!source) throw new Error(`No sqlite-vec dylib found for ${architecture.triple}`)

    const destination = path.join(BIN_DIR, `sqlite-vec-${architecture.triple}.dylib`)
    fs.copyFileSync(source, destination)
    staged.set(architecture.triple, destination)
  }

  const destination = path.join(BIN_DIR, 'sqlite-vec.dylib')
  if (target === 'universal') {
    createUniversalBinary(
      staged.get('aarch64-apple-darwin'),
      staged.get('x86_64-apple-darwin'),
      destination
    )
  } else {
    fs.copyFileSync(staged.values().next().value, destination)
  }
}

async function stageMacBinaries() {
  const target = resolveMacTarget()
  const architectures = macArchitecturesForTarget(target)
  console.log(`Preparing macOS binaries for ${target}`)
  await stageMacBun(architectures, target)
  await stageMacUv(architectures, target)
  await stageMacSqliteVec(architectures, target)
}

function nativePlatformAssets(platform, arch) {
  if (platform === 'linux') {
    return {
      bunAsset: arch === 'arm64' ? 'linux-aarch64' : 'linux-x64',
      bunTriple: arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
      uvAsset: arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
    }
  }
  return {
    bunAsset: 'windows-x64',
    bunTriple: 'x86_64-pc-windows-msvc',
    uvAsset: 'x86_64-pc-windows-msvc',
  }
}

async function stageNativeBinaries(platform) {
  const assets = nativePlatformAssets(platform, os.arch())
  const windows = platform === 'win32'
  const bunArchive = path.join(TEMP_DIR, `bun-${assets.bunAsset}.zip`)
  const bunExtract = path.join(TEMP_DIR, `bun-extract-${assets.bunAsset}`)
  await downloadAndExtract(
    `https://github.com/oven-sh/bun/releases/latest/download/bun-${assets.bunAsset}.zip`,
    bunArchive,
    bunExtract
  )
  const bunName = windows ? 'bun.exe' : 'bun'
  copyExecutable(
    path.join(bunExtract, `bun-${assets.bunAsset}`, bunName),
    path.join(BIN_DIR, bunName)
  )
  copyExecutable(
    path.join(BIN_DIR, bunName),
    path.join(BIN_DIR, `bun-${assets.bunTriple}${windows ? '.exe' : ''}`)
  )

  const uvExtension = windows ? 'zip' : 'tar.gz'
  const uvArchive = path.join(TEMP_DIR, `uv-${assets.uvAsset}.${uvExtension}`)
  const uvExtract = path.join(TEMP_DIR, `uv-extract-${assets.uvAsset}`)
  await downloadAndExtract(
    `https://github.com/astral-sh/uv/releases/latest/download/uv-${assets.uvAsset}.${uvExtension}`,
    uvArchive,
    uvExtract
  )
  const uvName = windows ? 'uv.exe' : 'uv'
  const uvSource = windows
    ? findFile(uvExtract, 'uv.exe')
    : path.join(uvExtract, `uv-${assets.uvAsset}`, 'uv')
  copyExecutable(uvSource, path.join(BIN_DIR, uvName))
  copyExecutable(
    path.join(BIN_DIR, uvName),
    path.join(BIN_DIR, `uv-${assets.uvAsset}${windows ? '.exe' : ''}`)
  )
}

async function main() {
  if (process.env.SKIP_BINARIES) {
    console.log('Skipping binaries download.')
    return
  }

  fs.mkdirSync(BIN_DIR, { recursive: true })
  fs.mkdirSync(TEMP_DIR, { recursive: true })
  const platform = os.platform()
  if (platform === 'darwin') await stageMacBinaries()
  else if (platform === 'linux' || platform === 'win32') await stageNativeBinaries(platform)
  else throw new Error(`Unsupported platform: ${platform}`)
  console.log('Downloads completed.')
}

const isDirectExecution =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isDirectExecution) {
  main().catch((error) => {
    console.error('Error:', error)
    process.exit(1)
  })
}
