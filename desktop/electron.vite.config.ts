import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const resolveDesktopEnvDefines = (mode: string) => {
  const envFiles = ['.env']
  if (mode) {
    envFiles.push(`.env.${mode}`)
  }

  const env = Object.assign({}, ...envFiles.map((fileName) => {
    const filePath = resolve(process.cwd(), fileName)
    if (!existsSync(filePath)) {
      return {}
    }

    return readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .reduce<Record<string, string>>((acc, line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) {
          return acc
        }
        const separatorIndex = trimmed.indexOf('=')
        if (separatorIndex <= 0) {
          return acc
        }
        const key = trimmed.slice(0, separatorIndex).trim()
        const value = trimmed.slice(separatorIndex + 1).trim()
        acc[key] = value.replace(/^['"]|['"]$/g, '')
        return acc
      }, {})
  }))

  return {
    'process.env.DIVO_BACKEND_URL': JSON.stringify(env.DIVO_BACKEND_URL || ''),
    'process.env.DIVO_WEB_APP_URL': JSON.stringify(env.DIVO_WEB_APP_URL || ''),
  }
}

export default defineConfig(({ mode }) => {
  const define = resolveDesktopEnvDefines(mode)

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define,
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      define,
    },
    renderer: {
      server: {
        port: 5174,
        strictPort: true,
      },
      preview: {
        port: 5174,
        strictPort: true,
      },
      resolve: {
        alias: {
          '@': resolve('src/renderer/src'),
        },
      },
      plugins: [react()],
    },
  }
})
