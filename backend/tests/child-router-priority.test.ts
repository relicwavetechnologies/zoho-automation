import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChildRouterPrompt,
  runDesktopChildRouter,
} from '../src/modules/desktop-chat/vercel-desktop.engine';

test('child router prompt separates current request from history and states priority rule', () => {
  const prompt = buildChildRouterPrompt({
    message: 'get my tasks',
    history: [
      { role: 'user', content: 'edit that workflow' },
      { role: 'assistant', content: 'I updated the workflow timing.' },
    ],
    allowedToolIds: ['lark-task-read', 'workflowList'],
  });

  assert.match(prompt, /## Conversation history \(background context only\)/);
  assert.match(prompt, /## CURRENT REQUEST — this is the ONLY message that determines tool selection/);
  assert.match(prompt, /Message: get my tasks/);
  assert.match(prompt, /current request wins unconditionally/i);
  assert.match(prompt, /lark-task-read must be in exposed tools/);
  assert.match(prompt, /Allowed preferredReplyMode values: thread, reply, plain, dm/);
  assert.match(prompt, /preferredReplyMode is your delivery proposal for this turn/i);
});

test('child router returns fast reply for bare mentions without inferring tools from history', async () => {
  const route = await runDesktopChildRouter({
    executionId: 'exec-1',
    threadId: 'thread-1',
    message: '@Divo',
    history: [
      { role: 'user', content: 'edit that workflow' },
      { role: 'assistant', content: 'I updated the workflow timing.' },
    ],
  });

  assert.equal(route.route, 'fast_reply');
  assert.equal(route.reply, 'You mentioned me — what would you like me to do?');
  assert.equal(route.normalizedIntent, 'unknown');
  assert.equal(route.preferredReplyMode, 'reply');
  assert.deepEqual(route.suggestedToolIds, []);
  assert.deepEqual(route.suggestedActions, []);
});
