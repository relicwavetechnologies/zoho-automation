import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SCHEDULE_DIVO_WORK_SKILL_ALIASES,
  SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
  buildScheduleDivoWorkSystemSkill,
  provisionScheduleDivoWorkSystemSkill,
} from '../../src/application/skills/scheduled-work-system-skill';
import { createScheduledWorkflowsTool } from '../../src/application/tools/families/scheduled-workflows.tool';

describe('Schedule Divo Work system skill', () => {
  it('teaches the work contract without a call surface the runtime removed', () => {
    const skill = buildScheduleDivoWorkSystemSkill('company-1');

    assert.deepEqual(skill.toolIds, ['scheduledWorkflows']);
    assert.equal(skill.scope, 'company');
    assert.equal(skill.isSystem, true);
    assert(SCHEDULE_DIVO_WORK_SKILL_ALIASES.includes('schedule something'));
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /calendar event, or have Divo run some work/i);
    /*
     * A whole "Required gateway sequence" section told the model the scheduler
     * could be invoked only through `op: "tools.invoke"` wrapping
     * `payload: { toolId, args }`. divo_gateway is deleted, so that was the one
     * documented route to this tool and it could not succeed — and this test
     * asserted the section was present, which is why it survived the sweep.
     */
    assert.doesNotMatch(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /tools\.invoke|tools\.list|payload/);
    /*
     * The five per-variant JSON examples were the timing schema written out
     * five times; scheduledWorkflows states every shape in parameterDocs. One
     * example survives, for the thing no schema can show — what a self-
     * contained intent reads like.
     */
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /"scheduleType": "daily"/);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /Read only; do not reply, archive, label, or forward mail/);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /a fresh agent could run it having seen nothing else/i);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /not scheduled when.*approval is pending/is);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /fresh agent could not perform the work/i);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /Never cancel the old schedule before the replacement/i);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /schedule name is a label, never an executable instruction/i);
  });

  /*
   * The timing variants moved to the tool rather than disappearing: it is the
   * layer the model always has in front of it, and the only one that cannot
   * drift from the schema it is generated beside.
   */
  it('leaves every timing shape to the tool that validates it', () => {
    const docs = createScheduledWorkflowsTool({ prisma: {} as never }).parameterDocs;
    for (const shape of [
      'one_time={runAt}',
      'hourly={intervalHours,minute}',
      'daily={hour,timeMinute}',
      'weekly={daysOfWeek,hour,timeMinute}',
      'monthly={dayOfMonth,hour,timeMinute}',
    ]) {
      assert.ok(docs.includes(shape), `missing ${shape}`);
    }
    assert.doesNotMatch(docs, /tools\.invoke|Gateway invocation|Gateway discovery/);
  });

  it('creates and company-grants the skill with searchable aliases', async () => {
    const grants: Record<string, unknown>[] = [];
    const aliases: Record<string, unknown>[] = [];
    const versions: Record<string, unknown>[] = [];
    const db = {
      skill: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          revision: 1,
          createdBy: null,
          updatedBy: null,
          aliases: [],
        }),
        update: async () => { throw new Error('unexpected update'); },
      },
      skillVersion: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          versions.push(create);
          return create;
        },
      },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          grants.push(create);
          return create;
        },
      },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          aliases.push(...data);
          return { count: data.length };
        },
      },
    } as any;

    const result = await provisionScheduleDivoWorkSystemSkill(db, 'company-1');

    assert.equal(result.outcome, 'created');
    assert.equal(versions.length, 1);
    assert.deepEqual(grants, [{
      companyId: 'company-1',
      skillId: result.id,
      granteeType: 'company',
      granteeId: 'company-1',
    }]);
    assert.deepEqual(
      aliases.map((entry) => entry.alias),
      [...SCHEDULE_DIVO_WORK_SKILL_ALIASES],
    );
  });
});
