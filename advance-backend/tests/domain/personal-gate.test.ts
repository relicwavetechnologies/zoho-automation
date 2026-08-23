import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NO_PERSONAL_GATE,
  normalisePersonalGate,
  parsePersonalGate,
  personalGateFrom,
  personalGateSize,
  personallyGated,
  togglePersonalAction,
} from '../../src/domain/approval/personal-gate';

describe('personallyGated', () => {
  it('matches only the exact tool and action picked', () => {
    const gate = personalGateFrom(false, [['googleGmail', 'send']]);
    assert.equal(personallyGated(gate, 'googleGmail', 'send'), true);
    assert.equal(personallyGated(gate, 'googleGmail', 'create'), false);
    assert.equal(personallyGated(gate, 'googleSheets', 'send'), false);
  });

  it('covers tools nobody has listed when the answer is "everything"', () => {
    /* Why `all` is a mode and not a list built from today's tools: a tool added
       next week has to be covered by a person who said everything, and a list
       enumerated at the time they said it would silently miss it. */
    const gate = personalGateFrom(true, []);
    assert.equal(personallyGated(gate, 'aToolInventedTomorrow', 'create'), true);
  });

  it('never gates a read, whatever was picked', () => {
    assert.equal(personallyGated(personalGateFrom(true, []), 'googleGmail', 'read'), false);
  });

  it('reads an absent gate as no gate rather than throwing', () => {
    assert.equal(personallyGated(null, 'googleGmail', 'send'), false);
    assert.equal(personallyGated(undefined, 'googleGmail', 'send'), false);
    assert.equal(personallyGated(NO_PERSONAL_GATE, 'googleGmail', 'send'), false);
  });
});

describe('personalGateFrom', () => {
  it('merges one tool into one entry and drops repeats', () => {
    const gate = personalGateFrom(false, [
      ['googleGmail', 'send'],
      ['googleGmail', 'create'],
      ['googleGmail', 'send'],
    ]);
    assert.deepEqual(gate.actions, [{ toolId: 'googleGmail', actions: ['create', 'send'] }]);
    assert.equal(personalGateSize(gate), 2);
  });

  it('drops reads on the way in', () => {
    // Storing one would draw a tick that changes nothing, which is worse than
    // no tick at all.
    const gate = personalGateFrom(false, [['googleSheets', 'read'], ['googleSheets', 'update']]);
    assert.deepEqual(gate.actions, [{ toolId: 'googleSheets', actions: ['update'] }]);
  });

  it('drops a tool left with nothing, rather than keeping an empty entry', () => {
    assert.deepEqual(personalGateFrom(false, [['googleSheets', 'read']]).actions, []);
  });

  it('gives the same value for the same choices in any order', () => {
    const a = personalGateFrom(false, [['zohoBooks', 'create'], ['googleGmail', 'send']]);
    const b = personalGateFrom(false, [['googleGmail', 'send'], ['zohoBooks', 'create']]);
    assert.deepEqual(a, b);
  });
});

describe('parsePersonalGate', () => {
  it('reads back what was written', () => {
    const gate = personalGateFrom(false, [['googleGmail', 'send'], ['zohoBooks', 'create']]);
    assert.deepEqual(parsePersonalGate(JSON.parse(JSON.stringify(gate))), gate);
  });

  it('reads anything unusable as no gate', () => {
    /* Total on purpose. This value is read on the path of every gated tool
       call, and a throw here would refuse work over a malformed preference. */
    for (const value of [null, undefined, 42, 'all', [], {}, { all: 'yes' }]) {
      assert.deepEqual(parsePersonalGate(value), NO_PERSONAL_GATE, `on ${JSON.stringify(value)}`);
    }
  });

  it('keeps the good entries and discards the broken ones beside them', () => {
    assert.deepEqual(
      parsePersonalGate({
        all: false,
        actions: [
          { toolId: 'googleGmail', actions: ['send', 7] },
          { toolId: 42, actions: ['send'] },
          { actions: ['send'] },
          'nonsense',
        ],
      }),
      personalGateFrom(false, [['googleGmail', 'send']]),
    );
  });

  it('holds on to "everything" even when the list is empty', () => {
    assert.equal(parsePersonalGate({ all: true, actions: [] }).all, true);
  });
});

describe('togglePersonalAction', () => {
  it('adds what is missing and removes what is there', () => {
    const empty = NO_PERSONAL_GATE;
    const added = togglePersonalAction(empty, 'googleGmail', 'send');
    assert.equal(personallyGated(added, 'googleGmail', 'send'), true);
    const removed = togglePersonalAction(added, 'googleGmail', 'send');
    assert.deepEqual(removed, NO_PERSONAL_GATE);
  });

  it('leaves the other actions on the same tool alone', () => {
    const gate = personalGateFrom(false, [['googleGmail', 'send'], ['googleGmail', 'create']]);
    const next = togglePersonalAction(gate, 'googleGmail', 'send');
    assert.deepEqual(next.actions, [{ toolId: 'googleGmail', actions: ['create'] }]);
  });

  it('does not disturb "everything"', () => {
    // Un-ticking one row while the everything mode is on must not silently
    // switch the mode off, or the row would appear to do something it cannot.
    const gate = togglePersonalAction(personalGateFrom(true, []), 'googleGmail', 'send');
    assert.equal(gate.all, true);
  });
});

describe('normalisePersonalGate', () => {
  it('is what a caller sent, reduced to one arrangement of itself', () => {
    assert.deepEqual(
      normalisePersonalGate({
        all: false,
        actions: [
          { toolId: 'googleGmail', actions: ['send', 'send'] },
          { toolId: 'googleGmail', actions: ['create'] },
          { toolId: ' ', actions: ['send'] },
        ],
      }),
      personalGateFrom(false, [['googleGmail', 'send'], ['googleGmail', 'create']]),
    );
  });
});
