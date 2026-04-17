type PendingApprovalAction = {
  kind: 'tool_action';
  approvalId: string;
  toolId: string;
  actionGroup: string;
  summary: string;
  subject?: string;
  payload?: Record<string, unknown>;
};

type VercelToolEnvelope = {
  toolId: string;
  status: string;
  data: unknown;
  confirmedAction: boolean;
  success: boolean;
  summary: string;
  pendingApprovalAction?: PendingApprovalAction;
  mutationResult?: {
    pendingApproval?: boolean;
  };
};

type SubAgentTextResult = {
  text: string;
  finalText: string;
  citations: unknown[];
  toolResults: VercelToolEnvelope[];
  pendingApproval: PendingApprovalAction | null;
};

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const extractToolEnvelopes = (steps: unknown): VercelToolEnvelope[] => {
  const envelopes: VercelToolEnvelope[] = [];
  for (const step of asArray(steps)) {
    const stepRecord = asRecord(step);
    for (const toolResult of asArray(stepRecord?.toolResults)) {
      const output = asRecord(asRecord(toolResult)?.output);
      if (!output) {
        continue;
      }
      const success = asBoolean(output.success);
      const summary = asString(output.summary);
      const toolId = asString(output.toolId);
      const status = asString(output.status);
      if (success === undefined || !summary || !toolId || !status) {
        continue;
      }
      envelopes.push(output as VercelToolEnvelope);
    }
  }
  return envelopes;
};

const extractPendingApproval = (toolResults: VercelToolEnvelope[]): PendingApprovalAction | null => {
  for (const toolResult of toolResults) {
    if (toolResult.pendingApprovalAction) {
      return toolResult.pendingApprovalAction;
    }
    if (toolResult.mutationResult?.pendingApproval) {
      return toolResult.pendingApprovalAction ?? null;
    }
  }
  return null;
};

const extractSupervisorToolOutputs = (steps: unknown): Array<Record<string, unknown>> => {
  const outputs: Array<Record<string, unknown>> = [];
  for (const step of asArray(steps)) {
    const stepRecord = asRecord(step);
    for (const toolResult of asArray(stepRecord?.toolResults)) {
      const output = asRecord(asRecord(toolResult)?.output);
      if (output) {
        outputs.push(output);
      }
    }
  }
  return outputs;
};

const extractNestedPendingApproval = (steps: unknown): PendingApprovalAction | null => {
  const outputs = extractSupervisorToolOutputs(steps);
  console.log('hitl.extractNested.debug', JSON.stringify({
    outputCount: outputs.length,
    outputs: outputs.map(o => ({
      keys: Object.keys(o),
      hasPendingApproval: Boolean(o.pendingApproval),
      pendingApprovalType: typeof o.pendingApproval,
      pendingApprovalIsNull: o.pendingApproval === null,
      asRecordResult: Boolean(asRecord(o.pendingApproval)),
    })),
  }));
  for (const output of outputs) {
    const pending = asRecord(output.pendingApproval);
    console.log('hitl.extractNested.loop', JSON.stringify({
      hasPending: Boolean(pending),
      pendingValue: output.pendingApproval,
    }));
    if (pending) {
      return pending as PendingApprovalAction;
    }
    for (const entry of asArray(output.toolResults)) {
      const toolResult = asRecord(entry) as VercelToolEnvelope | undefined;
      if (toolResult?.pendingApprovalAction) {
        return toolResult.pendingApprovalAction;
      }
    }
  }
  return null;
};

const extractSubAgentPendingApproval = (steps: unknown): PendingApprovalAction | null => {
  for (const step of asArray(steps)) {
    const stepRecord = asRecord(step);
    const stepToolResults = asArray(stepRecord?.toolResults);
    for (const tr of stepToolResults) {
      const trRecord = asRecord(tr);
      const output = trRecord?.output;
      if (!output || typeof output !== 'object') continue;
      const outputObj = output as Record<string, unknown>;

      if (outputObj.pendingApproval && typeof outputObj.pendingApproval === 'object') {
        return outputObj.pendingApproval as PendingApprovalAction;
      }

      if (outputObj.pendingApprovalAction && typeof outputObj.pendingApprovalAction === 'object') {
        return outputObj.pendingApprovalAction as PendingApprovalAction;
      }
    }
  }
  return null;
};

const pendingApprovalAction: PendingApprovalAction = {
  kind: 'tool_action',
  approvalId: 'test-approval-id',
  toolId: 'googleWorkspace',
  actionGroup: 'send',
  summary: 'Approval required to send email',
  subject: 'Test approval subject',
  payload: {
    to: ['test@example.com'],
    subject: 'Test subject',
  },
};

const envelope: VercelToolEnvelope = {
  toolId: 'googleWorkspace',
  status: 'skipped',
  data: null,
  confirmedAction: false,
  success: true,
  summary: 'test',
  pendingApprovalAction,
};

const subAgentResult: SubAgentTextResult = {
  text: 'Email queued for approval.',
  finalText: 'Email queued for approval.',
  citations: [],
  toolResults: [envelope],
  pendingApproval: extractPendingApproval([envelope]),
};

const steps = [
  {
    toolResults: [
      {
        toolName: 'googleWorkspaceAgent',
        output: subAgentResult,
      },
    ],
  },
];

void extractNestedPendingApproval(steps);
