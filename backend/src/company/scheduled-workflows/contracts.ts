import { createHash } from 'crypto';

import { z } from 'zod';

import { getSupportedToolActionGroups, type ToolActionGroup } from '../tools/tool-action-groups';

const TOOL_ACTION_GROUP_VALUES = ['read', 'create', 'update', 'delete', 'send', 'execute'] as const;
const WRITE_CAPABLE_ACTION_GROUPS = new Set<ToolActionGroup>(['create', 'update', 'delete', 'send', 'execute']);
const NODE_KIND_VALUES = [
  'read',
  'search',
  'analyze',
  'transform',
  'createDraft',
  'updateSystem',
  'send',
  'notify',
  'requireApproval',
  'branch',
  'deliver',
] as const;
const WEEKDAY_VALUES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

type WorkflowNodeKind = (typeof NODE_KIND_VALUES)[number];

const workflowNodeKindSchema = z.enum(NODE_KIND_VALUES);
const toolActionGroupSchema = z.enum(TOOL_ACTION_GROUP_VALUES);

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, underscores, or hyphens only.');

const titleSchema = z.string().trim().min(1).max(160);
const shortTextSchema = z.string().trim().min(1).max(500);
const optionalInstructionsSchema = z.string().trim().max(4000).optional();

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  backoffSeconds: z.number().int().min(0).max(86400).default(0),
}).strict();

const capabilityRefSchema = z.object({
  toolId: z.string().trim().min(1).max(120),
  actionGroup: toolActionGroupSchema,
  operation: z.string().trim().min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const supported = getSupportedToolActionGroups(value.toolId);
  if (!supported.includes(value.actionGroup)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Tool "${value.toolId}" does not support "${value.actionGroup}" actions.`,
      path: ['actionGroup'],
    });
  }
});

const branchDefinitionSchema = z.object({
  label: titleSchema,
  when: shortTextSchema,
}).strict();

export const scheduledWorkflowNodeSchema = z.object({
  id: identifierSchema,
  kind: workflowNodeKindSchema,
  title: titleSchema,
  instructions: optionalInstructionsSchema,
  inputs: z.array(identifierSchema).max(12).default([]),
  outputKey: identifierSchema.optional(),
  expectedOutput: shortTextSchema.optional(),
  capability: capabilityRefSchema.optional(),
  retryPolicy: retryPolicySchema.optional(),
  destinationIds: z.array(identifierSchema).min(1).max(10).optional(),
  approvalJustification: z.string().trim().min(1).max(1000).optional(),
  branches: z.array(branchDefinitionSchema).min(2).max(8).optional(),
}).strict().superRefine((node, ctx) => {
  const requireInstructions = new Set<WorkflowNodeKind>([
    'read',
    'search',
    'analyze',
    'transform',
    'createDraft',
    'updateSystem',
    'send',
    'notify',
    'requireApproval',
  ]);

  if (requireInstructions.has(node.kind) && !node.instructions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${node.kind}" nodes require instructions.`,
      path: ['instructions'],
    });
  }

  if (node.kind === 'deliver' && !(node.destinationIds && node.destinationIds.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Deliver nodes require at least one destination id.',
      path: ['destinationIds'],
    });
  }

  if (node.kind !== 'deliver' && node.destinationIds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only deliver nodes can declare destination ids.',
      path: ['destinationIds'],
    });
  }

  if (node.kind === 'branch' && !(node.branches && node.branches.length >= 2)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Branch nodes require at least two branch conditions.',
      path: ['branches'],
    });
  }

  if (node.kind !== 'branch' && node.branches) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only branch nodes can define branch conditions.',
      path: ['branches'],
    });
  }

  if (node.kind === 'requireApproval' && !node.approvalJustification) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'requireApproval nodes require an approvalJustification.',
      path: ['approvalJustification'],
    });
  }

  if (node.kind !== 'requireApproval' && node.approvalJustification) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'approvalJustification is only valid on requireApproval nodes.',
      path: ['approvalJustification'],
    });
  }
});

export const scheduledWorkflowEdgeSchema = z.object({
  sourceId: identifierSchema,
  targetId: identifierSchema,
  condition: z.enum(['always', 'success', 'failure', 'branch']).default('always'),
  label: z.string().trim().min(1).max(120).optional(),
}).strict();

