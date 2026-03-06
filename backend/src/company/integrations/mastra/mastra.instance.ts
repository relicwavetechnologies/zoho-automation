import { Mastra } from '@mastra/core';

import { supervisorAgent } from './agents/supervisor.agent';
import { zohoSpecialistAgent } from './agents/zoho-specialist.agent';
import { searchAgent } from './agents/search.agent';
import { synthesisAgent } from './agents/synthesis.agent';
import { outreachSpecialistAgent } from './agents/outreach-specialist.agent';

export const mastra = new Mastra({
  agents: {
    supervisorAgent,
    zohoAgent: zohoSpecialistAgent,
    outreachAgent: outreachSpecialistAgent,
    searchAgent,
    synthesisAgent,
  },
});
