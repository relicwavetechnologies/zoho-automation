import { beforeEach, describe, expect, it, vi } from 'vitest'
import { searchDivoSkills } from '../divo-skill-search'

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriCoreMock.invoke,
}))

describe('searchDivoSkills', () => {
  beforeEach(() => {
    tauriCoreMock.invoke.mockReset()
  })

  it('does not call the gateway for empty search text', async () => {
    await expect(searchDivoSkills('   ')).resolves.toEqual([])
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled()
  })

  it('maps successful gateway skills into drawer results', async () => {
    tauriCoreMock.invoke.mockResolvedValue({
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
    })

    await expect(searchDivoSkills('google')).resolves.toEqual([
      {
        id: 'google',
        name: 'Google Workspace',
        description: 'Use Gmail, Drive, and Calendar.',
        category: 'Google',
        score: 6,
        toolIds: ['googleGmail', 'googleDrive'],
      },
    ])
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith('divo_gateway_request', {
      op: 'skills.search',
      payload: {
        query: 'google',
        limit: 5,
        context: { surface: 'desktop_composer_reference' },
      },
    })
  })

  it('throws the gateway error message on failed search', async () => {
    tauriCoreMock.invoke.mockResolvedValue({
      ok: false,
      status: 'permission_denied',
      error: { message: 'Permission denied' },
    })

    await expect(searchDivoSkills('google')).rejects.toThrow(
      'Permission denied'
    )
  })
})
