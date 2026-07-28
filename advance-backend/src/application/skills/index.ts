export { SkillRegistry } from './skill-registry';
export type { Skill } from './skill.types';

export { googleSkill } from './google.skill';
export { financeOpsCoreSkill, zohoBillNotifyAccountsSkill, zohoBooksBillSkill } from './zoho.skill';
export { airtableCoreSkill, airtableSchemaOpsSkill, airtableAutomationOpsSkill, airtableSkills } from './airtable.skill';
export { aitableDatasheetsSkill, aitableFieldsSkill, aitableSkills } from './aitable.skill';
export { researchSkill } from './research.skill';
export { deepResearchSkill } from './deep-research.skill';
export { dataSkill } from './data.skill';

import { SkillRegistry } from './skill-registry';
import { googleSkill } from './google.skill';
import { financeOpsCoreSkill, zohoBillNotifyAccountsSkill, zohoBooksBillSkill } from './zoho.skill';
import { airtableSkills } from './airtable.skill';
import { aitableSkills } from './aitable.skill';
import { researchSkill } from './research.skill';
import { deepResearchSkill } from './deep-research.skill';
import { dataSkill } from './data.skill';

export function createDefaultSkillRegistry(): SkillRegistry {
  return new SkillRegistry([
    googleSkill,
    financeOpsCoreSkill,
    zohoBooksBillSkill,
    zohoBillNotifyAccountsSkill,
    ...airtableSkills,
    ...aitableSkills,
    researchSkill,
    deepResearchSkill,
    dataSkill,
  ]);
}
