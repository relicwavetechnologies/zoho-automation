import { describe, expect, it } from 'vitest'
import {
  artifactOpenKey,
  basenamePath,
  isArtifactUpdateInMessage,
  latestDivoArtifactDetails,
  listDivoArtifactDetails,
  pathsEqual,
  readDivoArtifactDetails,
  readFileToolPath,
} from '../artifact'

function artifactPart(overrides?: Record<string, unknown>) {
  return {
    type: 'tool-divo_artifact',
    state: 'output-available',
    output: {
      details: {
        version: 2,
        artifactId: 'art-1',
        title: 'Research Brief',
        mime: 'text/markdown',
        path: '/ws/artifacts/brief.md',
        updatedAt: '2026-07-22T10:00:00.000Z',
        ...overrides,
      },
    },
  }
}

describe('divo artifact parsers', () => {
  it('reads a completed v2 path-badge tool part', () => {
    const details = readDivoArtifactDetails(artifactPart())
    expect(details).toMatchObject({
      version: 2,
      artifactId: 'art-1',
      title: 'Research Brief',
      mime: 'text/markdown',
      path: '/ws/artifacts/brief.md',
    })
    expect(details && 'content' in details).toBe(false)
  })

  it('ignores streaming, errors, and legacy v1 content payloads', () => {
    expect(
      readDivoArtifactDetails({
        type: 'tool-divo_artifact',
        state: 'input-streaming',
        output: { details: { version: 2 } },
      })
    ).toBeUndefined()
    expect(
      readDivoArtifactDetails(
        artifactPart({ error: 'file not found', path: undefined })
      )
    ).toBeUndefined()
    expect(
      readDivoArtifactDetails({
        type: 'tool-divo_artifact',
        state: 'output-available',
        output: {
          details: {
            version: 1,
            artifactId: 'art-1',
            title: 'Old',
            mime: 'text/markdown',
            path: '/tmp/a.md',
            content: '# body',
          },
        },
      })
    ).toBeUndefined()
    expect(
      readDivoArtifactDetails({ type: 'tool-divo_todos', output: { details: {} } })
    ).toBeUndefined()
  })

  it('picks the latest snapshot for the visible branch', () => {
    const messages = [
      {
        role: 'assistant',
        parts: [
          artifactPart({
            artifactId: 'art-1',
            updatedAt: '2026-07-22T10:00:00.000Z',
          }),
        ],
      },
      {
        role: 'assistant',
        parts: [
          artifactPart({
            artifactId: 'art-1',
            updatedAt: '2026-07-22T11:00:00.000Z',
            title: 'Updated',
          }),
        ],
      },
    ] as any

    const latest = latestDivoArtifactDetails(messages)
    expect(latest?.title).toBe('Updated')
    expect(artifactOpenKey(latest!)).toContain('art-1')
  })

  it('lists unique artifacts and detects in-turn updates', () => {
    const message = {
      role: 'assistant',
      parts: [
        artifactPart({
          artifactId: 'art-a',
          title: 'Plan A',
          path: '/ws/artifacts/a.md',
          updatedAt: '2026-07-22T10:00:00.000Z',
        }),
        artifactPart({
          artifactId: 'art-b',
          title: 'Plan B',
          path: '/ws/artifacts/b.md',
          updatedAt: '2026-07-22T10:01:00.000Z',
        }),
        artifactPart({
          artifactId: 'art-a',
          title: 'Plan A revised',
          path: '/ws/artifacts/a.md',
          updatedAt: '2026-07-22T10:02:00.000Z',
        }),
      ],
    } as any

    const listed = listDivoArtifactDetails(message)
    expect(listed.map((a) => a.artifactId)).toEqual(['art-a', 'art-b'])
    expect(listed[0]?.title).toBe('Plan A revised')
    expect(isArtifactUpdateInMessage(message, listed[0]!)).toBe(true)
    expect(isArtifactUpdateInMessage(message, listed[1]!)).toBe(false)
    expect(basenamePath('/ws/artifacts/a.md')).toBe('a.md')
  })

  it('reads write/edit tool paths from completed parts', () => {
    expect(
      readFileToolPath({
        type: 'tool-edit',
        state: 'output-available',
        input: { path: 'artifacts/brief.md', edits: [] },
      })
    ).toBe('artifacts/brief.md')
    expect(
      readFileToolPath({
        type: 'tool-write',
        state: 'input-available',
        input: { path: 'artifacts/brief.md', content: 'x' },
      })
    ).toBeUndefined()
  })

  it('matches relative and absolute paths for the same file', () => {
    expect(pathsEqual('/ws/artifacts/brief.md', 'artifacts/brief.md')).toBe(true)
    expect(pathsEqual('artifacts/brief.md', '/other/artifacts/brief.md')).toBe(
      true
    )
    expect(pathsEqual('/ws/a.md', '/ws/b.md')).toBe(false)
  })
})
