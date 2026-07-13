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
        },
        {
          id: 'crm-only-id',
          slug: 'crm-only',
          name: 'CRM Only',
          description: 'CRM workflow.',
          instructions: 'Hidden full recipe.',
          toolIds: ['zohoCrm'],
        },
        {
          id: 'bill-write-id',
          slug: 'zoho-books-bill',
          name: 'Zoho Books Bill Recording',
          description: 'Create a vendor bill.',
          instructions: 'Hidden full recipe.',
          toolIds: ['zohoBooks'],
        },
      ],
      zohoConnections: [],
    });

    assert.ok(bootstrap);
    assert.deepEqual(bootstrap.preferredSkills.map(skill => skill.id), ['finance-core-id']);
    assert.deepEqual(bootstrap.preferredTools, [
      { toolId: 'zohoBooks', actions: ['read'] },
      { toolId: 'webSearch', actions: ['read'] },
    ]);
    assert.ok(bootstrap.routingHints.some(hint => hint.includes('build_overdue_report')));
    assert.ok(!bootstrap.routingHints.some(hint => hint.includes('zohoCrm')));
    assert.deepEqual(bootstrap.zohoConnection, { accessibleCount: 0 });
  });

  it('does not generate Finance assumptions for another department', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Engineering',
      departmentSlug: 'engineering',
      companyRole: 'MEMBER',
      permission: permission([['zohoBooks', ['read']]]),
      visibleSkills: [],
    });

    assert.equal(bootstrap, null);
  });
});
