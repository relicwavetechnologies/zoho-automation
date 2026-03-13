import { Mastra } from '@mastra/core';

import { ackAgent } from './agents/ack.agent';
import { larkApprovalSpecialistAgent } from './agents/lark-approval-specialist.agent';
import { larkBaseSpecialistAgent } from './agents/lark-base-specialist.agent';
import { larkCalendarSpecialistAgent } from './agents/lark-calendar-specialist.agent';
import { larkDocSpecialistAgent } from './agents/lark-doc-specialist.agent';
import { larkMeetingSpecialistAgent } from './agents/lark-meeting-specialist.agent';
import { larkTaskSpecialistAgent } from './agents/lark-task-specialist.agent';
import { plannerAgent } from './agents/planner.agent';
import { supervisorAgent } from './agents/supervisor.agent';
import { zohoSpecialistAgent } from './agents/zoho-specialist.agent';
import { searchAgent } from './agents/search.agent';
import { synthesisAgent } from './agents/synthesis.agent';
import { outreachSpecialistAgent } from './agents/outreach-specialist.agent';
import { companyWorkflow } from './workflows/company.workflow';

export const mastra = new Mastra({
  agents: {
    ackAgent,
    plannerAgent,
    supervisorAgent,
    zohoAgent: zohoSpecialistAgent,
    outreachAgent: outreachSpecialistAgent,
    searchAgent,
    larkBaseAgent: larkBaseSpecialistAgent,
    larkTaskAgent: larkTaskSpecialistAgent,
    larkCalendarAgent: larkCalendarSpecialistAgent,
    larkMeetingAgent: larkMeetingSpecialistAgent,
    larkApprovalAgent: larkApprovalSpecialistAgent,
    larkDocAgent: larkDocSpecialistAgent,
    synthesisAgent,
  },
  workflows: {
    companyWorkflow,
  },
});