export const scheduledWorkflowSpecSchema = z.object({
  version: z.literal('v1'),
  name: titleSchema,
  description: z.string().trim().max(1000).optional(),
  nodes: z.array(scheduledWorkflowNodeSchema).min(1).max(64),
  edges: z.array(scheduledWorkflowEdgeSchema).max(160).default([]),
}).strict().superRefine((spec, ctx) => {
  const nodeIds = new Set<string>();

  for (const [index, node] of spec.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate node id "${node.id}".`,
        path: ['nodes', index, 'id'],
      });
      continue;
    }
    nodeIds.add(node.id);
  }

  const incomingCounts = new Map<string, number>(spec.nodes.map((node) => [node.id, 0]));
  const adjacency = new Map<string, string[]>(spec.nodes.map((node) => [node.id, []]));

  for (const [index, edge] of spec.edges.entries()) {
    if (!nodeIds.has(edge.sourceId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown source node "${edge.sourceId}".`,
        path: ['edges', index, 'sourceId'],
      });
    }
    if (!nodeIds.has(edge.targetId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown target node "${edge.targetId}".`,
        path: ['edges', index, 'targetId'],
      });
    }
    if (edge.sourceId === edge.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Self-referential edges are not allowed.',
        path: ['edges', index],
      });
    }
    if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) {
      continue;
    }
    incomingCounts.set(edge.targetId, (incomingCounts.get(edge.targetId) ?? 0) + 1);
    adjacency.get(edge.sourceId)?.push(edge.targetId);
  }

  const rootCount = [...incomingCounts.values()].filter((count) => count === 0).length;
  if (rootCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Workflow graph must have at least one root node.',
      path: ['edges'],
    });
  }

  const indegree = new Map(incomingCounts);
  const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    for (const next of adjacency.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== spec.nodes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Workflow graph must be acyclic.',
      path: ['edges'],
    });
  }
});

const timeWindowSchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
}).strict();

const timezoneSchema = z.string().trim().min(1).max(100);

export const scheduledWorkflowScheduleConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('one_time'),
    timezone: timezoneSchema,
    runAt: z.string().datetime(),
  }).strict(),
  z.object({
    type: z.literal('hourly'),
    timezone: timezoneSchema,
    intervalHours: z.number().int().min(1).max(24),
    minute: z.number().int().min(0).max(59).default(0),
  }).strict(),
  z.object({
    type: z.literal('daily'),
    timezone: timezoneSchema,
    time: timeWindowSchema,
  }).strict(),
  z.object({
    type: z.literal('weekly'),
    timezone: timezoneSchema,
    daysOfWeek: z.array(z.enum(WEEKDAY_VALUES)).min(1).max(7),
    time: timeWindowSchema,
  }).strict(),
  z.object({
    type: z.literal('monthly'),
    timezone: timezoneSchema,
    dayOfMonth: z.number().int().min(1).max(31),
    time: timeWindowSchema,
  }).strict(),
]);

const destinationBaseSchema = z.object({
  id: identifierSchema,
  label: titleSchema.optional(),
}).strict();

const desktopInboxDestinationSchema = destinationBaseSchema.extend({
  kind: z.literal('desktop_inbox'),
}).strict();

const desktopThreadDestinationSchema = destinationBaseSchema.extend({
  kind: z.literal('desktop_thread'),
  threadId: z.string().trim().min(1).max(120),
}).strict();

const larkChatDestinationSchema = destinationBaseSchema.extend({
  kind: z.literal('lark_chat'),
  chatId: z.string().trim().min(1).max(120),
  tenantKey: z.string().trim().min(1).max(120).optional(),
}).strict();

export const scheduledWorkflowDestinationSchema = z.discriminatedUnion('kind', [
  desktopInboxDestinationSchema,
  desktopThreadDestinationSchema,
  larkChatDestinationSchema,
]);

export const scheduledWorkflowOutputConfigSchema = z.object({
  version: z.literal('v1'),
  destinations: z.array(scheduledWorkflowDestinationSchema).min(1).max(10),
  defaultDestinationIds: z.array(identifierSchema).max(10).default([]),
}).strict().superRefine((config, ctx) => {
  const destinationIds = new Set<string>();
  for (const [index, destination] of config.destinations.entries()) {
    if (destinationIds.has(destination.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate destination id "${destination.id}".`,
        path: ['destinations', index, 'id'],
      });
      continue;
    }
    destinationIds.add(destination.id);
  }

  for (const [index, destinationId] of config.defaultDestinationIds.entries()) {
    if (!destinationIds.has(destinationId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown default destination "${destinationId}".`,
        path: ['defaultDestinationIds', index],
      });
    }
  }
});

const reviewedCapabilitySchema = z.object({
  toolId: z.string().trim().min(1).max(120),
  actionGroups: z.array(toolActionGroupSchema).min(1).max(6),
  operations: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
}).strict();

export const scheduledWorkflowApprovalGrantSchema = z.object({
  version: z.literal('v1'),
  approvedByUserId: z.string().trim().min(1).max(120),
  approvedAt: z.string().datetime(),
  capabilityFingerprint: z.string().length(64),
  reviewedCapabilities: z.array(reviewedCapabilitySchema).max(64).default([]),
  approvedDestinationIds: z.array(identifierSchema).max(20).default([]),
  expiresAt: z.string().datetime().optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

export const scheduledWorkflowCapabilitySummarySchema = z.object({
  version: z.literal('v1'),
  requiredTools: z.array(z.string().trim().min(1).max(120)),
  requiredActionGroupsByTool: z.record(z.array(toolActionGroupSchema)),
  operationsByTool: z.record(z.array(z.string().trim().min(1).max(200))),
  expectedDestinationIds: z.array(identifierSchema),
  requiresPublishApproval: z.boolean(),
  capabilityFingerprint: z.string().length(64),
}).strict();

export const scheduledWorkflowDefinitionSchema = z.object({
  userIntent: z.string().trim().min(1).max(10000),
  workflowSpec: scheduledWorkflowSpecSchema,
  schedule: scheduledWorkflowScheduleConfigSchema,
  outputConfig: scheduledWorkflowOutputConfigSchema,
}).strict().superRefine((definition, ctx) => {
  const destinationIds = new Set(definition.outputConfig.destinations.map((destination) => destination.id));
  for (const [index, node] of definition.workflowSpec.nodes.entries()) {
    if (node.kind !== 'deliver') continue;
    for (const [destinationIndex, destinationId] of (node.destinationIds ?? []).entries()) {
      if (!destinationIds.has(destinationId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown delivery destination "${destinationId}".`,
          path: ['workflowSpec', 'nodes', index, 'destinationIds', destinationIndex],
        });
      }
    }
  }
});

