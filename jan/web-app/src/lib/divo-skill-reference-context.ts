import type { DivoSkillSearchResult } from '@/lib/divo-skill-search'
import type { DivoQuickStartPlan } from '@/lib/divo-finance-quick-start'

export const DIVO_SKILL_REFERENCES_METADATA_KEY = 'divoSkillReferences'

export type DivoSkillReference = Pick<
  DivoSkillSearchResult,
  'id' | 'name' | 'description' | 'category' | 'toolIds'
>

export type DivoSkillReferenceSubmitOptions = {
  skillReferences?: DivoSkillReference[]
  quickStartPlan?: DivoQuickStartPlan
  messageMetadata?: Record<string, unknown>
}

export function normalizeDivoSkillReferences(
  references: readonly DivoSkillReference[] | undefined
): DivoSkillReference[] {
  if (!references?.length) return []

  const seen = new Set<string>()
  return references.flatMap((reference) => {
    const id = reference.id.trim()
    const name = reference.name.trim()
    if (!id || !name || seen.has(id)) return []

    seen.add(id)
    return [
      {
        id,
        name,
        description: reference.description.trim(),
        category: reference.category.trim() || 'Skill',
        toolIds: reference.toolIds.filter((toolId) => toolId.trim().length > 0),
      },
    ]
  })
}

export function readDivoSkillReferencesFromMetadata(
  metadata: unknown
): DivoSkillReference[] {
  if (!metadata || typeof metadata !== 'object') return []
  const raw = (metadata as Record<string, unknown>)[
    DIVO_SKILL_REFERENCES_METADATA_KEY
  ]
  if (!Array.isArray(raw)) return []

  return normalizeDivoSkillReferences(
    raw.flatMap((item): DivoSkillReference[] => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.name !== 'string') {
        return []
      }

      return [
        {
          id: record.id,
          name: record.name,
          description:
            typeof record.description === 'string' ? record.description : '',
          category: typeof record.category === 'string' ? record.category : '',
          toolIds: Array.isArray(record.toolIds)
            ? record.toolIds.filter((toolId): toolId is string =>
                typeof toolId === 'string'
              )
            : [],
        },
      ]
    })
  )
}

export function buildDivoSkillReferenceContext(
  references: readonly DivoSkillReference[] | undefined
): string {
  const normalized = normalizeDivoSkillReferences(references)
  if (normalized.length === 0) return ''

  return [
    '[DIVO_SKILL_REFERENCES]',
    'The user explicitly selected these Divo skills for this request.',
    '',
    'You must load the selected skill recipe before doing anything else.',
    '',
    'Exact first tool call format for each selected skill:',
    'divo_gateway({',
    '  "op": "skills.get",',
    '  "payload": {',
    '    "skillId": "<skillId>"',
    '  }',
    '})',
    '',
    'After loading the referenced skill recipe, follow it. If the request needs more skills, you may then call divo_gateway with op "skills.search".',
    '',
    'Selected skills:',
    ...normalized.flatMap((reference) => [
      `- skillId: ${reference.id}`,
      `  name: ${reference.name}`,
      `  category: ${reference.category}`,
      `  description: ${reference.description || 'No description provided.'}`,
    ]),
    '[/DIVO_SKILL_REFERENCES]',
  ].join('\n')
}
