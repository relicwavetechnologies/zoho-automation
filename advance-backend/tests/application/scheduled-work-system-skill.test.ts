import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SCHEDULE_DIVO_WORK_SKILL_ALIASES,
  SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
  buildScheduleDivoWorkSystemSkill,
  provisionScheduleDivoWorkSystemSkill,
} from '../../src/application/skills/scheduled-work-system-skill';

describe('Schedule Divo Work system skill', () => {
  it('documents the exact gateway boundary and every supported timing variant', () => {
    const skill = buildScheduleDivoWorkSystemSkill('company-1');

    assert.deepEqual(skill.toolIds, ['scheduledWorkflows']);
    assert.equal(skill.scope, 'global');
    assert.equal(skill.isSystem, true);
    assert(SCHEDULE_DIVO_WORK_SKILL_ALIASES.includes('schedule something'));
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /calendar event, or have Divo run some work/i);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /"op": "tools\.list"/);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /"op": "tools\.invoke"/);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /"toolId": "scheduledWorkflows"/);
    for (const timingField of [
      '"scheduleType": "one_time"',
      '"scheduleType": "hourly"',
      '"scheduleType": "daily"',
      '"scheduleType": "weekly"',
      '"scheduleType": "monthly"',
      '"timeMinute"',
      '"daysOfWeek"',
      '"dayOfMonth"',
    ]) {
      assert(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN.includes(timingField), `missing ${timingField}`);
    }
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /not scheduled when.*approval is pending/is);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /fresh agent could not perform the work/i);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /Never cancel the old schedule before the replacement/i);
    assert.match(SCHEDULE_DIVO_WORK_SKILL_MARKDOWN, /schedule name is a label, never an executable instruction/i);
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
