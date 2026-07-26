import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  connectionsListPayloadSchema,
  gatewayRequestSchema,
  skillsSearchPayloadSchema,
  teachContextGetPayloadSchema,
  toolsListPayloadSchema,
  toolsInvokePayloadSchema,
  toolsPreflightPayloadSchema,
  workResolvePayloadSchema,
} from '../../src/application/gateway/gateway.types';
import { managerTeachLearningApplySchema } from '../../src/application/persona-learning/manager-teach-persona.types';
import { mediaImageOcrPayloadSchema } from '../../src/application/gateway/media-ocr.service';

describe('public gateway request contract', () => {
  it('rejects fields outside the provider-neutral envelope', () => {
    const parsed = gatewayRequestSchema.safeParse({
      op: 'tools.invoke',
      toolId: 'googleGmail',
      args: {},
    });

    assert.equal(parsed.success, false);
    if (parsed.success) return;
    assert(parsed.error.errors.some((issue) => issue.code === 'unrecognized_keys'));
  });

  it('accepts only a bounded, exact desktop execution context', () => {
    assert.equal(gatewayRequestSchema.safeParse({
      op: 'tools.invoke',
      execution: {
        version: 1,
        threadId: 'thread-1',
        runId: 'run-1',
        actionId: 'tool-call-1',
      },
    }).success, true);
    assert.equal(gatewayRequestSchema.safeParse({
      op: 'tools.invoke',
      execution: {
        version: 2,
        threadId: 'thread-1',
        runId: 'run-1',
        actionId: 'tool-call-1',
      },
    }).success, false);
    assert.equal(gatewayRequestSchema.safeParse({
      op: 'tools.invoke',
      execution: {
        version: 1,
        threadId: 'thread-1',
        runId: 'run-1',
        actionId: 'tool-call-1',
        forged: true,
      },
    }).success, false);
  });

  it('accepts only toolId and args inside tools.invoke payload', () => {
    assert.equal(toolsInvokePayloadSchema.safeParse({
      toolId: 'googleGmail',
      args: {
        connectionId: 'connection-1',
        op: 'call',
        nativeTool: 'search_gmail_messages',
        input: { query: 'is:unread newer_than:14d' },
      },
    }).success, true);

    const malformed = toolsInvokePayloadSchema.safeParse({
      toolId: 'googleGmail',
      connectionId: 'connection-1',
      op: 'call',
      nativeTool: 'search_gmail_messages',
      input: {},
    });
    assert.equal(malformed.success, false);
  });

  it('requires one exact supported connection provider and rejects unknown search controls', () => {
    for (const provider of ['google_workspace', 'zoho', 'canva', 'airtable', 'lark']) {
      assert.equal(connectionsListPayloadSchema.safeParse({ provider }).success, true);
    }
    assert.equal(connectionsListPayloadSchema.safeParse({}).success, false);
    assert.equal(connectionsListPayloadSchema.safeParse({ provider: 'google' }).success, false);
    assert.equal(skillsSearchPayloadSchema.safeParse({ query: 'Gmail', offset: 20 }).success, false);
  });

  it('keeps unified work resolution bounded to the exact request plus two variants', () => {
    assert.equal(workResolvePayloadSchema.safeParse({
      query: 'Research the best TTS models and write an HTML document',
      variants: [
        'Compare current TTS models using public web research and benchmarks',
        'Present the findings as an interactive HTML dashboard',
      ],
    }).success, true);
    assert.equal(workResolvePayloadSchema.safeParse({
      query: 'Research TTS models',
      variants: ['research capability', 'presentation capability', 'fourth query'],
    }).success, false);
    assert.equal(workResolvePayloadSchema.safeParse({
      query: 'Research TTS models',
      variants: ['Research TTS models'],
      hiddenFilter: 'finance',
    }).success, false);
  });

  it('allows only an exact toolId filter for tools.list', () => {
    assert.equal(toolsListPayloadSchema.safeParse({ toolId: 'googleGmail' }).success, true);
    assert.equal(toolsListPayloadSchema.safeParse({ family: 'google' }).success, false);
  });

  it('keeps Google onboarding planning internal to bounded work resolution', () => {
    assert.equal(toolsPreflightPayloadSchema.safeParse({
      invocations: [{ toolId: 'googleGmail', args: { op: 'describe', nativeTool: 'search_gmail_messages' } }],
    }).success, true);
    assert.equal(toolsPreflightPayloadSchema.safeParse({ invocations: [] }).success, false);
  });

  it('accepts only materialized image payloads at the backend boundary', () => {
    assert.equal(mediaImageOcrPayloadSchema.safeParse({
      imageBase64: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      fileName: 'screen.png',
    }).success, true);
    assert.equal(mediaImageOcrPayloadSchema.safeParse({
      filePath: '/tmp/screen.png',
      mimeType: 'image/png',
    }).success, false);
  });

  it('keeps Teach context and learning writes narrow and evidence-revisioned', () => {
    const sessionId = '29a63a44-c348-4414-b5eb-25246d7eb13d';
    assert.equal(teachContextGetPayloadSchema.safeParse({ teachSessionId: sessionId }).success, true);
    assert.equal(teachContextGetPayloadSchema.safeParse({ teachSessionId: sessionId, correction: 'hidden' }).success, false);
    assert.equal(managerTeachLearningApplySchema.safeParse({
      teachSessionId: sessionId,
      mutationKey: 'teach-initial-write-001',
      patch: {
        schemaVersion: 2,
        baseRevision: 3,
        understanding: 'The manager wants risks first.',
        readiness: {
          classifications: ['preference'], outcome: 'Keep risks prominent.', whenToUse: 'Weekly reporting.',
          inputs: null, expectedOutput: null, decisionRules: null, exceptions: null,
          automationTrigger: null, monitoringScope: null, autonomyBoundary: null, failureHandling: null,
          clarificationAnswers: [], unresolvedMaterialQuestions: [],
        },
        skills: [],
        changes: [],
      },
    }).success, true);
  });
});
