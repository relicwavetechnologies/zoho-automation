import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  answerableWithButtons,
  checkAnswer,
  confirmAnswer,
  confirmQuestion,
  isOpen,
  nextQuestion,
  summarizeAnswer,
  verdictOf,
  type DecisionQuestion,
} from '../../src/domain/decision/decision';

const FLAVOURS: DecisionQuestion = {
  id: 'flavours',
  ask: 'How many flavours should we launch?',
  pick: 'one',
  options: [
    { value: 'three', label: 'Three (core line)' },
    { value: 'five', label: 'Five (full case)' },
  ],
};

const MIXINS: DecisionQuestion = {
  id: 'mixins',
  ask: 'Which mix-ins should we stock?',
  pick: 'many',
  options: [
    { value: 'chips', label: 'Chocolate chips' },
    { value: 'waffle', label: 'Waffle bits' },
  ],
  allowText: true,
};

const NAME: DecisionQuestion = {
  id: 'name',
  ask: 'What should we call it?',
  text: { placeholder: 'Type something…' },
};

describe('checkAnswer', () => {
  it('accepts a complete answer across both question shapes', () => {
    assert.equal(checkAnswer([FLAVOURS, MIXINS, NAME], {
      responses: [
        { questionId: 'flavours', chose: ['three'] },
        { questionId: 'mixins', chose: ['chips', 'waffle'] },
        { questionId: 'name', chose: [], said: 'Sundae' },
      ],
    }), null);
  });

  it('refuses an answer to a question that was not asked', () => {
    /* The only ways to produce one are a stale card and a forged request.
       Ignoring the extra would accept both. */
    assert.deepEqual(checkAnswer([FLAVOURS], {
      responses: [
        { questionId: 'flavours', chose: ['three'] },
        { questionId: 'ghost', chose: ['x'] },
      ],
    }), { reason: 'unknown_question', questionId: 'ghost' });
  });

  it('refuses a value that is not on the card', () => {
    assert.deepEqual(checkAnswer([FLAVOURS], {
      responses: [{ questionId: 'flavours', chose: ['seven'] }],
    }), { reason: 'unknown_option', questionId: 'flavours', value: 'seven' });
  });

  it('refuses two choices where the question offered one', () => {
    assert.deepEqual(checkAnswer([FLAVOURS], {
      responses: [{ questionId: 'flavours', chose: ['three', 'five'] }],
    }), { reason: 'needs_exactly_one', questionId: 'flavours' });
  });

  it('refuses typed words on a question that never offered them', () => {
    assert.deepEqual(checkAnswer([FLAVOURS], {
      responses: [{ questionId: 'flavours', chose: [], said: 'nine' }],
    }), { reason: 'no_text_allowed', questionId: 'flavours' });
  });

  it('takes typed words instead of a choice where the question allows it', () => {
    /* Somebody who writes their own answer has said the listed ones did not
       fit — so the words stand in for a choice rather than joining one. */
    assert.equal(checkAnswer([MIXINS], {
      responses: [{ questionId: 'mixins', chose: [], said: 'Honeycomb' }],
    }), null);
  });

  it('refuses a half-finished form', () => {
    assert.deepEqual(checkAnswer([FLAVOURS, MIXINS], {
      responses: [{ questionId: 'flavours', chose: ['three'] }],
    }), { reason: 'needs_one', questionId: 'mixins' });
  });

  it('lets an optional question go unanswered', () => {
    assert.equal(checkAnswer([FLAVOURS, { ...NAME, optional: true }], {
      responses: [{ questionId: 'flavours', chose: ['three'] }],
    }), null);
  });

  it('refuses a blank line as an answer to a written question', () => {
    assert.deepEqual(checkAnswer([NAME], {
      responses: [{ questionId: 'name', chose: [], said: '   ' }],
    }), { reason: 'needs_words', questionId: 'name' });
  });
});

