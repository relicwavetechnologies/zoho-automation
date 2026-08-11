import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIVO_LOCAL_PYTHON_SYSTEM_SKILL,
  provisionDivoLocalPythonSystemSkill,
} from '../../src/application/skills/divo-local-python-system-skill.ts';
import {
  CREATE_FILES_SYSTEM_SKILL,
  READ_FILES_SYSTEM_SKILL,
} from '../../src/application/skills/files-and-documents-system-skills.ts';

describe('Divo local Python system skill', () => {
  it('updates the stable system-skill identity to the persistent file workflow', () => {
    assert.equal(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.slug, 'divo-python-automation');
    assert.equal(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.name, 'Divo Local Python Workflows');
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Use the `write` tool once/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /use `edit` on that exact file/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /rerun the exact Bash command/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /credential-free\s+`divo-local`/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /retired `divo_python_automation` tool is unavailable/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /response\["data"\]/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /divo-local call <toolId>\.<nativeTool> --input-file <path>/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /input.*do not put `op`, `nativeTool`, `toolId`,/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /automatically writes.*DIVO_RUN_DIR/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /DIVO_THREAD_WORK_DIR.*workflows/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /\.divo-workflow\.json/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Never resume merely because files exist/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Path\(os\.environ\["DIVO_RUN_DIR"\]\)/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /failed call creates no\s+result file/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /data.*provider\s+result.*Never use `len\(data\)`/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Never guess, copy an old\s+ID/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Do not call `tools\.list`/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /never merge stderr into it with `2>&1`/i);
    assert.doesNotMatch(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /divo-local request --op tools\.list/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /returned == parsed \+ skipped/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /every skip needs a reason/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /divo-local.*owns the.*safe exact retry/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Never add.*sleeps or retry `rate_limited` yourself/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /if the client still returns it.*report the incomplete step/is);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Persist the validated\s+rows to JSONL\/Parquet/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /rerun from that saved source instead of refetching/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /write `status: completed` only afterward/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /earlier write acknowledgement or read from a failed attempt is not proof/i);
    assert.doesNotMatch(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /def run\(input_data, divo\)/i);
  });

  it('keeps local artifact delivery disabled only for Lark', () => {
    for (const markdown of [
      READ_FILES_SYSTEM_SKILL.markdown,
      CREATE_FILES_SYSTEM_SKILL.markdown,
      DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown,
    ]) {
      assert.match(markdown, /In Lark/i);
      assert.match(markdown, /Jan desktop/i);
      assert.doesNotMatch(markdown, /DIVO_ARTIFACTS_DIR` (?:so|instead;).*delivered/i);
    }

    assert.match(READ_FILES_SYSTEM_SKILL.markdown, /complete user-facing result in chat/i);
    assert.match(CREATE_FILES_SYSTEM_SKILL.markdown, /local file delivery is unavailable/i);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /never claim a\s+local path was delivered/i);
  });

  it('replaces an existing legacy system recipe in place', async () => {
    const updated: Record<string, unknown>[] = [];
    const versioned: Record<string, unknown>[] = [];
    const existing = {
      id: 'existing-python-skill',
      companyId: 'company-1',
      departmentId: null,
      folderId: 'divo-productivity-folder',
      scope: 'global',
      name: 'Divo Python Automation',
      slug: DIVO_LOCAL_PYTHON_SYSTEM_SKILL.slug,
      summary: 'Legacy inline Python tool.',
      markdown: 'Call divo_python_automation with def run(input_data, divo).',
      toolIds: ['divo_python_automation'],
      tags: ['python'],
      status: 'active',
      isSystem: true,
      sortOrder: 24,
      revision: 1,
      createdBy: null,
      updatedBy: null,
      aliases: [],
    };
    const db = {
      skillFolder: {
        findFirst: async () => ({ id: 'divo-productivity-folder' }),
      },
      skill: {
        findFirst: async () => existing,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updated.push(data);
          return {
            ...existing,
            ...data,
            toolIds: data.toolIds,
            tags: data.tags,
            revision: 2,
            aliases: [],
          };
        },
      },
      skillVersion: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          versioned.push(create);
          return create;
        },
      },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: { upsert: async () => ({}) },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: DIVO_LOCAL_PYTHON_SYSTEM_SKILL.aliases.length }),
      },
    } as any;

    const result = await provisionDivoLocalPythonSystemSkill(db, 'company-1');

    assert.deepEqual(result, { id: existing.id, outcome: 'updated' });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].name, DIVO_LOCAL_PYTHON_SYSTEM_SKILL.name);
    assert.equal(updated[0].markdown, DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown);
    assert.deepEqual(updated[0].toolIds, []);
    assert.deepEqual(updated[0].revision, { increment: 1 });
    assert.equal(versioned.length, 1);
    assert.equal(versioned[0].skillId, existing.id);
    assert.equal(versioned[0].revision, 2);
    assert.equal(versioned[0].source, 'system');
  });
});
