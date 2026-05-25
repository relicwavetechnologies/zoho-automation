export { SkillRegistry } from './skill-registry';
export type { Skill } from './skill.types';

export { larkSkill } from './lark.skill';
export { googleSkill } from './google.skill';
export { zohoSkill } from './zoho.skill';
export { researchSkill } from './research.skill';
export { dataSkill } from './data.skill';

import { SkillRegistry } from './skill-registry';
import { larkSkill } from './lark.skill';
import { googleSkill } from './google.skill';
import { zohoSkill } from './zoho.skill';
import { researchSkill } from './research.skill';
import { dataSkill } from './data.skill';

export function createDefaultSkillRegistry(): SkillRegistry {
  return new SkillRegistry([larkSkill, googleSkill, zohoSkill, researchSkill, dataSkill]);
}