describe('verdictOf', () => {
  it('reads a completed form as approval of itself', () => {
    assert.equal(verdictOf([FLAVOURS], {
      responses: [{ questionId: 'flavours', chose: ['three'] }],
    }), 'approved');
  });

  it('lets one option end the whole decision', () => {
    const question = confirmQuestion({ ask: 'Send this?' });
    assert.equal(verdictOf([question], confirmAnswer('rejected')), 'rejected');
    assert.equal(verdictOf([question], confirmAnswer('approved')), 'approved');
  });

  it('rejects as soon as any question was answered with a stop', () => {
    /* A form whose second page says no is a no, however complete the first. */
    const stop: DecisionQuestion = {
      id: 'go',
      ask: 'Proceed?',
      pick: 'one',
      options: [
        { value: 'go', label: 'Go' },
        { value: 'halt', label: 'Halt', settles: 'rejected' },
      ],
    };
    assert.equal(verdictOf([FLAVOURS, stop], {
      responses: [
        { questionId: 'flavours', chose: ['three'] },
        { questionId: 'go', chose: ['halt'] },
      ],
    }), 'rejected');
  });
});

describe('nextQuestion', () => {
  it('walks the questions in the order they were asked', () => {
    const answer = { responses: [{ questionId: 'flavours', chose: ['three'] }] };
    assert.equal(nextQuestion([FLAVOURS, MIXINS, NAME], answer)?.id, 'mixins');
  });

  it('treats an empty response as unanswered', () => {
    /* A card that recorded the question but no choice has not been answered,
       and a pager that believed the response row would skip past it. */
    const answer = { responses: [{ questionId: 'flavours', chose: [], said: '' }] };
    assert.equal(nextQuestion([FLAVOURS, MIXINS], answer)?.id, 'flavours');
  });

  it('is empty once everything has been said', () => {
    assert.equal(nextQuestion([FLAVOURS], {
      responses: [{ questionId: 'flavours', chose: ['five'] }],
    }), null);
  });
});

describe('summarizeAnswer', () => {
  it('reads back the labels a person saw, not the values code matches on', () => {
    assert.equal(summarizeAnswer([FLAVOURS, MIXINS, NAME], {
      responses: [
        { questionId: 'flavours', chose: ['three'] },
        { questionId: 'mixins', chose: ['chips'], said: 'Honeycomb' },
        { questionId: 'name', chose: [], said: 'Sundae' },
      ],
    }), 'Three (core line) · Chocolate chips, Honeycomb · Sundae');
  });
});

describe('answerableWithButtons', () => {
  it('says yes to a stack of single choices', () => {
    assert.equal(answerableWithButtons([FLAVOURS, confirmQuestion({ ask: 'Send?' })]), true);
  });

  it('says no to anything needing a text field or a multi-select', () => {
    /* Both are things a Lark card cannot hold across a redraw, which is why
       this is asked once rather than rediscovered per card builder. */
    assert.equal(answerableWithButtons([MIXINS]), false);
    assert.equal(answerableWithButtons([NAME]), false);
    assert.equal(answerableWithButtons([{ ...FLAVOURS, allowText: true }]), false);
  });
});

describe('isOpen', () => {
  const now = new Date('2026-08-17T15:00:00Z');

  it('is open with no deadline at all', () => {
    assert.equal(isOpen({ expiresAt: null }, now), true);
  });

  it('closes on the deadline rather than after it', () => {
    assert.equal(isOpen({ expiresAt: '2026-08-17T15:00:00Z' }, now), false);
    assert.equal(isOpen({ expiresAt: '2026-08-17T15:00:01Z' }, now), true);
  });

  it('treats an unreadable deadline as no deadline', () => {
    /* Refusing to answer because a stored string is malformed would strand the
       decision with nobody able to close it. */
    assert.equal(isOpen({ expiresAt: 'not a date' }, now), true);
  });
});
