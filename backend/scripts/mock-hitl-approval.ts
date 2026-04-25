/**
 * mock-hitl-approval.ts
 *
 * Simulates a Lark "Approve" button click by calling the webhook handler
 * directly (bypasses HTTP + signature verification).
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register --project tsconfig.json scripts/mock-hitl-approval.ts
 *
 * What it does:
 *  1. Finds the latest pending HITL action for the test user
 *  2. Builds a realistic Lark card-action callback payload
 *  3. Calls the webhook event handler with mocked dependencies (no sig check, no HTTP)
 *  4. Logs every step so you can see exactly where it succeeds or fails
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { hitlActionRepository } from '../src/company/state/hitl';

// ── Config ──────────────────────────────────────────────────────────────────
const LARK_OPEN_ID   = 'ou_48b958c283635491b756c0ef23f47159';  // Abhishek (requester = manager)
const LARK_USER_ID   = 'beac9a13';
const LARK_TENANT_KEY = '150707d30199d743';
const DECISION: 'confirmed' | 'cancelled' = 'confirmed';  // change to 'cancelled' to test reject

// ── Helpers ──────────────────────────────────────────────────────────────────
const makeRes = () => {
  const res: Partial<Response> = {
    status(code: number) {
      console.log(`[MOCK-RES] HTTP ${code}`);
      return {
        json(body: unknown) {
          console.log(`[MOCK-RES] body:`, JSON.stringify(body, null, 2));
          return res as Response;
        },
      } as Response;
    },
  };
  return res as Response;
};

const makeReq = (body: unknown): Request => ({
  body,
  headers: { 'x-request-id': `mock-${randomUUID()}` },
  ip: '127.0.0.1',
  get: (h: string) => (h === 'x-request-id' ? `mock-${Date.now()}` : undefined),
  rawBody: JSON.stringify(body),
  originalUrl: '/webhooks/lark/events',
  url: '/webhooks/lark/events',
  method: 'POST',
} as unknown as Request);

// ── Build Lark card-action payload (schema 2.0) ───────────────────────────
const buildCardActionPayload = (actionId: string, decision: 'confirmed' | 'cancelled') => {
  const fakeMessageId = `om_mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return {
    schema: '2.0',
    header: {
      event_type: 'card.action.trigger',
      event_id: randomUUID(),
      token: process.env.LARK_VERIFICATION_TOKEN ?? '',
      tenant_key: LARK_TENANT_KEY,
    },
    event: {
      operator: {
        open_id: LARK_OPEN_ID,
        user_id: LARK_USER_ID,
        operator_id: {
          open_id: LARK_OPEN_ID,
          user_id: LARK_USER_ID,
        },
      },
      context: {
        open_message_id: fakeMessageId,
        open_chat_id: LARK_OPEN_ID,  // p2p DM → chatId = openId
      },
      action: {
        value: {
          id: decision === 'confirmed' ? 'hitl_approve' : 'hitl_reject',
          kind: 'hitl_tool_action',
          actionId,
          decision,
        },
        tag: 'button',
        element_id: decision === 'confirmed' ? 'action_1' : 'action_2',
      },
    },
  };
};

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Mock HITL Approval Button Click ===\n');

  // 1. Find the pending action
  const slim = await hitlActionRepository.getLatestPendingByChat('lark', LARK_OPEN_ID);
  if (!slim) {
    console.log('❌ No pending HITL action found. Run the harness first.');
    return;
  }
  console.log('✅ Found pending action:', slim.actionId);
  console.log('   toolId:', slim.toolId, '| summary:', slim.summary, '\n');

  // 2. Build the mock payload
  const payload = buildCardActionPayload(slim.actionId, DECISION);
  console.log('📦 Card action payload:');
  console.log(JSON.stringify(payload, null, 2), '\n');

  // 3. Import the webhook handler factory (with overrides so we bypass signature check)
  const { createLarkWebhookEventHandler } = await import(
    '../src/company/channels/lark/lark.webhook.routes'
  );

  const { LarkChannelAdapter } = await import('../src/company/channels/lark/lark.adapter');
  const realAdapter = new LarkChannelAdapter();

  const handler = createLarkWebhookEventHandler({
    // Override verifyRequest: always pass
    verifyRequest: () => ({ ok: true as const }),

    // Use real adapter but override outbound calls so we don't actually hit Lark API
    adapter: {
      normalizeIncomingEvent: realAdapter.normalizeIncomingEvent.bind(realAdapter),
      getMessage: realAdapter.getMessage.bind(realAdapter),
      downloadFile: realAdapter.downloadFile.bind(realAdapter),
      updateMessage: async (input: unknown) => {
        console.log('\n📝 [adapter.updateMessage] Card would be updated with:');
        console.log(JSON.stringify(input, null, 2));
        return { channel: 'lark' as const, status: 'sent' as const, chatId: '', messageId: 'mock' };
      },
      sendMessage: async (input: unknown) => {
        console.log('\n📤 [adapter.sendMessage] Message would be sent:');
        console.log(JSON.stringify(input, null, 2));
        return { channel: 'lark' as const, status: 'sent' as const, chatId: '', messageId: 'mock' };
      },
    } as any,
  });

  const req = makeReq(payload);
  const res = makeRes();

  console.log('🚀 Calling webhook handler...\n');
  await handler(req, res, (err?: unknown) => {
    if (err) console.error('[MOCK-NEXT] Error passed to next():', err);
  });

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split('\n').slice(0, 10).join('\n'));
  }
  process.exitCode = 1;
});
