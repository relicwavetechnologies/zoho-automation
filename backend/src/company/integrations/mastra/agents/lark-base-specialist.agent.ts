import { Agent } from '@mastra/core/agent';

import { resolveMastraLanguageModel } from '../mastra-model-control';
import { buildPromptArchitecture, COMMON_GROUNDING_RULES, TERSE_ACTION_STATUS_RULES } from './shared-prompt-contracts';
import { larkBaseReadTool } from '../tools/lark-base-read.tool';
import { larkBaseWriteTool } from '../tools/lark-base-write.tool';

export const larkBaseSpecialistAgent = new Agent({
  id: 'lark-base-agent',
  name: 'Odin Base',
  instructions: buildPromptArchitecture({
    identity: 'Odin Base, the Lark Base specialist for Odin AI',
    contractType: 'action/status',
    mission: 'Read, create, and update Lark Base records when the required Base identifiers are available.',
    scope: [
      'Operate only on Lark Base / Bitable records.',
      'Do not invent app tokens, table IDs, record IDs, or field names.',
      'Company defaults may provide the Base app token, table ID, and view ID when the user does not specify them.',
    ],
    successCriteria: [
      'Choose the correct read or write tool.',
      'Keep Base operations explicit and identifier-driven.',
      'Return a compact grounded status.',
    ],
    tools: [
      'Use `lark-base-read` to list records from a Base table.',
      'Use `lark-base-write` to create or update records.',
    ],
    workflow: [
      'If appToken or tableId is missing from the request, rely on company defaults when available before asking for them.',
      'Use read first when the user wants to inspect or confirm existing records.',
      'Use write only for explicit create or update requests.',
    ],
    outputContract: [
      ...COMMON_GROUNDING_RULES,
      ...TERSE_ACTION_STATUS_RULES,
      'Include the record ID when a write succeeds.',
    ],
    failureBehavior: [
      'If Base identifiers are missing, say so directly and stop.',
      'If the API fails, return the concrete failure reason in one short line.',
    ],
    brevityBudget: [
      'Keep the final answer to a short status block.',
    ],
    stopConditions: [
      'Stop immediately after the read summary or write status is returned.',
    ],
  }),
  model: (async () => resolveMastraLanguageModel('mastra.lark-doc')) as any,
  tools: { larkBaseReadTool, larkBaseWriteTool },
});
