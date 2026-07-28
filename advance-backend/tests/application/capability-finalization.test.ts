import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONNECTED_PROVIDER_SYSTEM_SKILLS,
} from '../../src/application/skills/connected-provider-system-skills';
import {
  buildDivoProductivitySystemSkill,
  provisionDivoProductivitySystemSkill,
} from '../../src/application/skills/divo-productivity-system-skills';
import { connectionProvidersForToolIds } from '../../src/application/gateway/work-bootstrap.service';
import {
  CANONICAL_TOOL_IDS,
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  TOOL_FAMILY_MAP,
  isCanonicalToolId,
  toolIdsForFamily,
} from '../../src/domain/tools/tool-id';
import {
  parseEngineHarnessArgs,
  resolveHarnessOpenId,
  waitForDataExports,
} from '../../scripts/run-engine-harness';
import {
  REGISTERED_TOOL_SEEDS,
  seedRegisteredTools,
} from '../../scripts/seed-registered-tools';
import { provisionConnectedProviderSkillsForExistingCompanies } from '../../scripts/reconcile-capabilities';

describe('capability catalogue reconciliation', () => {
  it('derives every connection-backed tool from the central family taxonomy', () => {
    for (const family of TOOL_FAMILY_IDS) {
      const definition = TOOL_FAMILY_DEFINITIONS[family];
      const expected = definition.connectionProvider ? [definition.connectionProvider] : [];
      assert.deepEqual(connectionProvidersForToolIds(toolIdsForFamily(family)), expected);
    }
    assert.deepEqual(connectionProvidersForToolIds(['unknown-tool']), []);
  });

  it('has one catalogue seed for every canonical governed tool', () => {
    const seededIds = REGISTERED_TOOL_SEEDS.map(seed => seed.toolId);
    assert.equal(new Set(seededIds).size, seededIds.length);
    assert.deepEqual(CANONICAL_TOOL_IDS.filter(toolId => !seededIds.includes(toolId)), []);
    assert.deepEqual(seededIds.filter(toolId => !isCanonicalToolId(toolId)), ['runCommand']);
  });

  it('creates only missing catalogue rows and preserves existing rows', async () => {
    let received: { data: Array<Record<string, unknown>>; skipDuplicates: boolean } | undefined;
    const result = await seedRegisteredTools({
      registeredTool: {
        createMany: async (input: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => {
          received = input;
          return { count: REGISTERED_TOOL_SEEDS.length - 1 };
        },
      },
    } as never);

    assert.equal(result.skipped, 1);
    assert.equal(result.created, REGISTERED_TOOL_SEEDS.length - 1);
    assert.equal(received?.skipDuplicates, true);
    assert.deepEqual(received?.data.map(row => row.toolId), REGISTERED_TOOL_SEEDS.map(seed => seed.toolId));
  });

  it('keeps connected-provider recipes on canonical tools in the matching family', () => {
    for (const skill of CONNECTED_PROVIDER_SYSTEM_SKILLS) {
      const family = skill.slug.startsWith('aitable-') ? 'aitable' : 'airtable';
      assert(skill.toolIds.length > 0);
      assert(skill.toolIds.some(toolId => (
        isCanonicalToolId(toolId) && TOOL_FAMILY_MAP[toolId] === family
      )));
      for (const toolId of skill.toolIds) {
        assert.equal(isCanonicalToolId(toolId), true);
      }
    }
  });

  it('reconciles provider recipes for every existing company', async () => {
    const skills = new Map<string, Record<string, unknown>>();
    const aliases = new Map<string, string[]>();
    let folder: { id: string } | null = null;
    const db = {
      company: { findMany: async () => [{ id: 'company-1' }] },
      skillFolder: {
        findFirst: async () => folder,
        upsert: async ({ create }: { create: { id: string } }) => (folder = { id: create.id }),
      },
      skill: {
        findFirst: async ({ where }: { where: { slug: string } }) => {
          const skill = skills.get(where.slug);
          return skill ? { ...skill, aliases: (aliases.get(String(skill.id)) ?? []).map(alias => ({ alias })) } : null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const skill = { ...data, revision: 1, createdBy: null, updatedBy: null, aliases: [] };
          skills.set(String(skill.slug), skill);
          return skill;
        },
        update: async () => { throw new Error('unexpected update'); },
      },
      skillVersion: { upsert: async () => ({}) },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: { upsert: async () => ({}) },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: Array<{ skillId: string; alias: string }> }) => {
          if (data[0]) aliases.set(data[0].skillId, data.map(row => row.alias).sort());
          return { count: data.length };
        },
      },
    } as never;

    const first = await provisionConnectedProviderSkillsForExistingCompanies(db);
    const second = await provisionConnectedProviderSkillsForExistingCompanies(db);

    assert.deepEqual(first, {
      companies: 1,
      created: CONNECTED_PROVIDER_SYSTEM_SKILLS.length,
      updated: 0,
      existing: 0,
      skipped: 0,
    });
    assert.deepEqual(second, {
      companies: 1,
      created: 0,
      updated: 0,
      existing: CONNECTED_PROVIDER_SYSTEM_SKILLS.length,
      skipped: 0,
    });
  });

  it('re-reads a system skill won by a concurrent deterministic-ID insert', async () => {
    const definition = CONNECTED_PROVIDER_SYSTEM_SKILLS[0]!;
    const folderId = 'folder-1';
    const winner = {
      ...buildDivoProductivitySystemSkill('company-1', folderId, definition),
      revision: 1,
      createdBy: null,
      updatedBy: null,
      aliases: [...definition.aliases].sort().map(alias => ({ alias })),
    };
    let finds = 0;
    const result = await provisionDivoProductivitySystemSkill({
      skillFolder: { findFirst: async () => ({ id: folderId }) },
      skill: {
        findFirst: async () => (++finds === 1 ? null : winner),
        create: async () => { throw Object.assign(new Error('unique race'), { code: 'P2002' }); },
        update: async () => { throw new Error('unexpected update'); },
      },
      skillVersion: { upsert: async () => { throw new Error('unexpected version'); } },
      skillRegistryRevision: { upsert: async () => { throw new Error('unexpected revision'); } },
      skillAccessGrant: { upsert: async () => ({}) },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: definition.aliases.length }),
      },
    } as never, 'company-1', definition);

    assert.deepEqual(result, { id: winner.id, outcome: 'existing' });
    assert.equal(finds, 2);
  });
});

