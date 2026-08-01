import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONNECTED_PROVIDER_SYSTEM_SKILLS,
} from '../../src/application/skills/connected-provider-system-skills';
import {
  buildDivoProductivitySystemSkill,
  provisionDivoProductivitySystemSkill,
} from '../../src/application/skills/divo-productivity-system-skills';
import {
  provisionSystemSkillRoutes,
  SYSTEM_SKILL_ROUTE_SEEDS,
} from '../../src/application/skills/system-skill-routes';
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
  assertPiHarnessOptions,
  buildHarnessTextMessage,
  isolateHarnessPiThread,
  parseEngineHarnessArgs,
  resolveHarnessRuntimeAddress,
  resolveHarnessOpenId,
  resolveHarnessTenantKey,
  waitForDataExports,
  waitForGoogleOAuthContinuation,
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

  it('preserves a manual router edge when system reconciliation seeds the same pair', async () => {
    const allSlugs = [...new Set(SYSTEM_SKILL_ROUTE_SEEDS.flatMap(
      seed => [seed.routerSlug, ...seed.targetSlugs],
    ))];
    const skills = new Map(allSlugs.map(slug => [slug, {
      id: `skill:${slug}`,
      companyId: 'company-1',
      departmentId: null,
      folderId: 'folder-1',
      scope: 'global',
      name: slug,
      slug,
      summary: '',
      markdown: '',
      toolIds: [],
      tags: [],
      status: 'active',
      isSystem: true,
      sortOrder: 0,
      revision: 1,
      createdBy: null,
      updatedBy: null,
      aliases: [],
    }]));
    const aliases = new Map<string, string[]>();
    const routes = new Map<string, { source: string; sortOrder: number }>([[
      'skill:airtable-router|skill:airtable-core',
      { source: 'manual', sortOrder: 99 },
    ]]);
    const db = {
      skillFolder: { findFirst: async () => ({ id: 'folder-1' }) },
      skill: {
        findFirst: async ({ where }: any) => {
          const row = skills.get(where.slug);
          return row
            ? { ...row, aliases: (aliases.get(row.id) ?? []).map(alias => ({ alias })) }
            : null;
        },
        findMany: async ({ where }: any) =>
          where.slug.in.flatMap((slug: string) => {
            const row = skills.get(slug);
            return row ? [{ id: row.id, slug: row.slug }] : [];
          }),
        update: async ({ where, data }: any) => {
          const row = [...skills.values()].find(candidate => candidate.id === where.id)!;
          const next = {
            ...row,
            ...data,
            revision: row.revision + 1,
            aliases: (aliases.get(row.id) ?? []).map(alias => ({ alias })),
          };
          skills.set(row.slug, next);
          return next;
        },
      },
      skillVersion: { upsert: async () => ({}) },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: { upsert: async () => ({}) },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => {
          if (data[0]) aliases.set(data[0].skillId, data.map((row: any) => row.alias).sort());
          return { count: data.length };
        },
      },
      skillRoute: {
        deleteMany: async ({ where }: any) => {
          let count = 0;
          for (const [key, route] of routes) {
            const [routerSkillId, targetSkillId] = key.split('|');
            if (
              routerSkillId === where.routerSkillId
              && route.source === where.source
              && (!where.targetSkillId?.notIn || !where.targetSkillId.notIn.includes(targetSkillId))
            ) {
              routes.delete(key);
              count += 1;
            }
          }
          return { count };
        },
        updateMany: async ({ where, data }: any) => {
          const key = `${where.routerSkillId}|${where.targetSkillId}`;
          const route = routes.get(key);
          if (!route || route.source !== where.source) return { count: 0 };
          routes.set(key, { ...route, ...data });
          return { count: 1 };
        },
        createMany: async ({ data }: any) => {
          let count = 0;
          for (const route of data) {
            const key = `${route.routerSkillId}|${route.targetSkillId}`;
            if (routes.has(key)) continue;
            routes.set(key, { source: route.source, sortOrder: route.sortOrder });
            count += 1;
          }
          return { count };
        },
      },
    } as never;

    await provisionSystemSkillRoutes(db, 'company-1');
    await provisionSystemSkillRoutes(db, 'company-1');

    assert.deepEqual(routes.get('skill:airtable-router|skill:airtable-core'), {
      source: 'manual',
      sortOrder: 99,
    });
  });
});

