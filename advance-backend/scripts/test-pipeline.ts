#!/usr/bin/env tsx
/**
 * test-pipeline.ts — end-to-end pipeline test.
 *
 * Layer 1 (always runs): create a real Lark task via the client directly,
 *   assigned to Abhishek. Verifies the Lark client + API work.
 *
 * Layer 2 (when server is up on :8000): fire a fake Lark webhook event into
 *   the running advance-backend and watch the engine actually create a task.
 *
 * Usage:
 *   pnpm tsx scripts/test-pipeline.ts
 */

import 'dotenv/config';
import { LarkTaskClient } from '../src/infrastructure/channels/lark/clients/lark-task.client';

// ── colours ─────────────────────────────────────────────────────────────────
const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m';
const C = '\x1b[36m'; const D = '\x1b[2m';  const N = '\x1b[0m'; const B = '\x1b[1m';

let passed = 0; let failed = 0;
function pass(label: string, note = '')  { passed++;  console.log(`  ${G}✓${N}  ${label.padEnd(32)} ${D}${note}${N}`); }
function fail(label: string, e: unknown) { failed++;  console.log(`  ${R}✗${N}  ${label.padEnd(32)} ${R}${e instanceof Error ? e.message : String(e)}${N}`); }
function section(t: string) { console.log(`\n${C}── ${t} ${'─'.repeat(Math.max(0, 46 - t.length))}${N}`); }
function info(t: string)    { console.log(`  ${D}${t}${N}`); }

const appId     = process.env['LARK_APP_ID']!;
const appSecret = process.env['LARK_APP_SECRET']!;
const verToken  = process.env['LARK_VERIFICATION_TOKEN']!;
const backendUrl = process.env['BACKEND_PUBLIC_URL'] ?? 'http://localhost:8000';

// Known from DB
const ABHISHEK_OPEN_ID = 'ou_48b958c283635491b756c0ef23f47159';
const P2P_CHAT_ID      = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50'; // p2p chat from LarkChatContext

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — Direct client test: create task with assignee, then clean up
// ─────────────────────────────────────────────────────────────────────────────

