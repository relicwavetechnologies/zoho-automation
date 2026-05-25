import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessReplyQuality,
  buildPresentationContext,
  cleanReplyText,
} from '../../src/application/orchestration/engine/reply-quality.ts';

describe('reply quality assessment', () => {
  it('flags completed Lark task titles that are missing from the final reply', () => {
    const assessment = assessReplyQuality({
      userMessage: 'make lark tasks for HTML skills and research skills',
      replyText:   'The tasks have been created in your Lark account.',
      toolsCalled: ['agent_lark_ops'],
      toolResults: [{
        toolName: 'agent_lark_ops',
        output: [
          'Task "Develop HTML skills" has been created.',
          'Task "Develop research skills" has been created.',
        ].join('\n'),
      }],
    });

    assert.equal(assessment.needsSynthesis, true);
    assert.deepEqual(assessment.createdTaskTitles, [
      'Develop HTML skills',
      'Develop research skills',
    ]);
    assert.ok(assessment.reasons.some(reason => reason.startsWith('missing_created_task_titles:')));
  });

  it('flags future-tense process narration after completed actions', () => {
    const assessment = assessReplyQuality({
      userMessage: 'make lark tasks',
      replyText:   'The tasks were not successfully created in Lark. I will create them for you now. The tasks have been created in your Lark account.',
      toolsCalled: ['agent_lark_ops'],
      toolResults: [{
        toolName: 'agent_lark_ops',
        output: 'Task "Develop HTML skills" has been created.',
      }],
    });

    assert.equal(assessment.needsSynthesis, true);
    assert.ok(assessment.reasons.includes('future_tense_after_completed_actions'));
  });

  it('flags Lark task intent that only updated the internal checklist', () => {
    const assessment = assessReplyQuality({
      userMessage: 'make lark tasks for me',
      replyText:   'I have added these items to your task list.',
      toolsCalled: ['manageTodos'],
      toolResults: [{
        toolName: 'manageTodos',
        output: 'Added todo: "Develop HTML skills" (id:todo_1)',
      }],
    });

    assert.equal(assessment.needsSynthesis, true);
    assert.equal(assessment.internalOnlyChecklist, true);
    assert.ok(assessment.reasons.includes('lark_task_intent_only_internal_checklist'));
  });

  it('does not flag a reply that includes all created task titles', () => {
    const assessment = assessReplyQuality({
      userMessage: 'make lark tasks',
      replyText:   'Created 2 Lark tasks: Develop HTML skills and Develop research skills.',
      toolsCalled: ['agent_lark_ops'],
      toolResults: [{
        toolName: 'agent_lark_ops',
        output: [
          'Task "Develop HTML skills" has been created.',
          'Task "Develop research skills" has been created.',
        ].join('\n'),
      }],
    });

    assert.equal(assessment.needsSynthesis, false);
  });

  it('classifies manageTodos as internal context for the presentation pass', () => {
    const context = buildPresentationContext({
      userMessage: 'make lark tasks',
      replyText:   'Done.',
      toolsCalled: ['manageTodos'],
      toolResults: [{
        toolName: 'manageTodos',
        output: 'Added todo: "Develop HTML skills" (id:todo_1)',
      }],
    });

    assert.match(context, /INTERNAL Divo checklist\/progress only/);
    assert.match(context, /This is NOT a Lark Task/);
  });

  it('removes hidden tool trace markers from reply text', () => {
    assert.equal(
      cleanReplyText('Done.\n<!--TOOL_TRACE:[{"toolName":"x"}]-->'),
      'Done.',
    );
  });
});
