import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDivoSkillSearchCache,
  searchDivoSkills,
} from '../divo-skill-search'

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriCoreMock.invoke,
}))

describe('searchDivoSkills', () => {
  beforeEach(() => {
    tauriCoreMock.invoke.mockReset()
    clearDivoSkillSearchCache()
  })

  it('does not call the gateway for empty search text', async () => {
    await expect(searchDivoSkills('   ')).resolves.toEqual([])
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled()
  })

  it('maps successful gateway skills into drawer results', async () => {
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'divo_get_session_status') {
        return {
          configured: true,
          backendUrl: 'http://localhost:8000',
          userId: 'user-1',
          companyId: 'company-1',
          role: 'member',
          departmentId: 'dept-1',
          expiresAt: '2026-07-09T10:00:00Z',
        }
      }

      return {
      ok: true,
      status: 'success',
      data: {
        skills: [
          {
            id: 'google',
            name: 'Google Workspace',
            description: 'Use Gmail, Drive, and Calendar.',
            score: 6,
            toolIds: ['googleGmail', 'googleDrive'],
          },
        ],
      },
      }
    })

    await expect(searchDivoSkills('google')).resolves.toEqual([
      {
        id: 'google',
        name: 'Google Workspace',
        description: 'Use Gmail, Drive, and Calendar.',
        category: 'Google',
        score: 3,
        toolIds: ['googleGmail', 'googleDrive'],
      },
    ])
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'divo_get_session_status'
    )
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'divo_gateway_request',
      {
        op: 'skills.list',
        payload: { context: { surface: 'desktop_composer_reference' } },
      }
    )
  })

  it('caches the skill catalog and reranks it for later queries', async () => {
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'divo_get_session_status') {
        return {
          configured: true,
          backendUrl: 'http://localhost:8000',
          userId: 'user-1',
          companyId: 'company-1',
          role: 'member',
          departmentId: 'dept-1',
          expiresAt: '2026-07-09T10:00:00Z',
        }
      }

      return {
        ok: true,
        status: 'success',
        data: {
          skills: [
            {
              id: 'google',
              name: 'Google Workspace',
              description: 'Use Gmail, Drive, and Calendar.',
              toolIds: ['googleGmail', 'googleCalendar'],
            },
            {
              id: 'zoho',
              name: 'Zoho',
              description: 'Use CRM and Books.',
              toolIds: ['zohoCrm'],
            },
          ],
        },
      }
    })

    await expect(searchDivoSkills('gmail')).resolves.toEqual([
      expect.objectContaining({ id: 'google' }),
    ])
    await expect(searchDivoSkills('calendar')).resolves.toEqual([
      expect.objectContaining({ id: 'google' }),
    ])

    expect(
      tauriCoreMock.invoke.mock.calls.filter(
        ([command]) => command === 'divo_gateway_request'
      )
    ).toHaveLength(1)
  })

  it('throws the gateway error message on failed search', async () => {
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'divo_get_session_status') {
        return { configured: true, userId: 'user-1' }
      }

      return {
      ok: false,
      status: 'permission_denied',
      error: { message: 'Permission denied' },
      }
    })

    await expect(searchDivoSkills('google')).rejects.toThrow(
      'Permission denied'
    )
  })
})
