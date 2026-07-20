import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDesktopCapabilityBootstrap } from '../../src/application/desktop/desktop-capability-bootstrap.ts';

function permission(tools: Array<[string, string[]]>) {
  return {
    allowedToolIds: new Set(tools.map(([toolId]) => toolId)),
    allowedActionsByTool: new Map(tools.map(([toolId, actions]) => [toolId, new Set(actions)])),
    decisions: [],
    department: { roleSlug: 'FINANCE_ANALYST' },
  } as any;
}

describe('desktop capability bootstrap', () => {
  it('builds compact Finance routing only from visible skills and allowed tools', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Finance',
      departmentSlug: 'finance',
      companyRole: 'MEMBER',
      permission: permission([
        ['zohoBooks', ['read']],
        ['webSearch', ['read']],
      ]),
      visibleSkills: [
        {
          id: 'finance-core-id',
          slug: 'finance-ops-core',
          name: 'Finance Ops Core',
          description: 'Finance summaries.',
          instructions: 'Hidden full recipe.',
          toolIds: ['zohoBooks'],
          aliases: [], tags: [], revision: 2,
        },
        {
          id: 'crm-only-id',
          slug: 'crm-only',
          name: 'CRM Only',
          description: 'CRM workflow.',
          instructions: 'Hidden full recipe.',
          toolIds: ['zohoCrm'],
          aliases: [], tags: [], revision: 1,
        },
        {
          id: 'bill-write-id',
          slug: 'zoho-books-bill',
          name: 'Zoho Books Bill Recording',
          description: 'Create a vendor bill.',
          instructions: 'Hidden full recipe.',
          toolIds: ['zohoBooks'],
          aliases: [], tags: [], revision: 1,
        },
      ],
      registryRevision: 12,
      zohoConnections: [],
    });

    assert.ok(bootstrap);
    assert.deepEqual(bootstrap.preferredSkills.map(skill => skill.id), ['finance-core-id']);
    assert.deepEqual(bootstrap.preferredTools, [
      { toolId: 'zohoBooks', actions: ['read'] },
      { toolId: 'webSearch', actions: ['read'] },
    ]);
    assert.ok(bootstrap.routingHints.some(hint => hint.includes('build_overdue_report')));
    assert.ok(bootstrap.routingHints.some(hint =>
      hint.includes('invoke webSearch directly')
      && hint.includes('do not resolve or search for a research skill first')));
    assert.ok(!bootstrap.routingHints.some(hint => hint.includes('zohoCrm')));
    assert.deepEqual(bootstrap.zohoConnection, { accessibleCount: 0 });
  });

  it('builds a generic RBAC-filtered catalogue without Finance assumptions for another department', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Engineering',
      departmentSlug: 'engineering',
      companyRole: 'MEMBER',
      permission: permission([
        ['zohoBooks', ['read']],
        ['larkMessaging', ['send']],
        ['scheduledWorkflows', ['execute']],
        ['webSearch', ['read']],
      ]),
      visibleSkills: [{
        id: 'engineering-runbook-id',
        slug: 'engineering-runbook',
        name: 'Engineering Runbook',
        description: 'Handle engineering incidents.',
        instructions: 'Hidden full recipe.',
        toolIds: ['zohoBooks'],
        aliases: [], tags: [], revision: 4,
      }],
      registryRevision: 13,
    });

    assert.equal(bootstrap.version, 2);
    assert.equal(bootstrap.departmentFunction, 'general');
    assert.equal(bootstrap.registryRevision, 13);
    assert.deepEqual(bootstrap.availableSkills, [{
      id: 'engineering-runbook-id',
      slug: 'engineering-runbook',
      name: 'Engineering Runbook',
      description: 'Handle engineering incidents.',
      revision: 4,
    }]);
    assert.deepEqual(bootstrap.availableTools, [
      { toolId: 'larkMessaging', actions: ['send'] },
      { toolId: 'scheduledWorkflows', actions: ['execute'] },
      { toolId: 'webSearch', actions: ['read'] },
      { toolId: 'zohoBooks', actions: ['read'] },
    ]);
    assert.deepEqual(bootstrap.preferredSkills, []);
    assert.equal(bootstrap.routingHints.length, 1);
    assert.match(bootstrap.routingHints[0] ?? '', /invoke webSearch directly/);
  });
});
