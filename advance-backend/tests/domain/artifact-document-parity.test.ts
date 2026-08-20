import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildDocument } from '../../src/domain/artifact/document.ts'

const backendDocumentUrl = new URL('../../src/domain/artifact/document.ts', import.meta.url)
const backendChartUrl = new URL('../../src/domain/artifact/chart-geometry.ts', import.meta.url)
const adminDocumentUrl = new URL('../../../admin/src/pages/workspace/artifacts/document.ts', import.meta.url)
const adminChartUrl = new URL('../../../admin/src/lib/chart-geometry.ts', import.meta.url)
const adminRoot = fileURLToPath(new URL('../../../admin/', import.meta.url))

const fixtures = [
  '',
  '<p>hi</p>',
  '<div class="card"><span class="tag">A & B</span></div>',
] as const

function adminPages(): string[] {
  const input = JSON.stringify(fixtures.flatMap(body =>
    (['light', 'dark'] as const).map(theme => ({ body, theme })),
  ))
  const script = [
    "import { buildDocument } from './src/pages/workspace/artifacts/document.ts'",
    'const cases = JSON.parse(process.env.DIVO_ARTIFACT_PARITY_INPUT)',
    'process.stdout.write(JSON.stringify(cases.map(({ body, theme }) => buildDocument(body, theme))))',
  ].join(';')
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--eval', script],
    {
      cwd: adminRoot,
      env: { ...process.env, DIVO_ARTIFACT_PARITY_INPUT: input },
      encoding: 'utf8',
    },
  )
  return JSON.parse(output) as string[]
}

function normaliseDocumentSource(source: string): string {
  return source
    .replace(
      "import { CHART_GEOMETRY_SOURCE } from './chart-geometry'",
      "import { CHART_GEOMETRY_SOURCE } from '@/lib/chart-geometry'",
    )
    .replace(
      `/** Where the finished page will run. Not a style — a security posture. */
export type DocumentMode = 'panel' | 'standalone'

export interface StandaloneOptions {
  /** Shown in the tab and above the document. */
  readonly title: string;
  /** SHA-256 hex of the gate password. Absent means no gate. */
  readonly gateHash?: string;
}
`,
      '',
    )
    .replace(
      "export function buildDocument(\n  body: string,\n  theme: DocumentTheme = 'light',\n  mode: DocumentMode = 'panel',\n  standalone?: StandaloneOptions,\n): string {\n  if (mode === 'standalone') {\n    throw new Error('not implemented')\n  }\n",
      "export function buildDocument(body: string, theme: DocumentTheme = 'light'): string {\n",
    )
}

describe('artifact wrapper parity', () => {
  it('keeps the backend wrapper source identical to the admin copy', () => {
    assert.equal(
      normaliseDocumentSource(readFileSync(backendDocumentUrl, 'utf8')),
      readFileSync(adminDocumentUrl, 'utf8'),
    )
    assert.equal(
      readFileSync(backendChartUrl, 'utf8'),
      readFileSync(adminChartUrl, 'utf8'),
    )
  })

  it('renders the same pages for existing fixture bodies in both themes', () => {
    const admin = adminPages()
    const backend = fixtures.flatMap(body =>
      (['light', 'dark'] as const).map(theme => buildDocument(body, theme)),
    )
    assert.deepEqual(backend, admin)
  })
})