describe('Lark engine harness controls', () => {
  it('defaults to Abhishek and accepts an explicit principal and destination', () => {
    const defaults = parseEngineHarnessArgs([], {});
    assert.equal(defaults.userSelector, 'abhishek@emiactech.com');
    assert.equal(defaults.chatId, 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50');
    assert.equal(defaults.model, 'flash');
    assert.equal(defaults.trace, true);
    assert.equal(defaults.freshContext, false);
    assert.deepEqual(
      parseEngineHarnessArgs([
        '--model', 'pro',
        '--allow-impersonation',
        '--user', 'Anish Suman',
        '--chat-id', 'oc_custom',
        '--chat-type', 'group',
        '--fresh-context',
        'list', 'Airtable', 'bases',
      ], { HARNESS_LARK_ALLOWED_CHAT_IDS: 'oc_custom' }),
      {
        userSelector: 'Anish Suman',
        chatId: 'oc_custom',
        chatType: 'group',
        model: 'pro',
        prompt: 'list Airtable bases',
        debugSigs: false,
        trace: true,
        fullDebug: false,
        freshContext: true,
        allowImpersonation: true,
        help: false,
      },
    );
  });

  it('requires explicit impersonation and configured delivery destinations', () => {
    assert.equal(
      parseEngineHarnessArgs([], { HARNESS_LARK_USER: 'Anish Suman' }).userSelector,
      'abhishek@emiactech.com',
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--user', 'Anish Suman'], {}),
      /--allow-impersonation/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--model', 'ultra'], {}),
      /flash or pro/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--chat-id', 'oc_untrusted'], {}),
      /HARNESS_LARK_ALLOWED_CHAT_IDS/,
    );
    assert.throws(
      () => parseEngineHarnessArgs([], { HARNESS_LARK_CHAT_ID: 'oc_untrusted' }),
      /HARNESS_LARK_ALLOWED_CHAT_IDS/,
    );
    assert.equal(
      parseEngineHarnessArgs(['--group'], {
        HARNESS_LARK_CHAT_ID: 'oc_allowed_dm',
        HARNESS_LARK_ALLOWED_CHAT_IDS: 'oc_allowed_dm',
      }).chatId,
      'oc_b9169aab0765f46b2fe9147068e3c79f',
    );
  });

  it('resolves DB-linked identities and rejects ambiguous names', async () => {
    const direct = await resolveHarnessOpenId({ channelIdentity: {
      findMany: async () => [{ larkOpenId: 'ou_direct', displayName: null, email: null }],
    } }, 'ou_direct');
    assert.equal(direct, 'ou_direct');

    const linked = await resolveHarnessOpenId({ channelIdentity: {
      findMany: async () => [{ larkOpenId: 'ou_anish', displayName: 'Anish Suman', email: 'anish@example.com' }],
    } }, 'Anish Suman');
    assert.equal(linked, 'ou_anish');

    await assert.rejects(
      resolveHarnessOpenId({ channelIdentity: {
        findMany: async () => [
          { larkOpenId: 'ou_one', displayName: 'Same Name', email: null },
          { larkOpenId: 'ou_two', displayName: 'Same Name', email: null },
        ],
      } }, 'Same Name'),
      /ambiguous/,
    );
  });

  it('extends the export wait while row progress continues and rejects a stalled job', async () => {
    let now = 0;
    let polls = 0;
    const progressingQueue = {
      getJobCounts: async () => (
        ++polls < 5
          ? { waiting: 0, active: 1, delayed: 0 }
          : { waiting: 0, active: 0, delayed: 0 }
      ),
      getJobs: async () => [{ id: 'job-1', progress: { stage: 'reading', rowsRead: polls * 100 } }],
    };
    await waitForDataExports(progressingQueue, {
      inactivityMs: 3,
      pollMs: 2,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      onProgress: () => undefined,
    });
    assert(now > 3, 'total runtime may exceed the inactivity window while progress continues');

    now = 0;
    await assert.rejects(
      () => waitForDataExports({
        getJobCounts: async () => ({ waiting: 0, active: 1, delayed: 0 }),
        getJobs: async () => [{ id: 'job-2', progress: { stage: 'reading', rowsRead: 100 } }],
      }, {
        inactivityMs: 3,
        pollMs: 2,
        now: () => now,
        sleep: async (ms) => { now += ms; },
        onProgress: () => undefined,
      }),
      /no queue or row progress/i,
    );
  });
});
