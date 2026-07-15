import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GOOGLE_WORKSPACE_SYSTEM_SKILLS,
  provisionGoogleWorkspaceSystemSkills,
} from '../../src/application/skills/google-workspace-system-skills';
import { GOOGLE_WORKSPACE_TOOL_IDS } from '../../src/application/google/google-workspace-mcp-manifest';

describe('Google Workspace system skills', () => {
  it('keeps product skills and gateway tools in exact sync', () => {
    assert.deepEqual(
      GOOGLE_WORKSPACE_SYSTEM_SKILLS.flatMap((skill) => [...skill.toolIds]),
      GOOGLE_WORKSPACE_TOOL_IDS,
    );
    assert.equal(GOOGLE_WORKSPACE_SYSTEM_SKILLS.length, 11);
    for (const skill of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
      assert.match(skill.markdown, /Never use a local Google CLI/);
      assert.doesNotMatch(skill.markdown, /start_google_auth/);
    }
  });

  it('creates and company-grants every focused skill idempotently', async () => {
    const created: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
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
  });
});
