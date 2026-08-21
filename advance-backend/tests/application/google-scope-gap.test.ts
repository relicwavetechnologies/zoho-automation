import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyGoogleScopeGap,
  googleConnectionScopeGap,
} from '../../src/application/connections/connection-request/google-scope-gap';
import { googleScopeGroupsForToolIds } from '../../src/application/google/google-scope-request';
import {
  createGoogleWorkspaceMcpTools,
  type GoogleWorkspaceMcpPort,
} from '../../src/application/tools/families/google-workspace-mcp.tool';
import { makeAllowedPerm, makeCtx } from '../tools/tool-test.helpers';

describe('Google scope gap classification', () => {
  it('names the groups for Google\'s real insufficient-scope 403 prose', () => {
    const gap = classifyGoogleScopeGap(
      'googleSheets',
      new Error('HttpError 403: Request had insufficient authentication scopes.'),
    );

    assert.deepEqual(gap, {
      provider: 'google_workspace',
      toolId: 'googleSheets',
      missingScopeGroups: googleScopeGroupsForToolIds(['googleSheets']),
      reason: 'insufficient_scope',
    });
  });

  it('recognizes Google\'s machine-readable scope reason without classifying a bare 403', () => {
    const gap = classifyGoogleScopeGap('googleDrive', {
      code: 403,
      status: 'PERMISSION_DENIED',
      details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
    });
    assert.equal(gap?.reason, 'insufficient_scope');
    assert.equal(
      classifyGoogleScopeGap('googleDrive', new Error('HttpError 403: rateLimitExceeded')),
      undefined,
    );
  });

  it('names an absent connection as not_connected', () => {
    const gap = classifyGoogleScopeGap('googleGmail', { code: 'not_connected' });
    assert.equal(gap?.reason, 'not_connected');
    assert.deepEqual(
      googleConnectionScopeGap('googleGmail', 'no_connection'),
      gap,
    );
  });

  it('subtracts scopes already held by the connection', () => {
    const [gmailGroup, ...otherGroups] = googleScopeGroupsForToolIds(['googleGmail']);
    assert.ok(gmailGroup);
    const granted = [gmailGroup[0]!];
    const gap = classifyGoogleScopeGap('googleGmail', {
      reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    }, granted);
    assert.deepEqual(gap?.missingScopeGroups, otherGroups);
  });

  it('leaves quotas, missing files, and native schema rejections alone', () => {
    for (const error of [
      new Error('HttpError 403: quotaExceeded'),
      new Error('HttpError 404: File not found'),
      new Error('1 validation error for call\nfield\nExtra inputs are not permitted'),
    ]) {
      assert.equal(classifyGoogleScopeGap('googleDrive', error), undefined);
    }
  });

  it('turns a classified MCP failure into a permission denial with the skill pointer', async () => {
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async () => null,
      callTool: async () => {
        throw new Error('HttpError 403: Request had insufficient authentication scopes.');
      },
    };
    const drive = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({
        status: 'resolved' as const,
        connection: { client },
      }),
    }).find(tool => tool.id === 'googleDrive')!;

    const permission = drive.permissionCheck(
      { op: 'call', nativeTool: 'list_drive_items', input: {} },
      makeAllowedPerm('googleDrive', ['read']),
    );
    assert.equal(permission.ok, true);
    const result = await drive.execute(
      { op: 'call', nativeTool: 'list_drive_items', input: {} },
      makeCtx('googleDrive', ['read']),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'permission_denied');
    assert.match(result.error.message, /insufficient_scope/);
    assert.match(result.error.message, /connections skill/);
    assert.match(result.error.message, /divo_connect_app/);
  });
});
