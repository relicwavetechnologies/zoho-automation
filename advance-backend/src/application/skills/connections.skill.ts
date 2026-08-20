import type { Skill } from './skill.types';
import type { PrismaClient } from '../../generated/prisma';
import type { DivoProductivitySystemSkillDefinition } from './divo-productivity-system-skills';
import { provisionDivoProductivitySkillForExistingCompanies } from './divo-productivity-system-skills';

const CONNECTION_METHOD = `CONNECTION METHOD:
- Use this skill when a member asks Divo to connect Google, reconnect it, or add Google access for a task.
- Call \`divo_connect_app\` with provider \`google_workspace\` and the Divo toolIds needed for the requested work. Never pass OAuth scopes, native provider operation names, or a guessed connection ID.
- Google is the only provider supported by this front door. If the tool returns a named unsupported-provider error, report it plainly and stop.
- A successful result means Divo sent one Connect ask or found one already pending. Tell the member what they should see, end the run, and do not retry the original provider call. OAuth completion starts the continuation automatically.
- A connection may already exist and still need a narrower re-consent. The tool ids describe the work; Divo chooses the consent scopes.`;

export const connectionsSkill: Skill = {
  id: 'connections',
  name: 'Connections',
  description: 'Connect or widen a provider account through Divo before a governed tool call needs it.',
  toolIds: ['connectApp'],
  instructions: CONNECTION_METHOD,
};

export const CONNECTIONS_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: 'connections',
  name: 'Connections',
  summary: 'Connect or widen Google Workspace access through Divo before governed work needs it.',
  markdown: `# Connections\n\n${CONNECTION_METHOD}`,
  toolIds: ['connectApp'],
  tags: ['divo', 'connections', 'oauth', 'google'],
  aliases: ['connect google', 'connect my google', 'reconnect google', 'connect google workspace', 'add google access'],
  sortOrder: 5,
};

export function provisionConnectionsSkillForExistingCompanies(
  db: Parameters<typeof provisionDivoProductivitySkillForExistingCompanies>[0],
) {
  return provisionDivoProductivitySkillForExistingCompanies(db, CONNECTIONS_SYSTEM_SKILL);
}

export type ConnectionsSkillStore = Pick<PrismaClient, 'company'>;