export type ScheduledWorkflowNode = z.infer<typeof scheduledWorkflowNodeSchema>;
export type ScheduledWorkflowSpec = z.infer<typeof scheduledWorkflowSpecSchema>;
export type ScheduledWorkflowScheduleConfig = z.infer<typeof scheduledWorkflowScheduleConfigSchema>;
export type ScheduledWorkflowDestination = z.infer<typeof scheduledWorkflowDestinationSchema>;
export type ScheduledWorkflowOutputConfig = z.infer<typeof scheduledWorkflowOutputConfigSchema>;
export type ScheduledWorkflowApprovalGrant = z.infer<typeof scheduledWorkflowApprovalGrantSchema>;
export type ScheduledWorkflowCapabilitySummary = z.infer<typeof scheduledWorkflowCapabilitySummarySchema>;
export type ScheduledWorkflowDefinition = z.infer<typeof scheduledWorkflowDefinitionSchema>;

const ACTION_GROUP_ORDER: ToolActionGroup[] = ['read', 'create', 'update', 'delete', 'send', 'execute'];

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sortActionGroups = (actionGroups: Iterable<ToolActionGroup>): ToolActionGroup[] =>
  [...new Set(actionGroups)].sort(
    (left, right) => ACTION_GROUP_ORDER.indexOf(left) - ACTION_GROUP_ORDER.indexOf(right),
  );

const uniqueStrings = (values: Iterable<string>): string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));

