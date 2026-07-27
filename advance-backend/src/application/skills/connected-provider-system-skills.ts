import { airtableSkills } from './airtable.skill';
import { aitableSkills } from './aitable.skill';
import {
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';

const ROUTING: Readonly<Record<string, readonly string[]>> = {
  'airtable-core': ['airtable', 'airtable records', 'airtable bases'],
  'airtable-schema-ops': ['airtable schema', 'airtable tables', 'airtable fields'],
  'airtable-automation-ops': ['airtable automations', 'airtable interfaces', 'airtable forms'],
  'aitable-datasheets': ['aitable', 'aitable datasheets', 'aitable records'],
  'aitable-fields': ['aitable fields', 'aitable schema'],
} as const;

const providerSkills = [...airtableSkills, ...aitableSkills];

export const CONNECTED_PROVIDER_SYSTEM_SKILLS: readonly DivoProductivitySystemSkillDefinition[] =
  providerSkills.map((skill, index) => ({
    slug: skill.id,
    name: skill.name,
    summary: skill.description,
    markdown: `# ${skill.name}\n\n${skill.instructions}`,
    toolIds: skill.toolIds,
    tags: ['divo', skill.id.startsWith('aitable-') ? 'aitable' : 'airtable'],
    aliases: ROUTING[skill.id] ?? [skill.id],
    sortOrder: 30 + index,
  }));

export async function provisionConnectedProviderSystemSkills(
  db: Parameters<typeof provisionDivoProductivitySystemSkill>[0],
  companyId: string,
) {
  const results = [];
  for (const definition of CONNECTED_PROVIDER_SYSTEM_SKILLS) {
    results.push(await provisionDivoProductivitySystemSkill(db, companyId, definition));
  }
  return results;
}
