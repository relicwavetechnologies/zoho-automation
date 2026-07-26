export { SkillRegistry } from './skill-registry';
export type { Skill } from './skill.types';

export { larkSkill } from './lark.skill';
export { googleSkill } from './google.skill';
export { financeOpsCoreSkill, zohoBillNotifyAccountsSkill, zohoBooksBillSkill } from './zoho.skill';
export { airtableCoreSkill, airtableSchemaOpsSkill, airtableAutomationOpsSkill, airtableSkills } from './airtable.skill';
export { researchSkill } from './research.skill';
export { deepResearchSkill } from './deep-research.skill';
export { dataSkill } from './data.skill';

import { SkillRegistry } from './skill-registry';
import { larkSkill } from './lark.skill';
import { googleSkill } from './google.skill';
import { financeOpsCoreSkill, zohoBillNotifyAccountsSkill, zohoBooksBillSkill } from './zoho.skill';
import { airtableSkills } from './airtable.skill';
import { researchSkill } from './research.skill';
import { deepResearchSkill } from './deep-research.skill';
import { dataSkill } from './data.skill';

export function createDefaultSkillRegistry(): SkillRegistry {
  return new SkillRegistry([
    larkSkill,
    googleSkill,
    financeOpsCoreSkill,
    zohoBooksBillSkill,
    zohoBillNotifyAccountsSkill,
    ...airtableSkills,
    researchSkill,
    deepResearchSkill,
    dataSkill,
  ]);
}
