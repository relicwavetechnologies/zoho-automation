/**
 * One member, one answer, whichever surface they ask from.
 *
 * The browser and Divo-in-Lark used to decide this separately and disagree. The
 * tool asked for the operation's own action group *and* background `execute`
 * for anything that leaves a rule running; the web routes asked for `execute`
 * alone on create and update, and asked nothing at all for pause, resume and
 * archive. The consequences were not symmetrical curiosities:
 *
 *   - a member holding `execute` but not `create` was refused in Lark and
 *     allowed in a browser, and
 *   - a member whose access had been revoked entirely could still resume a
 *     paused rule from a browser, after which it went on acting on their mail.
 *
 * Both paths now call `mailRulePermission`, so the parity is structural. These
 * tests exist to keep it that way, and to pin the two asymmetries that are
 * deliberate rather than accidental.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mailRuleActionGroup,
  mailRulePermission,
  type MailRuleOperation,
} from '../../src/application/mail-ops/mail-rule-permission.ts';
import { createMailAutomationsTool } from '../../src/application/tools/families/mail-automations.tool.ts';

const grants = (...actions: string[]) => new Set(actions);

const OPERATIONS: MailRuleOperation[] = [
  'list', 'test', 'create', 'update', 'pause', 'resume', 'archive',
];

describe('who may change a mail rule', () => {
  it('needs the action group and background execute to make a rule live', () => {
    for (const operation of ['create', 'update', 'resume'] as const) {
      const group = mailRuleActionGroup(operation);
      assert.deepEqual(
        mailRulePermission(operation, grants(group, 'execute')),
        { allowed: true },
        `${operation} with both should be allowed`,
      );
      // The half that used to be skipped in a browser.
      assert.deepEqual(
        mailRulePermission(operation, grants('execute')),
        { allowed: false, missing: 'action' },
        `${operation} without ${group} must be refused`,
      );
      // The half the browser skipped for resume specifically.
      assert.deepEqual(
        mailRulePermission(operation, grants(group)),
        { allowed: false, missing: 'execute' },
        `${operation} without execute must be refused`,
      );
    }
  });

  /*
   * Taking a rule out of service is never gated on the right to put one in.
   *
   * Somebody whose `execute` was revoked precisely because their rules were
   * misbehaving must still be able to stop and archive them.
   */
  it('does not ask for execute to stop or archive a rule', () => {
    assert.deepEqual(mailRulePermission('pause', grants('update')), { allowed: true });
    assert.deepEqual(mailRulePermission('archive', grants('delete')), { allowed: true });
  });

  /*
   * Stopping a rule must never be harder than deleting it. `pause` shares the
   * `update` group with editing, so a department that revoked `update` to stop
   * members rewriting rules would otherwise have taken away their ability to
   * stop a live one.
   */
  it('lets delete alone pause a rule', () => {
    assert.deepEqual(mailRulePermission('pause', grants('delete')), { allowed: true });
    assert.deepEqual(mailRulePermission('pause', grants('read')), {
      allowed: false, missing: 'action',
    });
  });

  it('reads a rule and dry-runs it on read alone', () => {
    assert.deepEqual(mailRulePermission('list', grants('read')), { allowed: true });
    // The member who most needs to check a rule is the one whose edit rights
    // were just taken away, so `test` must not be gated behind `update`.
    assert.deepEqual(mailRulePermission('test', grants('read')), { allowed: true });
  });

  it('refuses everything when nothing was granted', () => {
    for (const operation of OPERATIONS) {
      assert.equal(
        mailRulePermission(operation, undefined).allowed,
        false,
        `${operation} must be refused with no grants at all`,
      );
    }
  });

  it('names which half is missing, so the refusal can be acted on', () => {
    // Telling somebody they cannot create when what they lack is background
    // execute sends them asking for access they already have.
    assert.deepEqual(
      mailRulePermission('create', grants('create')),
      { allowed: false, missing: 'execute' },
    );
    assert.deepEqual(
      mailRulePermission('create', grants('execute')),
      { allowed: false, missing: 'action' },
    );
  });
});

/**
 * The agent path and the shared decision cannot drift.
 *
 * `permissionCheck` is what Divo-in-Lark runs; if it ever stops delegating,
 * this fails rather than the two quietly diverging again.
 */
describe('the agent asks the same question', () => {
  const tool = createMailAutomationsTool({} as never);

  const GRANT_SETS = [
    [],
    ['read'],
    ['execute'],
    ['create'],
    ['create', 'execute'],
    ['update'],
    ['update', 'execute'],
    ['delete'],
    ['delete', 'execute'],
    ['read', 'create', 'update', 'delete', 'execute'],
  ];

  it('agrees with mailRulePermission for every operation and grant set', () => {
    for (const operation of OPERATIONS) {
      for (const set of GRANT_SETS) {
        const granted = grants(...set);
        const expected = mailRulePermission(operation, granted).allowed;
        const actual = tool.permissionCheck!(
          { operation } as never,
          {
            allowedActionsByTool: new Map([['mailAutomations', granted]]),
          } as never,
        ).ok;
        assert.equal(
          actual,
          expected,
          `${operation} with [${set.join(', ')}] — tool said ${actual}, shared said ${expected}`,
        );
      }
    }
  });
});
