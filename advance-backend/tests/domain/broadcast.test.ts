import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BROADCAST_BODY,
  MAX_BROADCAST_RECIPIENTS,
  describeRefusal,
  estimateSeconds,
  firstName,
  isTerminal,
  normalizeBatchStatus,
  normalizeResultStatus,
  refuseBroadcast,
  renderBody,
  summarizeReach,
  type BroadcastRecipientInput,
} from '../../src/domain/follow-ups/broadcast';

const person = (over: Partial<BroadcastRecipientInput> = {}): BroadcastRecipientInput => ({
  waChatId: '919845010001@c.us',
  displayName: 'Ritu Malhotra',
  isGroup: false,
  cold: false,
  ...over,
});

describe('refuseBroadcast', () => {
  it('allows an ordinary send', () => {
    assert.equal(refuseBroadcast({ recipients: [person()], body: 'Hello' }), null);
  });

  it('refuses an empty recipient list', () => {
    const refusal = refuseBroadcast({ recipients: [], body: 'Hello' });
    assert.equal(refusal?.reason, 'no_recipients');
  });

  it('refuses a body that is only whitespace', () => {
    const refusal = refuseBroadcast({ recipients: [person()], body: '   \n  ' });
    assert.equal(refusal?.reason, 'empty_body');
  });

  it('refuses one recipient over the cap, not at it', () => {
    const at = Array.from({ length: MAX_BROADCAST_RECIPIENTS }, (_, i) =>
      person({ waChatId: `91984501${String(i).padStart(4, '0')}@c.us` }));
    assert.equal(refuseBroadcast({ recipients: at, body: 'Hi' }), null);

    const over = [...at, person({ waChatId: '919999999999@c.us' })];
    const refusal = refuseBroadcast({ recipients: over, body: 'Hi' });
    assert.equal(refusal?.reason, 'too_many');
  });

  /**
   * The gateway collapses exact duplicates silently. Without this the stored
   * total would be one higher than anything the gateway ever reports, and the
   * progress bar would stop a message short of complete forever.
   */
  it('refuses the same chat twice', () => {
    const refusal = refuseBroadcast({
      recipients: [person(), person({ displayName: 'Ritu (mobile)' })],
      body: 'Hi',
    });
    assert.equal(refusal?.reason, 'duplicate_recipient');
    assert.match(describeRefusal(refusal!), /919845010001@c\.us/);
  });

  it('measures the body after trimming, so trailing space cannot tip it over', () => {
    const body = 'x'.repeat(MAX_BROADCAST_BODY) + '   ';
    assert.equal(refuseBroadcast({ recipients: [person()], body }), null);
  });

  it('refuses a body genuinely over the WhatsApp limit', () => {
    const refusal = refuseBroadcast({
      recipients: [person()],
      body: 'x'.repeat(MAX_BROADCAST_BODY + 1),
    });
    assert.equal(refusal?.reason, 'body_too_long');
  });

  it('every refusal renders as a sentence a person can act on', () => {
    const cases = [
      refuseBroadcast({ recipients: [], body: 'Hi' })!,
      refuseBroadcast({ recipients: [person()], body: '' })!,
      refuseBroadcast({ recipients: [person(), person()], body: 'Hi' })!,
    ];
    for (const refusal of cases) {
      const text = describeRefusal(refusal);
      assert.ok(text.length > 10, `too terse: ${text}`);
      assert.ok(/[.!]$/.test(text), `not a sentence: ${text}`);
    }
  });
});

describe('summarizeReach', () => {
  it('counts groups and cold contacts separately', () => {
    const reach = summarizeReach([
      person(),
      person({ waChatId: '1203630@g.us', isGroup: true, displayName: 'Sangeet — Core' }),
      person({ waChatId: '919999999999@c.us', cold: true }),
    ]);
    assert.deepEqual(reach, { recipients: 3, groups: 1, cold: 1 });
  });

  /**
   * There is deliberately no "people reached" total. Group sizes are not
   * something Divo knows — the gateway's group list carries an id and a subject
   * and nothing else — and a plausible guess on that screen is worse than a
   * stated absence.
   */
  it('does not claim to know how many people a group holds', () => {
    const reach = summarizeReach([person({ isGroup: true })]);
    assert.equal('people' in reach, false);
  });

  it('is zero for an empty list rather than throwing', () => {
    assert.deepEqual(summarizeReach([]), { recipients: 0, groups: 0, cold: 0 });
  });
});

