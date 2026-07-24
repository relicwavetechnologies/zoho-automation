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

  it('advertises the governed local workflow as the direct route for record-set work', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Finance',
      departmentSlug: 'finance',
      companyRole: 'MEMBER',
      permission: permission([
        ['googleGmail', ['read']],
        ['googleSheets', ['create', 'update']],
      ]),
      visibleSkills: [{
        id: 'local-python-id',
        slug: 'divo-python-automation',
        name: 'Divo Local Python Workflows',
        description: 'Transform connected records through the governed local bridge.',
        instructions: 'Hidden full recipe.',
        toolIds: [],
        aliases: [], tags: [], revision: 3,
      }],
      registryRevision: 14,
      zohoConnections: [],
    });

    assert.deepEqual(bootstrap.preferredSkills.map((skill) => skill.id), ['local-python-id']);
    assert.ok(bootstrap.routingHints.some((hint) =>
      hint.includes('Gmail/CRM → Sheets')
      && hint.includes('unified Divo work resolver')
      && hint.includes('Do not fetch Divo Local Python Workflows by itself')
      && hint.includes('persistent Python file')
      && hint.includes('credential-free divo-local')));
  });
});
