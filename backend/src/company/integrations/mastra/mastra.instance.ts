import { Mastra } from '@mastra/core';

import { ackAgent } from './agents/ack.agent';
import { larkDocSpecialistAgent } from './agents/lark-doc-specialist.agent';
import { plannerAgent } from './agents/planner.agent';
import { supervisorAgent } from './agents/supervisor.agent';
import { zohoSpecialistAgent } from './agents/zoho-specialist.agent';
import { searchAgent } from './agents/search.agent';
import { synthesisAgent } from './agents/synthesis.agent';
import { outreachSpecialistAgent } from './agents/outreach-specialist.agent';

export const mastra = new Mastra({
  agents: {
    ackAgent,
    plannerAgent,
    supervisorAgent,
    zohoAgent: zohoSpecialistAgent,
    outreachAgent: outreachSpecialistAgent,
    searchAgent,
    larkDocAgent: larkDocSpecialistAgent,
    synthesisAgent,
  },
});