const topologicallySortNodes = (spec: ScheduledWorkflowSpec): ScheduledWorkflowNode[] => {
  const nodeById = new Map(spec.nodes.map((node) => [node.id, node]));
  const adjacency = new Map(spec.nodes.map((node) => [node.id, [] as string[]]));
  const indegree = new Map(spec.nodes.map((node) => [node.id, 0]));

  for (const edge of spec.edges) {
    adjacency.get(edge.sourceId)?.push(edge.targetId);
    indegree.set(edge.targetId, (indegree.get(edge.targetId) ?? 0) + 1);
  }

  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
  const ordered: ScheduledWorkflowNode[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentNode = nodeById.get(currentId);
    if (currentNode) {
      ordered.push(currentNode);
    }

    for (const nextId of adjacency.get(currentId) ?? []) {
      const remaining = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, remaining);
      if (remaining === 0) {
        queue.push(nextId);
        queue.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  return ordered;
};

const resolveExpectedDestinationIds = (input: {
  workflowSpec: ScheduledWorkflowSpec;
  outputConfig: ScheduledWorkflowOutputConfig;
}): string[] => {
  const explicitDeliveryIds = input.workflowSpec.nodes.flatMap((node) =>
    node.kind === 'deliver' ? node.destinationIds ?? [] : []);

  if (explicitDeliveryIds.length > 0) {
    return uniqueStrings(explicitDeliveryIds);
  }
  if (input.outputConfig.defaultDestinationIds.length > 0) {
    return uniqueStrings(input.outputConfig.defaultDestinationIds);
  }
  return uniqueStrings(input.outputConfig.destinations.map((destination) => destination.id));
};

export const isWriteCapableActionGroup = (actionGroup: ToolActionGroup): boolean =>
  WRITE_CAPABLE_ACTION_GROUPS.has(actionGroup);

export const summarizeScheduledWorkflowCapabilities = (
  input: Pick<ScheduledWorkflowDefinition, 'workflowSpec' | 'outputConfig'>,
): ScheduledWorkflowCapabilitySummary => {
  const actionGroupsByTool = new Map<string, Set<ToolActionGroup>>();
  const operationsByTool = new Map<string, Set<string>>();

  for (const node of input.workflowSpec.nodes) {
    if (!node.capability) continue;
    const toolActions = actionGroupsByTool.get(node.capability.toolId) ?? new Set<ToolActionGroup>();
    toolActions.add(node.capability.actionGroup);
    actionGroupsByTool.set(node.capability.toolId, toolActions);

    const operations = operationsByTool.get(node.capability.toolId) ?? new Set<string>();
    operations.add(node.capability.operation);
    operationsByTool.set(node.capability.toolId, operations);
  }

  const requiredTools = uniqueStrings(actionGroupsByTool.keys());
  const requiredActionGroupsByTool = Object.fromEntries(
    requiredTools.map((toolId) => [toolId, sortActionGroups(actionGroupsByTool.get(toolId) ?? [])]),
  );
  const normalizedOperationsByTool = Object.fromEntries(
    requiredTools.map((toolId) => [toolId, uniqueStrings(operationsByTool.get(toolId) ?? [])]),
  );
  const expectedDestinationIds = resolveExpectedDestinationIds(input);
  const requiresPublishApproval = Object.values(requiredActionGroupsByTool)
    .flat()
    .some((actionGroup) => isWriteCapableActionGroup(actionGroup));

  const capabilityFingerprint = createHash('sha256')
    .update(stableStringify({
      requiredActionGroupsByTool,
      operationsByTool: normalizedOperationsByTool,
      expectedDestinationIds,
    }))
    .digest('hex');

  return scheduledWorkflowCapabilitySummarySchema.parse({
    version: 'v1',
    requiredTools,
    requiredActionGroupsByTool,
    operationsByTool: normalizedOperationsByTool,
    expectedDestinationIds,
    requiresPublishApproval,
    capabilityFingerprint,
  });
};

export const compileScheduledWorkflowDefinition = (
  rawDefinition: unknown,
): {
  compiledPrompt: string;
  capabilitySummary: ScheduledWorkflowCapabilitySummary;
} => {
  const definition = scheduledWorkflowDefinitionSchema.parse(rawDefinition);
  const capabilitySummary = summarizeScheduledWorkflowCapabilities(definition);
  const destinationsById = new Map(definition.outputConfig.destinations.map((destination) => [destination.id, destination]));
  const orderedNodes = topologicallySortNodes(definition.workflowSpec);

  const lines = [
    'You are executing a published scheduled workflow.',
    'Treat the structured workflow below as the source of truth.',
    'Do not add capabilities, destinations, or side effects beyond the approved workflow definition.',
    `Workflow: ${definition.workflowSpec.name}`,
    `Original intent: ${definition.userIntent}`,
    `Schedule type: ${definition.schedule.type} (${definition.schedule.timezone})`,
    `Allowed destinations: ${capabilitySummary.expectedDestinationIds.join(', ')}`,
    'Execution steps:',
  ];

  for (const [index, node] of orderedNodes.entries()) {
    lines.push(`${index + 1}. [${node.kind}] ${node.title}`);
    if (node.instructions) {
      lines.push(`   Instructions: ${node.instructions}`);
    }
    if (node.inputs.length > 0) {
      lines.push(`   Inputs: ${node.inputs.join(', ')}`);
    }
    if (node.outputKey) {
      lines.push(`   Output key: ${node.outputKey}`);
    }
    if (node.expectedOutput) {
      lines.push(`   Expected output: ${node.expectedOutput}`);
    }
    if (node.capability) {
      lines.push(
        `   Capability: ${node.capability.toolId}.${node.capability.actionGroup} (${node.capability.operation})`,
      );
    }
    if (node.kind === 'branch' && node.branches) {
      lines.push(`   Branches: ${node.branches.map((branch) => `${branch.label} when ${branch.when}`).join(' | ')}`);
    }
    if (node.kind === 'deliver' && node.destinationIds) {
      const destinations = node.destinationIds.map((destinationId) => {
        const destination = destinationsById.get(destinationId);
        return destination ? `${destinationId}:${destination.kind}` : destinationId;
      });
      lines.push(`   Deliver to: ${destinations.join(', ')}`);
    }
    if (node.kind === 'requireApproval' && node.approvalJustification) {
      lines.push(`   Approval note: ${node.approvalJustification}`);
    }
  }

  lines.push('If runtime conditions require anything outside these steps or capabilities, stop and report the block.');

  return {
    compiledPrompt: lines.join('\n'),
    capabilitySummary,
  };
};
