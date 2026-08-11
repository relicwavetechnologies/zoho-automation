import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GOOGLE_WORKSPACE_SYSTEM_SKILLS,
  provisionGoogleWorkspaceSystemSkills,
} from '../../src/application/skills/google-workspace-system-skills';
import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_TOOL_IDS,
} from '../../src/application/google/google-workspace-mcp-manifest';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from '../../src/application/skills/governed-local-routing';

const sheetsSkill = () => {
  const skill = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find(entry => entry.slug === 'google-sheets');
  assert.ok(skill, 'google-sheets skill must exist');
  return skill!.markdown;
};

/*
 * The Office-file recovery from the live 2026-08-08 incident is owned by
 * `withRecoveryHint`, which appends it to Google's own refusal, and is asserted
 * in tests/tools/google-workspace-office-file.test.ts — every claim the skill
 * used to make about it, plus that the provider's wording survives.
 *
 * It was stated in both places. The error-attached copy is strictly stronger:
 * skill prose is advisory and reaches the model only if the skill was read,
 * while the hint arrives fastened to the thing that went wrong. So the skill
 * copy is gone, and this guards it from drifting back and diverging from the
 * message members actually see.
 */
describe('google-sheets Office-file recovery', () => {
  it('leaves the recovery to the failure that triggers it', () => {
    assert.doesNotMatch(sheetsSkill(), /must not be an Office file/);
  });
});