describe('Lark engine harness controls', () => {
  it('keeps fresh Pi isolation separate from the real Lark delivery address', () => {
    assert.deepEqual(
      resolveHarnessRuntimeAddress('oc_real_chat', 'om_request', true),
      {
        chatId: 'oc_real_chat',
        freshThreadId: 'harness_fresh_om_request',
      },
    );
    assert.deepEqual(
      resolveHarnessRuntimeAddress('oc_real_chat', 'om_request', false),
      { chatId: 'oc_real_chat' },
    );
  });

  it('overrides only the Pi thread for a fresh delivered run', async () => {
    let received: Record<string, unknown> | undefined;
    const runtime = {
      run: async (input: Record<string, unknown>) => {
        received = input;
        return { text: 'ok' };
      },
    };

    const isolated = isolateHarnessPiThread(runtime as never, 'harness_fresh_om_request');
    await isolated.run({
      threadId: 'oc_real_chat',
      incoming: { chatId: 'oc_real_chat' },
    } as never);

    assert.equal(received?.threadId, 'harness_fresh_om_request');
    assert.deepEqual(received?.incoming, { chatId: 'oc_real_chat' });
  });

  it('defaults to Abhishek and accepts an explicit principal and destination', () => {
    const defaults = parseEngineHarnessArgs([], {});
    assert.doesNotThrow(() => assertPiHarnessOptions(defaults));
    assert.equal(defaults.userSelector, 'abhishek@emiactech.com');
    assert.equal(defaults.backendUrl, 'http://127.0.0.1:8000');
    assert.equal(defaults.chatId, 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50');
    assert.equal(defaults.model, undefined);
    assert.equal(defaults.trace, true);
    assert.equal(defaults.freshContext, false);
    assert.equal(defaults.oauthE2e, false);
    assert.equal(defaults.deliverToLark, true);
    assert.equal(defaults.groupReplyMode, 'threaded');
    assert.equal(defaults.threadRootMessageId, undefined);
    assert.deepEqual(
      parseEngineHarnessArgs([
        '--model', 'luna',
        '--allow-impersonation',
        '--user', 'Anish Suman',
        '--backend-url', 'http://127.0.0.1:9000/',
        '--chat-id', 'oc_custom',
        '--chat-type', 'group',
        '--group-mode', 'inline',
        '--fresh-context',
        'list', 'Airtable', 'bases',
      ], { HARNESS_LARK_ALLOWED_CHAT_IDS: 'oc_custom' }),
      {
        userSelector: 'Anish Suman',
        backendUrl: 'http://127.0.0.1:9000',
        chatId: 'oc_custom',
        chatType: 'group',
        groupReplyMode: 'inline',
        model: 'luna',
        prompt: 'list Airtable bases',
        debugSigs: false,
        trace: true,
        fullDebug: false,
        freshContext: true,
        allowImpersonation: true,
        oauthE2e: false,
        deliverToLark: true,
        help: false,
      },
    );
  });

  it('accepts current cloud Pi models and rejects legacy engine-only options', () => {
    assert.doesNotThrow(() => assertPiHarnessOptions(parseEngineHarnessArgs(['--model', 'flash'], {})));
    assert.doesNotThrow(() => assertPiHarnessOptions(parseEngineHarnessArgs(['--model', 'pro'], {})));
    assert.doesNotThrow(() => assertPiHarnessOptions(parseEngineHarnessArgs(['--model', 'luna'], {})));
    assert.throws(
      () => assertPiHarnessOptions(parseEngineHarnessArgs(['--debug-sigs'], {})),
      /retired Gemini harness/,
    );
    assert.throws(
      () => assertPiHarnessOptions(parseEngineHarnessArgs(['--full-debug'], {})),
      /retired AI SDK harness/,
    );
    assert.throws(
      () => assertPiHarnessOptions(parseEngineHarnessArgs(['--oauth-e2e'], {})),
      /not supported by the direct cloud Pi harness/,
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
      /flash, pro, or luna/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--backend-url', 'not-a-url'], {}),
      /absolute HTTP\(S\) URL/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--group-mode', 'sideways'], {}),
      /threaded or inline/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--thread-root', 'om_root'], {}),
      /requires a group chat/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--group', '--group-mode', 'inline', '--thread-root', 'om_root'], {}),
      /requires --group-mode threaded/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--group', '--fresh-context', '--thread-root', 'om_root'], {}),
      /cannot be combined with --fresh-context/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--group', '--oauth-e2e'], {}),
      /requires a p2p Lark chat/,
    );
    assert.equal(
      parseEngineHarnessArgs(['--oauth-e2e'], {}).oauthE2e,
      true,
    );
    assert.equal(
      parseEngineHarnessArgs(['--no-delivery'], {}).deliverToLark,
      false,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--no-delivery', '--oauth-e2e'], {}),
      /cannot be combined/,
    );
    assert.throws(
      () => parseEngineHarnessArgs(['--no-delivery', '--group'], {}),
      /supports p2p/,
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
    assert.equal(
      parseEngineHarnessArgs(['--group', '--thread-root', 'om_root'], {}).threadRootMessageId,
      'om_root',
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

  it('binds a harness identity to exactly one Lark tenant', async () => {
    const tenantKey = await resolveHarnessTenantKey({ channelIdentity: {
      findMany: async () => [{ externalTenantId: 'tenant-1' }],
    } }, 'company-1', 'ou_user');
    assert.equal(tenantKey, 'tenant-1');

    await assert.rejects(
      resolveHarnessTenantKey({ channelIdentity: {
        findMany: async () => [],
      } }, 'company-1', 'ou_user'),
      /Expected one Lark tenant/,
    );
  });

  it('serializes Lark text messages using the adapter wire format', () => {
    const message = JSON.parse(buildHarnessTextMessage('hello'));
    assert.equal(message.msg_type, 'text');
    assert.deepEqual(JSON.parse(message.content), { text: 'hello' });
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

  it('monitors OAuth through one fresh continuation without holding the first run', async () => {
    let reads = 0;
    let clock = 0;
    const progress: string[] = [];
    const result = await waitForGoogleOAuthContinuation({
      connectionAuthorizationIntent: {
        findFirst: async () => {
          reads += 1;
          if (reads === 1) return null;
          if (reads === 2) {
            return {
              id: 'intent-1',
              status: 'pending',
              continuationStatus: 'blocked',
              continuationRunId: null,
              failureCode: null,
            };
          }
          return {
            id: 'intent-1',
            status: 'connected',
            continuationStatus: 'completed',
            continuationRunId: 'continuation-request-1',
            failureCode: null,
          };
        },
      },
    }, {
      companyId: 'company-1',
      userId: 'user-1',
      originalMessageId: 'om_original',
    }, {
      timeoutMs: 10_000,
      pollMs: 100,
      now: () => clock,
      sleep: async ms => {
        clock += ms;
      },
      onProgress: message => progress.push(message),
    });

    assert.deepEqual(result, {
      intentId: 'intent-1',
      continuationRunId: 'continuation-request-1',
    });
    assert.equal(reads, 3);
    assert.match(progress[0] ?? '', /authorization=pending/);
    assert.match(progress[1] ?? '', /continuation=completed/);
  });
});
