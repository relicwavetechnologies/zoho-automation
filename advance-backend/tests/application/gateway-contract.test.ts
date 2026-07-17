import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  connectionsListPayloadSchema,
  googlePlanPayloadSchema,
  gatewayRequestSchema,
  skillsSearchPayloadSchema,
  toolsListPayloadSchema,
  toolsInvokePayloadSchema,
  toolsPreflightPayloadSchema,
} from '../../src/application/gateway/gateway.types';
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

  it('rejects invented provider names and unknown search controls', () => {
    assert.equal(connectionsListPayloadSchema.safeParse({ provider: 'google' }).success, false);
    assert.equal(connectionsListPayloadSchema.safeParse({ provider: 'google_workspace' }).success, true);
    assert.equal(skillsSearchPayloadSchema.safeParse({ query: 'Gmail', offset: 20 }).success, false);
  });

  it('allows only an exact toolId filter for tools.list', () => {
    assert.equal(toolsListPayloadSchema.safeParse({ toolId: 'googleGmail' }).success, true);
    assert.equal(toolsListPayloadSchema.safeParse({ family: 'google' }).success, false);
  });

  it('accepts only the bounded Google plan and batch preflight contracts', () => {
    assert.equal(googlePlanPayloadSchema.safeParse({ workflow: 'vendor_onboarding' }).success, true);
    assert.equal(googlePlanPayloadSchema.safeParse({
      workflow: 'vendor_onboarding',
      phaseIds: ['gmail_source', 'calendar_availability', 'google_doc', 'calendar_event'],
    }).success, true);
    assert.equal(googlePlanPayloadSchema.safeParse({
      workflow: 'vendor_onboarding', phaseIds: ['gmail_source', 'lark_contact'],
    }).success, false);
    assert.equal(googlePlanPayloadSchema.safeParse({ workflow: 'vendor_onboarding', unexpected: true }).success, false);
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
});
