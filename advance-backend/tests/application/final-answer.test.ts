import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FinalAnswerAccumulator } from '../../src/application/orchestration/agents/final-answer';

describe('FinalAnswerAccumulator', () => {
  it('delivers only what the model said after its last tool call', () => {
    // Reproduces a real Lark reply. Three steps of narration arrived glued to
    // the answer, so the user read the model thinking out loud before getting
    // told anything.
    const answer = new FinalAnswerAccumulator();

    answer.appendText("Airtable isn't set up as a full skill, but I can try the direct tools. ");
    answer.appendText('Let me see what\'s available in your Airtable account.');
    answer.onToolCall();
    answer.appendText('Schema access is restricted. Let me try fetching records directly.');
    answer.onToolCall();
    answer.appendText("Airtable isn't connected to your account, or its permissions haven't been approved yet.");

    assert.equal(
      answer.text,
      "Airtable isn't connected to your account, or its permissions haven't been approved yet.",
    );
    assert.doesNotMatch(answer.text, /Let me see what/);
    assert.doesNotMatch(answer.text, /Schema access is restricted/);
  });

  it('keeps a single-step answer that never called a tool', () => {
    const answer = new FinalAnswerAccumulator();
    answer.appendText('Hi there! How can I help you today?');

    assert.equal(answer.text, 'Hi there! How can I help you today?');
  });

  it('joins deltas within the answering step', () => {
    // Text arrives token by token; splitting it must not lose anything.
    const answer = new FinalAnswerAccumulator();
    answer.appendText('working…');
    answer.onToolCall();
    for (const piece of ['You have ', '3 unread ', 'emails.']) answer.appendText(piece);

    assert.equal(answer.text, 'You have 3 unread emails.');
  });

  it('falls back to the transcript when the run ended mid-work', () => {
    // Step budget exhausted on a tool call, so nothing was said afterwards.
    // Showing the working beats showing nothing, and it is what shipped before.
    const answer = new FinalAnswerAccumulator();
    answer.appendText('Checking your calendar now.');
    answer.onToolCall();

    assert.equal(answer.text, 'Checking your calendar now.');
  });

  it('treats whitespace after the last tool call as nothing said', () => {
    const answer = new FinalAnswerAccumulator();
    answer.appendText('Looking that up.');
    answer.onToolCall();
    answer.appendText('\n  \n');

    assert.equal(answer.text, 'Looking that up.');
  });

  it('keeps the full transcript for the work log', () => {
    // The status timeline is meant to show narration; only the reply drops it.
    const answer = new FinalAnswerAccumulator();
    answer.appendText('Trying Gmail. ');
    answer.onToolCall();
    answer.appendText('Found 3 messages.');

    assert.equal(answer.fullTranscript, 'Trying Gmail. Found 3 messages.');
    assert.equal(answer.text, 'Found 3 messages.');
  });
});
