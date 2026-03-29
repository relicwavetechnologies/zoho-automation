import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyIntent,
  detectRouteIntentCompat,
  isDestructiveIntentCompat,
  isWriteLikeIntentCompat,
  toNarrowOperationClass,
} from '../src/company/orchestration/intent/canonical-intent';

const CASES = [
  ['email me all my invoices', 'send', 'zoho_books'],
  ['delete the invoice', 'destructive', 'zoho_books'],
  ['get my tasks', 'read', 'lark'],
  ['schedule a meeting with finance', 'action', 'calendar'],
  ['gmail draft a reply to Sam', 'send', 'gmail'],
  ['search the latest news about OpenAI', 'read', 'web_search'],
  ['write this into a lark doc', 'write', 'lark_doc'],
  ['show me the Zoho deal owner', 'read', 'zoho_crm'],
  ['remove the old contact from Zoho CRM', 'destructive', 'zoho_crm'],
  ['approve the vendor payment', 'action', 'zoho_books'],
  ['forward this message to the team', 'send', 'general'],
  ['update the task due date', 'write', 'lark'],
  ['book a calendar appointment for tomorrow', 'action', 'calendar'],
  ['look up the domain authority for example.com', 'read', 'outreach'],
  ['clear my overdue bills', 'destructive', 'zoho_books'],
  ['import these expenses into Zoho Books', 'write', 'zoho_books'],
  ['reply to this Gmail thread', 'send', 'gmail'],
  ['what documents do we have', 'read', 'lark_doc'],
  ['notify the team in lark', 'send', 'lark'],
  ['show current website status', 'read', 'web_search'],
] as const;

for (const [message, operationClass, domain] of CASES) {
  test(`canonical intent classifies "${message}"`, () => {
    const intent = classifyIntent(message);
    assert.equal(intent.operationClass, operationClass);
    assert.equal(intent.domain, domain);
  });
}

test('planner write signal is trusted when no verb matches', () => {
  const intent = classifyIntent('invoice follow-up please', {
    plannerChosenOperationClass: 'write',
  });
  assert.equal(intent.operationClass, 'write');
  assert.equal(intent.isWriteLike, true);
});

test('normalized intent contributes to verb matching', () => {
  const intent = classifyIntent('that one', {
    normalizedIntent: 'send the invoice by email',
  });
  assert.equal(intent.operationClass, 'send');
  assert.equal(intent.isSendLike, true);
});

test('child router domain fills in when keywords are weak', () => {
  const intent = classifyIntent('that again', {
    childRouterDomain: 'zoho_books',
  });
  assert.equal(intent.domain, 'zoho_books');
});

test('bare continuation inherits read intent from prior read-only tool results', () => {
  const intent = classifyIntent('try again', {
    plannerChosenOperationClass: 'write',
    childRouterOperationType: 'send',
    priorToolResults: [
      {
        status: 'success',
        confirmedAction: false,
        attemptedWrite: false,
        operation: 'read',
      },
    ],
  });
  assert.equal(intent.operationClass, 'read');
  assert.equal(intent.isWriteLike, false);
  assert.equal(intent.isContinuation, true);
});

test('bare continuation inherits write intent from prior failed write attempt', () => {
  const intent = classifyIntent('retry', {
    childRouterOperationType: 'read',
    priorToolResults: [
      {
        status: 'error',
        confirmedAction: false,
        attemptedWrite: true,
        operation: 'send',
      },
    ],
  });
  assert.equal(intent.operationClass, 'send');
  assert.equal(intent.isWriteLike, true);
  assert.equal(intent.isContinuation, true);
});

test('compat shims align books requests to write_intent', () => {
  assert.equal(detectRouteIntentCompat('show me all my invoices'), 'write_intent');
  assert.equal(isWriteLikeIntentCompat('email me all my invoices'), true);
  assert.equal(isDestructiveIntentCompat('archive that invoice'), true);
});

test('narrow operation mapping preserves downstream tool-selection contracts', () => {
  assert.equal(toNarrowOperationClass(classifyIntent('search the web for docs')), 'search');
  assert.equal(toNarrowOperationClass(classifyIntent('schedule a meeting')), 'schedule');
  assert.equal(toNarrowOperationClass(classifyIntent('delete the invoice')), 'write');
  assert.equal(toNarrowOperationClass(classifyIntent('open this document')), 'inspect');
  assert.equal(toNarrowOperationClass(classifyIntent('tell me the deal owner')), 'read');
});
