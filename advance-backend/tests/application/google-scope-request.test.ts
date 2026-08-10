import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  googleScopeGroupsForToolIds,
  googleScopesToRequestForToolIds,
} from '../../src/application/google/google-scope-request';
import { hasGoogleScopeGroups } from '../../src/domain/google/google-workspace-scope';

const has = (scopes: readonly string[], suffix: string) =>
  scopes.some(scope => scope.endsWith(suffix));

describe('googleScopesToRequestForToolIds', () => {
  it('asks a mail rule for mail and for nothing else', () => {
    const scopes = googleScopesToRequestForToolIds(['mailAutomations']);

    assert.equal(has(scopes, '/gmail.modify'), true);
    // Named in its own right: Google's gmail.modify does not carry send, and a
    // forward that cannot send is the failure narrowing would introduce.
    assert.equal(has(scopes, '/gmail.send'), true);
    for (const absent of ['/drive', '/calendar', '/documents', '/spreadsheets', '/presentations', '/script.projects']) {
      assert.equal(has(scopes, absent), false, `should not request ${absent}`);
    }
  });

  it('always carries identity, because the callback keys the connection by address', () => {
    const scopes = googleScopesToRequestForToolIds(['mailAutomations']);
    assert.equal(scopes.includes('openid'), true);
    assert.equal(has(scopes, '/userinfo.email'), true);
  });

  it('requests the narrowest scope in each group rather than the broadest', () => {
    const scopes = googleScopesToRequestForToolIds(['googleDrive']);
    // The read group is [drive.readonly, drive] and the write group is
    // [drive.file, drive]. Taking the last of either would hand over the whole
    // Drive to satisfy a requirement that drive.file already satisfies.
    assert.equal(scopes.includes('https://www.googleapis.com/auth/drive'), false);
    assert.equal(has(scopes, '/drive.file'), true);
  });

  it('returns nothing for a tool it does not know, so the caller keeps the old full set', () => {
    // Identity-only would be worse than the problem: the connection saves, is
    // picked as the member's Google account, then fails every tool.
    assert.deepEqual(googleScopesToRequestForToolIds(['somethingUnmapped']), []);
    assert.deepEqual(googleScopesToRequestForToolIds([]), []);
  });

  it('unions groups across tools without repeating one', () => {
    const groups = googleScopeGroupsForToolIds(['googleDocs', 'googleSheets']);
    const keys = groups.map(group => group.join('|'));
    assert.equal(new Set(keys).size, keys.length, 'a group should appear once');
  });

  it('grants what it asked for — the request satisfies its own callback check', () => {
    // The two sides deadlock if they disagree: the callback may only insist on
    // what the authorize URL actually put in front of the member.
    for (const toolId of ['mailAutomations', 'googleDrive', 'googleCalendar', 'googleSheets']) {
      const requested = googleScopesToRequestForToolIds([toolId]);
      const required = googleScopeGroupsForToolIds([toolId]);
      assert.equal(
        hasGoogleScopeGroups(requested, required),
        true,
        `${toolId} requests scopes its own callback would reject`,
      );
    }
  });
});
