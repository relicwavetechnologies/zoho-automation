import { Mastra } from '@mastra/core';

import { supervisorAgent } from './agents/supervisor.agent';
import { zohoSpecialistAgent } from './agents/zoho-specialist.agent';
import { searchAgent } from './agents/search.agent';
import { synthesisAgent } from './agents/synthesis.agent';

export const mastra = new Mastra({
  agents: {
    supervisorAgent,
    zohoAgent: zohoSpecialistAgent,
    searchAgent,
    synthesisAgent,
  },
});