describe('renderBody', () => {
  it('substitutes the recipient first name', () => {
    assert.equal(
      renderBody('Hi {{name}}, quick update.', { displayName: 'Ritu Malhotra' }),
      'Hi Ritu, quick update.',
    );
  });

  it('tolerates spacing inside the braces', () => {
    assert.equal(renderBody('Hi {{ name }}!', { displayName: 'Ritu' }), 'Hi Ritu!');
  });

  it('replaces every occurrence, not just the first', () => {
    assert.equal(
      renderBody('{{name}}, {{name}}!', { displayName: 'Ritu' }),
      'Ritu, Ritu!',
    );
  });

  /**
   * The one that bites. A contact saved as `{{name}}` — a joke, or a spoofed
   * group subject — must not have its own substitution expanded again. A naive
   * `replace` with a string containing `$&` would also mangle the output, which
   * is why the replacement is a function.
   */
  it('never rescans the value it just substituted', () => {
    // The name resolves to `{{name}}` (first word of "{{name}} Corp"), and that
    // substituted value is left exactly as it is rather than expanded again.
    assert.equal(
      renderBody('Hi {{name}}', { displayName: '{{name}} Corp' }),
      'Hi {{name}}',
    );
  });

  it('does not treat $& in a name as a regex reference', () => {
    // `$&` means "the matched text" to String.replace. Expanded, this would read
    // "Hi {{name}}"; it must stay the literal the contact is actually called.
    assert.equal(renderBody('Hi {{name}}', { displayName: '$& Traders' }), 'Hi $&');
  });

  it('leaves a template with no placeholder alone', () => {
    assert.equal(renderBody('No variables here.', { displayName: 'Ritu' }), 'No variables here.');
  });
});

describe('firstName', () => {
  it('takes the first word of a person name', () => {
    assert.equal(firstName('Ritu Malhotra'), 'Ritu');
  });

  it('keeps the whole phrase before a dash, for a group', () => {
    assert.equal(firstName('Sharma Sangeet — Core'), 'Sharma Sangeet');
    assert.equal(firstName('Verma Mehendi - Vendors'), 'Verma Mehendi');
  });

  it('falls back to a greeting rather than an empty string', () => {
    assert.equal(firstName('   '), 'there');
    assert.equal(firstName(''), 'there');
  });

  it('does not cut a hyphenated name that has no spacing around the dash', () => {
    assert.equal(firstName('Jean-Pierre Dubois'), 'Jean-Pierre');
  });
});

describe('normalizeBatchStatus', () => {
  /**
   * Pinned verbatim against the gateway's `BatchStatusResponseDto` enum. If the
   * gateway adds a word, this test is where it should be noticed.
   */
  it('maps every documented gateway status', () => {
    assert.equal(normalizeBatchStatus('pending'), 'queued');
    assert.equal(normalizeBatchStatus('processing'), 'sending');
    assert.equal(normalizeBatchStatus('completed'), 'completed');
    assert.equal(normalizeBatchStatus('cancelled'), 'cancelled');
    assert.equal(normalizeBatchStatus('failed'), 'failed');
  });

  it('is case and whitespace insensitive', () => {
    assert.equal(normalizeBatchStatus('  PROCESSING '), 'sending');
  });

  /**
   * Unknown must fail towards terminal, not towards running. A broadcast that is
   * over but reads as running keeps the poller alive forever and leaves a Cancel
   * button on screen that can no longer stop anything.
   */
  it('treats an unrecognised word as failed rather than as still running', () => {
    assert.equal(normalizeBatchStatus('throttled'), 'failed');
    assert.equal(normalizeBatchStatus(''), 'failed');
    assert.equal(normalizeBatchStatus(undefined), 'failed');
    assert.equal(normalizeBatchStatus(null), 'failed');
  });
});

describe('normalizeResultStatus', () => {
  it('maps every documented per-recipient status', () => {
    assert.equal(normalizeResultStatus('pending'), 'pending');
    assert.equal(normalizeResultStatus('sent'), 'sent');
    assert.equal(normalizeResultStatus('failed'), 'failed');
    assert.equal(normalizeResultStatus('cancelled'), 'cancelled');
  });

  /**
   * The opposite default to the batch, and deliberately so. A recipient wrongly
   * shown as delivered is the error somebody acts on — they stop chasing. Left
   * pending, the question stays open and the next poll can still answer it.
   */
  it('treats an unrecognised word as pending, never as sent', () => {
    assert.equal(normalizeResultStatus('delivered'), 'pending');
    assert.equal(normalizeResultStatus(undefined), 'pending');
  });
});

describe('isTerminal', () => {
  it('is true only for states the poller can stop asking about', () => {
    assert.equal(isTerminal('completed'), true);
    assert.equal(isTerminal('cancelled'), true);
    assert.equal(isTerminal('failed'), true);
    assert.equal(isTerminal('queued'), false);
    assert.equal(isTerminal('sending'), false);
  });
});

describe('estimateSeconds', () => {
  it('is zero for a send with nothing to wait between', () => {
    assert.equal(estimateSeconds(0, 3000), 0);
    assert.equal(estimateSeconds(1, 3000), 0);
  });

  it('counts the gaps, not the messages', () => {
    // Four recipients means three waits.
    assert.equal(estimateSeconds(4, 3000, false), 9);
  });

  it('reports the upper end of the jittered range', () => {
    // 3s delay plus up to 2s of jitter, three times.
    assert.equal(estimateSeconds(4, 3000), 15);
  });
});
