import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GOOGLE_WORKSPACE_SYSTEM_SKILLS,
  provisionGoogleWorkspaceSystemSkills,
} from '../../src/application/skills/google-workspace-system-skills';
import { GOOGLE_WORKSPACE_TOOL_IDS } from '../../src/application/google/google-workspace-mcp-manifest';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from '../../src/application/skills/governed-local-routing';

describe('Google Workspace system skills', () => {
  it('keeps product skills and gateway tools in exact sync', () => {
    assert.deepEqual(
      GOOGLE_WORKSPACE_SYSTEM_SKILLS.flatMap((skill) => [...skill.toolIds]),
      GOOGLE_WORKSPACE_TOOL_IDS,
    );
    assert.equal(GOOGLE_WORKSPACE_SYSTEM_SKILLS.length, 11);
    for (const skill of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
      assert.match(skill.markdown, /Never call Google directly from Bash/);
      assert.match(skill.markdown, /credential-free `divo-local`/);
      assert.match(skill.markdown, new RegExp(GOVERNED_DIRECT_ACTION_CRITERION));
      assert.match(skill.markdown, new RegExp(GOVERNED_LOCAL_WORKFLOW_CRITERION));
      assert.match(skill.markdown, /governed Divo wrapper, not a Google client/);
      assert.doesNotMatch(skill.markdown, /start_google_auth/);
      assert.match(skill.markdown, /OAuth bearer token/);
      assert.match(skill.markdown, /result advisory.*level: "required"/);
      assert.match(skill.markdown, /no Google account is accessible/);
      assert.match(skill.markdown, /loading this skill has not sent a card/);
      assert.match(skill.markdown, /You must invoke `call_tool` exactly once/);
      assert.match(skill.markdown, /google_workspace_authorization_pending/);
      assert.match(skill.markdown, /Never invent a Lark operation/);
      assert.doesNotMatch(skill.markdown, /Divo (injects|derives) user_google_email/);
    }
    const sheets = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find((skill) => skill.slug === 'google-sheets')!;
    assert.match(sheets.markdown, /manage_sheet_data_validation/);
    assert.match(sheets.markdown, /frozen_row_count/);
    assert.match(sheets.markdown, /connectionId.*inside the Google tool's `args`/s);
    assert(sheets.aliases.includes('dropdown'));
  });

  it('gives the six upgraded products complete Divo-native workflows', () => {
    const expectedWorkflows = {
      'google-gmail': [
        'search_gmail_messages',
        'get_gmail_thread_content',
        'draft_gmail_message',
        'After an ambiguous mutation failure',
        'Newsletter cleanup',
        'tools.preflight',
        'googleGmail:create',
        'number of search candidates separately from the number classified as newsletters',
        'Hard bounded latest-thread contract',
        'at most three metadata/search calls',
        'at most one full-content call',
        'page_size`, never `maxResults',
      ],
      'google-drive': [
        'search_drive_files',
        'get_drive_file_content',
        'check_drive_file_public_access',
        'do not blindly create a second copy',
      ],
      'google-calendar': [
        'query_freebusy',
        'manage_event',
        'resolved date and timezone',
        'avoid duplicate meetings',
        'Empty or placeholder event input is not a preflight',
      ],
      'google-docs': [
        'create_doc',
        'batch_update_doc',
        'get_doc_as_markdown',
        'do not create another document blindly',
        'never preflight placeholder content',
      ],
      'google-sheets': [
        'create_spreadsheet',
        'modify_sheet_values',
        'manage_sheet_data_validation',
        'machine-readable `values`',
        '`complete: false`',
        'every required advisory is satisfied',
        'task is partial',
      ],
      'google-contacts': [
        'search_contacts',
        'manage_contacts_batch',
        'Never invent an email address',
        'Do not retry an ambiguous create',
      ],
    } as const;

    for (const [slug, expectedText] of Object.entries(expectedWorkflows)) {
      const skill = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find((candidate) => candidate.slug === slug);
      assert(skill, `missing ${slug}`);
      assert.match(skill.markdown, /### Completion contract/);
      for (const text of expectedText) {
        assert(skill.markdown.includes(text), `${slug} is missing workflow guidance: ${text}`);
      }
    }

    const unchangedProductSlugs = [
      'google-slides',
      'google-forms',
      'google-tasks',
      'google-chat',
      'google-appscript',
    ];
    for (const slug of unchangedProductSlugs) {
      const skill = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find((candidate) => candidate.slug === slug);
      assert(skill, `missing ${slug}`);
      assert.doesNotMatch(skill.markdown, /### Completion contract/);
    }
  });

  it('contains no Hermes-local auth, CLI, or filesystem instructions', () => {
    for (const skill of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
      assert.doesNotMatch(skill.markdown, /gws_bridge|google_api\.py|start_google_auth|GOOGLE_TOKEN|file:\/\/|\/Users\//i);
      assert.match(skill.markdown, /Use only Divo's governed `google[A-Z][A-Za-z]+` route/);
      assert.match(skill.markdown, /Divo RBAC, sharing, approval, and audit/);
    }
  });

  it('creates and company-grants every focused skill idempotently', async () => {
    const created: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const aliases: Record<string, unknown>[] = [];
    const db = {
      skillFolder: { findFirst: async () => null, upsert: async () => ({ id: 'google-folder' }) },
      skill: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, revision: 1, createdBy: null, updatedBy: null };
          created.push(row);
          return row;
        },
        update: async () => { throw new Error('unexpected update'); },
      },
      skillVersion: { upsert: async () => ({}) },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          aliases.push(...data);
          return { count: data.length };
        },
      },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          grants.push(create);
          return create;
        },
      },
    } as any;

    const result = await provisionGoogleWorkspaceSystemSkills(db, 'company-1');
    assert.equal(result.created, 11);
    assert.equal(result.folderId, 'google-folder');
    assert.deepEqual(created.map((skill) => skill.folderId), Array(11).fill('google-folder'));
    assert.deepEqual(grants.map((grant) => grant.granteeType), Array(11).fill('company'));
    assert.deepEqual(grants.map((grant) => grant.granteeId), Array(11).fill('company-1'));
    assert(aliases.some((alias) => alias.alias === 'spreadsheet'));
    assert(aliases.some((alias) => alias.alias === 'dropdown'));
  });
});
