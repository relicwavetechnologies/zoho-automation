import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { terminalSpecialistAgent } from '../agents/terminal-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { terminalOperationalResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import {
  buildStructuredJsonPrompt,
  normalizeTerminalOperationalResult,
} from './specialist-result-helpers';

const TOOL_ID = 'terminal-agent';

export const terminalAgentTool = createTool({
  id: TOOL_ID,
  description: 'Delegate to the terminal specialist for a safe local command plan and verification strategy.',
  inputSchema: z.object({
    query: z.string().describe('The coding or shell task that may need local terminal execution'),
  }),
  outputSchema: terminalOperationalResultSchema,
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return normalizeTerminalOperationalResult(`Access to "${name}" is not permitted for your role. Please contact your admin.`);
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Planning terminal execution',
        icon: 'terminal-square',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.supervisor', { requestContext });
    const result = await terminalSpecialistAgent.generate(
      [{
        role: 'user',
        content: buildStructuredJsonPrompt(
          inputData.query,
          '{"success":boolean,"summary":"string","command":"string?","cwdHint":"string?","verificationCommand":"string?","writesToWorkspace":boolean?,"needsApproval":boolean?,"error":"string?","retryable":boolean?,"userAction":"string?"}',
        ),
      }],
      runOptions as any,
    );

    const normalized = normalizeTerminalOperationalResult(result.text);
    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: normalized.success ? 'Planned terminal execution' : 'Terminal planning failed',
        icon: normalized.success ? 'terminal-square' : 'x-circle',
        resultSummary: normalized.summary,
      });
    }

    return terminalOperationalResultSchema.parse(normalized);
  },
});
