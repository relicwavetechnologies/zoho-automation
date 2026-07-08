import { invoke } from '@tauri-apps/api/core'

export type DivoSkillSearchResult = {
  id: string
  name: string
  description: string
  category: string
  score?: number
  toolIds: string[]
}

type GatewaySkillSearchResponse = {
  ok?: boolean
  status?: string
  data?: {
    skills?: unknown
  }
  error?: {
    message?: string
  }
}

type GatewaySkill = {
  id?: unknown
  name?: unknown
  description?: unknown
  score?: unknown
  toolIds?: unknown
}

export async function searchDivoSkills(
  query: string,
  limit = 5
): Promise<DivoSkillSearchResult[]> {
  const normalized = query.trim()
  if (!normalized) return []

  const response = await invoke<GatewaySkillSearchResponse>(
    'divo_gateway_request',
    {
      op: 'skills.search',
      payload: {
        query: normalized,
        limit,
        context: { surface: 'desktop_composer_reference' },
      },
    }
  )

  if (!response.ok) {
    throw new Error(
      response.error?.message || `Divo skill search failed: ${response.status}`
    )
  }

  const rawSkills = Array.isArray(response.data?.skills)
    ? response.data.skills
    : []

  return rawSkills.flatMap((raw): DivoSkillSearchResult[] => {
    const skill = raw as GatewaySkill
    if (typeof skill.id !== 'string' || typeof skill.name !== 'string') {
      return []
    }

    return [
      {
        id: skill.id,
        name: skill.name,
        description:
          typeof skill.description === 'string' ? skill.description : '',
        category: inferSkillCategory(skill.toolIds),
        score: typeof skill.score === 'number' ? skill.score : undefined,
        toolIds: Array.isArray(skill.toolIds)
          ? skill.toolIds.filter((toolId): toolId is string =>
              typeof toolId === 'string'
            )
          : [],
      },
    ]
  })
}

function inferSkillCategory(toolIds: unknown): string {
  if (!Array.isArray(toolIds) || toolIds.length === 0) return 'Skill'

  const joined = toolIds
    .filter((toolId): toolId is string => typeof toolId === 'string')
    .join(' ')
    .toLowerCase()

  if (joined.includes('google')) return 'Google'
  if (joined.includes('zoho')) return 'Zoho'
  if (joined.includes('web') || joined.includes('research')) return 'Research'
  if (joined.includes('ocr') || joined.includes('document')) return 'Document'
  return 'Skill'
}
