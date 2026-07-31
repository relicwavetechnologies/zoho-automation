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

type DivoSessionStatus = {
  configured: boolean
  backendUrl?: string
  departmentId?: string
  userId?: string
  companyId?: string
  role?: string
  expiresAt?: string
}

type GatewaySkill = {
  id?: unknown
  name?: unknown
  description?: unknown
  score?: unknown
  toolIds?: unknown
}

const SKILL_CATALOG_CACHE_TTL_MS = 35 * 60 * 1000
const skillCatalogCache = new Map<
  string,
  { expiresAt: number; skills: DivoSkillSearchResult[] }
>()

export function clearDivoSkillSearchCache(): void {
  skillCatalogCache.clear()
}

export async function searchDivoSkills(
  query: string,
  limit = 5
): Promise<DivoSkillSearchResult[]> {
  const normalized = query.trim()
  if (!normalized) return []

  const skills = await getCachedSkillCatalog()
  return rankSkills(skills, normalized).slice(0, limit)
}

async function getCachedSkillCatalog(): Promise<DivoSkillSearchResult[]> {
  const session = await invoke<DivoSessionStatus>('divo_get_session_status')
  if (!session.configured) {
    throw new Error('Connect Divo before searching skills')
  }

  const cacheKey = sessionSkillCacheKey(session)
  const cached = skillCatalogCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.skills
  if (cached) skillCatalogCache.delete(cacheKey)

  const response = await invoke<GatewaySkillSearchResponse>(
    'divo_gateway_request',
    {
      op: 'skills.list',
      payload: { context: { surface: 'desktop_composer_reference' } },
    }
  )

  if (!response.ok) {
    throw new Error(
      response.error?.message || `Divo skill catalog failed: ${response.status}`
    )
  }

  const rawSkills = Array.isArray(response.data?.skills)
    ? response.data.skills
    : []

  const skills = rawSkills.flatMap((raw): DivoSkillSearchResult[] => {
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

  skillCatalogCache.set(cacheKey, {
    skills,
    expiresAt: Date.now() + SKILL_CATALOG_CACHE_TTL_MS,
  })
  return skills
}

function sessionSkillCacheKey(session: DivoSessionStatus): string {
  return [
    session.backendUrl ?? '',
    session.companyId ?? '',
    session.userId ?? '',
    session.role ?? '',
    session.departmentId ?? '',
    session.expiresAt ?? '',
  ].join('|')
}

function rankSkills(
  skills: DivoSkillSearchResult[],
  query: string
): DivoSkillSearchResult[] {
  const words = tokenize(query)
  return skills
    .map((skill) => ({
      ...skill,
      score: scoreSkill(skill, words),
    }))
    .filter((skill) => (skill.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name))
}

function scoreSkill(skill: DivoSkillSearchResult, words: string[]): number {
  const strong = [
    skill.id,
    skill.name,
    skill.description,
    skill.category,
    ...skill.toolIds,
  ].join(' ').toLowerCase()

  let score = 0
  for (const word of words) {
    if (strong.includes(word)) score += 3
  }
  return score
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1)
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