async function testDirectClient(): Promise<void> {
  section('Layer 1 — Direct Lark Client (bypassing orchestration)');
  const client = new LarkTaskClient({ appId, appSecret });

  const title = `[Pipeline Test] complete the omi research — ${new Date().toISOString().slice(0, 19)}`;
  let taskId = '';

  try {
    const created = await client.createTask({
      title,
      assigneeIds: [ABHISHEK_OPEN_ID],
      notes: 'Created by advance-backend pipeline test script.',
    });
    taskId = created.taskId;
    pass('create task with assignee', `taskId: ${taskId}`);
  } catch (e) {
    fail('create task with assignee', e);
    return;
  }

  try {
    const got = await client.getTask(taskId);
    if (got.title !== title) throw new Error(`title mismatch: got "${got.title}"`);
    pass('get task (verify created)', `completed: ${got.completed}`);
  } catch (e) { fail('get task', e); }

  try {
    await client.updateTask(taskId, { notes: 'Updated by pipeline test.' });
    pass('update task notes', '');
  } catch (e) { fail('update task notes', e); }

  try {
    await client.deleteTask(taskId);
    pass('delete task (cleanup)', '');
  } catch (e) { fail('delete task (cleanup)', e); }

  console.log();
  info(`Abhishek's open_id used as assignee: ${ABHISHEK_OPEN_ID}`);
  info('If the task appeared in Lark and the above steps all passed, the client layer is healthy.');
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — Full orchestration pipeline via real webhook POST
// ─────────────────────────────────────────────────────────────────────────────

async function testOrchestrationPipeline(): Promise<void> {
  section('Layer 2 — Full Pipeline (webhook → engine → Lark API)');

  // Check server is up first
  let serverUp = false;
  try {
    const health = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(3000) });
    serverUp = health.ok;
  } catch { /* not running */ }

  if (!serverUp) {
    console.log(`  ${Y}⚠${N}  Server not reachable at ${backendUrl} — skipping Layer 2`);
    console.log(`  ${D}Start the server with: pnpm dev  (inside advance-backend/)${N}`);
    return;
  }

  info(`Server up at ${backendUrl}`);

  const msgId  = `om_pipeline_test_${Date.now()}`;
  const chatId = P2P_CHAT_ID;

  // Craft a minimal Lark im.message.receive_v1 event
  const event = {
    schema: '2.0',
    token: verToken,                   // passes LARK_VERIFICATION_TOKEN check
    header: {
      event_id:   msgId,
      event_type: 'im.message.receive_v1',
      create_time: String(Date.now()),
      token:      verToken,
      app_id:     appId,
    },
    event: {
      sender: {
        sender_id: {
          open_id:  ABHISHEK_OPEN_ID,
          user_id:  '',
          union_id: '',
        },
        sender_type: 'user',          // must NOT be 'bot'
        tenant_key:  '',
      },
      message: {
        message_id:   msgId,
        root_id:      '',
        parent_id:    '',
        create_time:  String(Date.now()),
        chat_id:      chatId,
        chat_type:    'p2p',          // p2p → mentionsSelf=true, no @mention needed
        message_type: 'text',
        content:      JSON.stringify({
          text: 'create a lark task titled "complete the omi research" and assign it to myself',
        }),
        mentions: [],
      },
    },
  };

  console.log();
  info(`Sending webhook with message: "${JSON.parse(event.event.message.content).text}"`);
  info(`Sender open_id: ${ABHISHEK_OPEN_ID}  |  chat_id: ${chatId} (p2p)`);
  console.log();

  let webhookOk = false;
  try {
    const res = await fetch(`${backendUrl}/webhooks/lark/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    webhookOk = body['ok'] === true;
    pass('webhook accepted (HTTP 200)', `response: ${JSON.stringify(body)}`);
  } catch (e) {
    fail('webhook POST', e);
    return;
  }

  if (!webhookOk) {
    fail('webhook response.ok', 'server returned ok:false');
    return;
  }

  // The engine runs async — give it time
  console.log();
  info('Waiting 25s for the engine to plan + execute + reply...');
  await new Promise(r => setTimeout(r, 25_000));

  // Now check if a task was actually created by listing recent tasks
  section('Layer 2 — Verify task was created in Lark');
  const client = new LarkTaskClient({ appId, appSecret });
  try {
    const tasks = await client.listTasks({ limit: 20 });
    const created = tasks.find(t =>
      t.title.toLowerCase().includes('omi research') ||
      t.title.toLowerCase().includes('complete the omi'),
    );
    if (created) {
      pass('task found in Lark', `taskId: ${created.taskId}  title: "${created.title}"`);
      console.log();
      info(`Cleaning up task ${created.taskId}...`);
      try {
        await client.deleteTask(created.taskId);
        pass('cleanup created task', '');
      } catch (e) { fail('cleanup', e); }
    } else {
      fail('task NOT found in Lark', `Listed ${tasks.length} tasks — none matched "omi research"`);
      info('Recent tasks:');
      tasks.slice(0, 5).forEach(t => info(`  ${t.taskId}  "${t.title}"  completed:${t.completed}`));
    }
  } catch (e) {
    fail('list tasks (verify)', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

void (async () => {
  console.log(`\n${B}${C}Divo — Pipeline Test${N}  ${D}${new Date().toISOString().slice(0, 19)}${N}`);
  console.log(`${D}  appId: ${appId}  |  backend: ${backendUrl}${N}`);

  await testDirectClient();
  await testOrchestrationPipeline();

  console.log(`\n${passed > 0 ? G : ''}${B}Summary:${N} ${G}${passed} passed${N} · ${failed > 0 ? R : D}${failed} failed${N}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
