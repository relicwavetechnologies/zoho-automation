import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileScheduledWorkflowDefinition,
  scheduledWorkflowDefinitionSchema,
  summarizeScheduledWorkflowCapabilities,
} from '../src/company/scheduled-workflows/contracts';

const baseDefinition = {
  userIntent: 'Every weekday, summarize fresh support escalations and send the digest to Lark.',
  schedule: {
    type: 'weekly' as const,
    timezone: 'Asia/Kolkata',
    daysOfWeek: ['MO', 'TU', 'WE', 'TH', 'FR'],
    time: {
      hour: 9,
      minute: 0,
    },
  },
  outputConfig: {
    version: 'v1' as const,
    destinations: [
      {
        id: 'desktop-inbox',
        kind: 'desktop_inbox' as const,
        label: 'Desktop Inbox',
      },
      {
        id: 'ops-lark',
        kind: 'lark_chat' as const,
        label: 'Ops Lark',
        chatId: 'oc_support_ops',
      },
    ],
    defaultDestinationIds: ['desktop-inbox'],
  },
  workflowSpec: {
    version: 'v1' as const,
    name: 'Support Escalation Digest',
    nodes: [
      {
        id: 'search-incidents',
        kind: 'search' as const,
        title: 'Search new incidents',
        instructions: 'Search the support backlog for escalations created since the previous run.',
        expectedOutput: 'A list of open escalations with ownership and severity.',
        outputKey: 'escalations',
        capability: {
          toolId: 'search-read',
          actionGroup: 'read' as const,
          operation: 'support.escalations.search',
        },
      },
      {
        id: 'draft-summary',
        kind: 'analyze' as const,
        title: 'Draft summary',
        instructions: 'Group escalations by owner, severity, and aging risk.',
        inputs: ['escalations'],
        outputKey: 'digest',
      },
      {
        id: 'send-lark',
        kind: 'send' as const,
        title: 'Send digest to Lark',
        instructions: 'Post the digest to the operations channel.',
        inputs: ['digest'],
        capability: {
          toolId: 'google-gmail',
          actionGroup: 'send' as const,
          operation: 'ops.digest.send',
        },
        toolArguments: {
          recipientOpenIds: ['ou_123'],
          recipientLabels: ['Anish Suman (ou_123)'],
          messageTemplate: 'Support digest ready.',
        },
      },
      {
        id: 'deliver-history',
        kind: 'deliver' as const,
        title: 'Persist run output',
        destinationIds: ['desktop-inbox', 'ops-lark'],
      },
    ],
    edges: [
      { sourceId: 'search-incidents', targetId: 'draft-summary' },
      { sourceId: 'draft-summary', targetId: 'send-lark' },
      { sourceId: 'send-lark', targetId: 'deliver-history' },
    ],
  },
};

test('scheduled workflow definition validates a publishable workflow', () => {
  const parsed = scheduledWorkflowDefinitionSchema.parse(baseDefinition);
  assert.equal(parsed.workflowSpec.nodes.length, 4);
  assert.deepEqual(parsed.outputConfig.defaultDestinationIds, ['desktop-inbox']);
});

test('summarizeScheduledWorkflowCapabilities derives approval metadata and fingerprint', () => {
  const parsed = scheduledWorkflowDefinitionSchema.parse(baseDefinition);
  const summary = summarizeScheduledWorkflowCapabilities(parsed);

  assert.deepEqual(summary.requiredTools, ['google-gmail', 'search-read']);
  assert.deepEqual(summary.requiredActionGroupsByTool, {
    'google-gmail': ['send'],
    'search-read': ['read'],
  });
  assert.equal(summary.requiresPublishApproval, true);
  assert.equal(summary.expectedDestinationIds.join(','), 'desktop-inbox,ops-lark');
  assert.equal(summary.capabilityFingerprint.length, 64);
});

test('compileScheduledWorkflowDefinition emits a controlled prompt', () => {
  const { compiledPrompt, capabilitySummary } = compileScheduledWorkflowDefinition(baseDefinition);

  assert.match(compiledPrompt, /Workflow: Support Escalation Digest/);
  assert.match(compiledPrompt, /Capability: search-read.read \(support\.escalations\.search\)/);
  assert.match(compiledPrompt, /Tool arguments: \{"messageTemplate":"Support digest ready\."/);
  assert.match(compiledPrompt, /Deliver to: desktop-inbox:desktop_inbox, ops-lark:lark_chat/);
  assert.equal(capabilitySummary.requiresPublishApproval, true);
});

test('scheduled workflow definition accepts structured tool arguments on capability nodes', () => {
  const parsed = scheduledWorkflowDefinitionSchema.parse(baseDefinition);
  const sendNode = parsed.workflowSpec.nodes.find((node) => node.id === 'send-lark');

  assert.deepEqual(sendNode?.toolArguments, {
    recipientOpenIds: ['ou_123'],
    recipientLabels: ['Anish Suman (ou_123)'],
    messageTemplate: 'Support digest ready.',
  });
});

test('definition validation rejects unknown delivery destinations', () => {
  assert.throws(() => {
    scheduledWorkflowDefinitionSchema.parse({
      ...baseDefinition,
      workflowSpec: {
        ...baseDefinition.workflowSpec,
        nodes: baseDefinition.workflowSpec.nodes.map((node) =>
          node.id === 'deliver-history'
            ? { ...node, destinationIds: ['missing-destination'] }
            : node),
      },
    });
  }, (error: unknown) => {
    assert.match(String(error), /Unknown delivery destination/);
    assert.match(String(error), /missing-destination/);
    return true;
  });
});

test('definition validation rejects unsupported tool action groups', () => {
  assert.throws(() => {
    scheduledWorkflowDefinitionSchema.parse({
      ...baseDefinition,
      workflowSpec: {
        ...baseDefinition.workflowSpec,
        nodes: baseDefinition.workflowSpec.nodes.map((node) =>
          node.id === 'search-incidents'
            ? {
              ...node,
              capability: {
                toolId: 'search-read',
                actionGroup: 'delete',
                operation: 'support.escalations.delete',
              },
            }
            : node),
      },
    });
  }, (error: unknown) => {
    assert.match(String(error), /Tool/);
    assert.match(String(error), /search-read/);
    assert.match(String(error), /delete/);
    return true;
  });
});