describe('Google Workspace system skills', () => {
  // After deploy, run `pnpm tsx scripts/reconcile-capabilities.ts` on each environment
  // so provisioned Skill.markdown rows match these source definitions.
  it('keeps product skills and gateway tools in exact sync', () => {
    assert.deepEqual(
      GOOGLE_WORKSPACE_SYSTEM_SKILLS.flatMap((skill) => [...skill.toolIds]),
      GOOGLE_WORKSPACE_TOOL_IDS,
    );
    assert.equal(GOOGLE_WORKSPACE_SYSTEM_SKILLS.length, 11);
    assert.match(GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance, /OAuth bearer token/);
    assert.match(GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance, /never send identity fields such as user_google_email/);
    for (const skill of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
      assert.match(skill.markdown, /Never call Google directly from Bash/);
      assert.match(skill.markdown, /credential-free `divo-local`/);
      assert.match(skill.markdown, new RegExp(GOVERNED_DIRECT_ACTION_CRITERION));
      assert.match(skill.markdown, new RegExp(GOVERNED_LOCAL_WORKFLOW_CRITERION));
      assert.match(skill.markdown, /governed Divo wrapper, not a Google client/);
      assert.doesNotMatch(skill.markdown, /start_google_auth/);
      /*
       * The auth contract — OAuth bearer token, never send user_google_email,
       * no sidecar-local paths in native input — is one constant,
       * GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance. Every product skill
       * pasted it as a numbered step while the googleWorkspace tool already
       * emits the same constant in its `input` parameterDoc, so eleven copies
       * shipped alongside the original. Asserted below against the tool.
       */
      assert.doesNotMatch(skill.markdown, /OAuth bearer token|user_google_email/);
      assert.match(skill.markdown, /result advisory.*level: "required"/);
      assert.match(skill.markdown, /If no account is eligible/);
      assert.match(skill.markdown, /invoke the registered Divo .* capability exactly once/i);
      assert.match(skill.markdown, /Do not call `divo_connections` before ordinary Google work/);
      assert.match(skill.markdown, /Omit `connectionId` unless/);
      assert.doesNotMatch(skill.markdown, /`call_tool`|`divo_gateway`/);
      // One describe, on whichever path the work is running. Doing it through
      // the registered tool and again inside the script pays for it twice.
      assert.match(skill.markdown, /Never describe through the registered tool and then repeat the describe inside the script/);
      assert.match(skill.markdown, /google_workspace_authorization_pending/);
      assert.doesNotMatch(skill.markdown, /Divo (injects|derives) user_google_email/);
    }
    const sheets = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find((skill) => skill.slug === 'google-sheets')!;
    assert.match(sheets.markdown, /manage_sheet_data_validation/);
    assert.match(sheets.markdown, /frozen_row_count/);
    assert.match(sheets.markdown, /Include `connectionId` only after an explicit account choice/);
    // A write that acknowledges without `updatedRows` must not become a
    // zero-row claim. Matched on the concept, not the sentence.
    assert.match(sheets.markdown, /acknowledgement under `data\.result`/);
    assert.match(sheets.markdown, /the exact read-back matches/);
    assert.match(sheets.markdown, /missing `updatedRows` field into a zero-row claim/i);
    assert.match(sheets.markdown, /`get_spreadsheet_info` returns machine-readable `spreadsheetId`/);
    assert.match(sheets.markdown, /Never parse or inspect its compatibility prose in\s+`data\.result`/);
    assert.match(sheets.markdown, /derive an explicit A1 range\s+from the widest row/s);
    assert.match(sheets.markdown, /resize before writing when the header plus data will not fit/);
    assert.match(sheets.markdown, /custom number-format pattern with its required number-format type/);
    assert.match(sheets.markdown, /displayed numbers with grouping separators/);
    assert(sheets.aliases.includes('dropdown'));
    assert(sheets.aliases.includes('google sheet url'));
    assert(sheets.aliases.includes('drive.google.com/file'));
    assert(sheets.aliases.includes('convert excel to google sheet'));
  });

  it('resolves pasted Sheet URLs into an opaque governed read/write handle', () => {
    const sheets = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find((skill) => skill.slug === 'google-sheets')!;

    // What the skill must decide: resolve before searching the web, and never
    // reach past the resolver to the URL's own ID. The `op` values, the
    // `destinationReferenceId` handoff, and which run may use it are stated by
    // the googleSheets tool's parameterDocs.
    assert.match(sheets.markdown, /Before generic web search or any native Sheets\s+operation/s);
    assert.match(sheets.markdown, /`resolve_reference`/);
    assert.match(sheets.markdown, /never derive an ID\s+from the URL yourself/s);
    assert.match(sheets.markdown, /import_to_google_sheets` directly/);
    /*
     * These JSON blocks were `{"toolId": "googleSheets", "args": {...}}` — the
     * divo_gateway envelope, deleted when contracts became typed tools. The
     * skill was still teaching it, and this test was holding it in place.
     */
    assert.doesNotMatch(sheets.markdown, /"toolId":\s*"googleSheets"/);
    /*
     * Anchored to the sentence that carries the claim, not to both channel
     * names in any order. On Lark the dispatcher replaces the resolver
     * response with `{status, destinationReferenceId}` and `data.resource`
     * never exists, so prose crediting Lark with those handles would send the
     * model hunting for an absent field and then back to deriving the
     * spreadsheet ID from the URL — the exact failure this paragraph prevents.
     * The negative guard is the real test: a channel inversion passes the
     * positive one.
     */
    assert.match(sheets.markdown, /On Desktop, keep the governed\s+`data\.resource\.resourceId`/s);
    assert.doesNotMatch(
      sheets.markdown,
      /In Lark(?:(?!On Desktop)[\s\S])*?keep the governed `data\.resource/,
    );
    // How the backend picks between eligible accounts is stated by the tool's
    // own connectionId parameterDoc. What stays here is the wasted-call rule
    // and the one-question ceiling, which no contract expresses.
    assert.match(sheets.markdown, /Never spend a resolver call rediscovering an account/);
    assert.match(sheets.markdown, /ask once, then retry the\s+same URL/s);
    assert.match(sheets.markdown, /resolves metadata and access only/);
    assert.match(sheets.markdown, /drive\.google\.com\/file\/d/);
    assert.match(sheets.markdown, /request a download URL/);
    assert.match(sheets.markdown, /import_to_google_sheets` directly/);
    assert.match(sheets.markdown, /backend\s+delivers the confirmation card and owns the conversion/s);
    // Replacing an existing tab: bound the inspection, persist before mutating,
    // and reuse that file on a retry instead of refetching the provider.
    assert.match(sheets.markdown, /inspect the header plus the final populated row once/);
    assert.match(sheets.markdown, /[Cc]lear any stale tail beyond the\s+new final row/s);
    assert.match(sheets.markdown, /persist\s+it before the first mutation/s);
    assert.match(sheets.markdown, /reuses that\s+saved file instead of refetching/s);
    /*
     * `suggestedProductOperations` binds format_sheet_range and
     * resize_sheet_dimensions as native contracts before inference, so their
     * argument shapes are not restated. It has no branch that ever emits
     * manage_sheet_data_validation and no keyword for "dropdown" — yet
     * "dropdown" is a registered alias of this skill, so that one shape is
     * written out rather than costing a describe round trip on a request the
     * aliases actively invite.
     */
    assert.doesNotMatch(sheets.markdown, /"column_sizes":|"nativeTool":"format_sheet_range"/);
    assert.match(sheets.markdown, /"action":"set","ranges":\["Sheet1!D2:D100"\]/);
    assert.match(sheets.markdown, /never nest formatting under `cell_format`/i);
    assert.match(sheets.markdown, /report that feature partial instead of\s+claiming it was applied/s);
    assert.match(sheets.markdown, /failed,\s+rate-limited, incomplete, or missing read-back cannot be replaced/s);
  });

  it('gives the six upgraded products complete Divo-native workflows', () => {
    const expectedWorkflows = {
      'google-gmail': [
        'search_gmail_messages',
        'get_gmail_thread_content',
        'draft_gmail_message',
        'After an ambiguous mutation failure',
        'Newsletter cleanup',
        // Not `tools.preflight` — that is the internal gateway op. Pi exposes
        // it to the model as the typed tool `divo_preflight`.
        'divo_preflight',
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
        'Pasted Google workbook URL (read-only)',
        'Never answer from an earlier Menhood',
      ],
      'google-calendar': [
        'query_freebusy',
        'manage_event',
        'resolved date and timezone',
        'avoid duplicate meetings',
        // `divo_preflight` states in its own promptGuidelines that a
        // placeholder input validates nothing; the skill keeps the part that
        // is specific to calendar — build the complete event first.
        'pass that exact invocation to `divo_preflight`',
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
