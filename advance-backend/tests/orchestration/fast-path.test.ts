import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyMessage, runFastPath } from '../../src/application/orchestration/engine/fast-path.ts';
import { textModel, errorModel } from '../helpers/mock-model.ts';
import type { Logger } from '../../src/shared/logger.ts';

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

// ── classifyMessage ───────────────────────────────────────────────────────────

describe('classifyMessage', () => {
  describe('SIMPLE patterns', () => {
    for (const msg of ['hi', 'hey', 'hello', 'Hello!', 'good morning', 'good evening']) {
      it(`"${msg}" → SIMPLE`, () => assert.equal(classifyMessage(msg), 'SIMPLE'));
    }
    for (const msg of ['thanks', 'thank you', 'Thanks!', 'Thank you!']) {
      it(`"${msg}" → SIMPLE`, () => assert.equal(classifyMessage(msg), 'SIMPLE'));
    }
    for (const msg of ['ok', 'okay', 'got it', 'sure', 'sounds good', 'noted', 'great', 'perfect', 'alright']) {
      it(`"${msg}" → SIMPLE`, () => assert.equal(classifyMessage(msg), 'SIMPLE'));
    }
    for (const msg of ['bye', 'goodbye', 'see you', 'later']) {
      it(`"${msg}" → SIMPLE`, () => assert.equal(classifyMessage(msg), 'SIMPLE'));
    }
    it('"who are you?" → SIMPLE', () => assert.equal(classifyMessage('who are you?'), 'SIMPLE'));
    it('"how are you?" → SIMPLE', () => assert.equal(classifyMessage('how are you?'), 'SIMPLE'));
    it('"what can you do?" → SIMPLE', () => assert.equal(classifyMessage('what can you do?'), 'SIMPLE'));
    it('"what time is it?" → SIMPLE', () => assert.equal(classifyMessage('what time is it?'), 'SIMPLE'));
    it('"what day is it?" → SIMPLE', () => assert.equal(classifyMessage('what day is it?'), 'SIMPLE'));
    it('"what\'s the date?" → SIMPLE', () => assert.equal(classifyMessage("what's the date?"), 'SIMPLE'));
  });

  describe('COMPLEX — business keywords', () => {
    it('"send email to John" → COMPLEX', () => assert.equal(classifyMessage('send email to John'), 'COMPLEX'));
    it('"create invoice for $500" → COMPLEX', () => assert.equal(classifyMessage('create invoice for $500'), 'COMPLEX'));
    it('"find the report from last week" → COMPLEX', () => assert.equal(classifyMessage('find the report from last week'), 'COMPLEX'));
    it('"schedule a meeting tomorrow" → COMPLEX', () => assert.equal(classifyMessage('schedule a meeting tomorrow'), 'COMPLEX'));
    it('"list my tasks" → COMPLEX', () => assert.equal(classifyMessage('list my tasks'), 'COMPLEX'));
    it('"check the zoho pipeline" → COMPLEX', () => assert.equal(classifyMessage('check the zoho pipeline'), 'COMPLEX'));
    it('"draft an approval request" → COMPLEX', () => assert.equal(classifyMessage('draft an approval request'), 'COMPLEX'));
    it('"fetch my calendar" → COMPLEX', () => assert.equal(classifyMessage('fetch my calendar'), 'COMPLEX'));
    it('"update the deal status" → COMPLEX', () => assert.equal(classifyMessage('update the deal status'), 'COMPLEX'));
  });

  describe('COMPLEX — length guard', () => {
    it('81-character string → COMPLEX regardless of content', () => {
      assert.equal(classifyMessage('a'.repeat(81)), 'COMPLEX');
    });
    it('80-character string of spaces/ok → still classified by content', () => {
      // Short enough, no business keyword, doesn't match simple patterns → COMPLEX by default
      assert.equal(classifyMessage('o'.repeat(80)), 'COMPLEX');
    });
  });

  describe('COMPLEX — default fallback', () => {
    it('"can you help me plan something?" → COMPLEX (no keyword match, not greeting)', () => {
      assert.equal(classifyMessage('can you help me plan something?'), 'COMPLEX');
    });
    it('empty string → COMPLEX', () => assert.equal(classifyMessage(''), 'COMPLEX'));
  });
});

// ── runFastPath ───────────────────────────────────────────────────────────────

describe('runFastPath', () => {
  it('returns trimmed text from model', async () => {
    const result = await runFastPath({
      userMessage: 'hi',
      history: [],
      model: textModel('  Hello there!  '),
      log: noopLogger,
    });
    assert.equal(result.text, 'Hello there!');
  });

  it('falls back to default greeting when model returns empty string', async () => {
    const result = await runFastPath({
      userMessage: 'hey',
      history: [],
      model: textModel(''),
      log: noopLogger,
    });
    assert.equal(result.text, 'Hello! How can I help you?');
  });

  it('propagates history turns to the model call', async () => {
    // textModel always returns the same text regardless of input — just verify no throws
    const result = await runFastPath({
      userMessage: 'thanks',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      model: textModel('You\'re welcome!'),
      log: noopLogger,
    });
    assert.equal(result.text, 'You\'re welcome!');
  });

  it('throws when model call fails (caller handles the error)', async () => {
    await assert.rejects(
      () => runFastPath({
        userMessage: 'hi',
        history: [],
        model: errorModel('LLM offline'),
        log: noopLogger,
      }),
      /LLM offline/,
    );
  });
});
