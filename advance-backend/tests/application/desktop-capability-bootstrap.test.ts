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
    // The recipe is advisory native guidance. Backend RBAC remains the authority.
    assert.ok(bootstrap.routingHints.some(hint =>
      hint.includes('build_overdue_report')
      && hint.includes('follow the native finance-ops-core recipe')));
    assert.ok(!bootstrap.routingHints.some(hint => hint.includes('invoke webSearch directly')));

    // webSearch is permitted here but no visible skill declares it, so it cannot
    // be loaded and must not be advertised as a route.
    assert.ok(!bootstrap.routingHints.some(hint => hint.includes('webSearch')));
    assert.ok(!bootstrap.routingHints.some(hint => hint.includes('zohoCrm')));
    assert.deepEqual(bootstrap.zohoConnections, []);
    assert.deepEqual(bootstrap.families.find(family => family.familyId === 'zoho'), {
      familyId: 'zoho',
      displayName: 'Zoho',
      connectionMode: 'member_selectable',
      connectionProvider: 'zoho',
      skillMode: 'optional',
      tools: [{
        toolId: 'zohoBooks',
        actions: ['read'],
        displayName: 'Zoho Books',
        description: 'Use Zoho Books for governed access to invoices.',
      }],
      skills: [{
        skillId: 'finance-core-id',
        name: 'Finance Ops Core',
        mode: 'optional',
      }, {
        skillId: 'bill-write-id',
        name: 'Zoho Books Bill Recording',
        mode: 'optional',
      }],
    });
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

    assert.equal(bootstrap.version, 3);
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
    assert.deepEqual(bootstrap.families.map(family => family.familyId), [
      'lark',
      'zoho',
      'context',
      'scheduling',
    ]);
    assert.deepEqual(
      bootstrap.families.find(family => family.familyId === 'scheduling'),
      {
        familyId: 'scheduling',
        displayName: 'Scheduled work',
        connectionMode: 'none',
        skillMode: 'required',
        tools: [{
          toolId: 'scheduledWorkflows',
          actions: ['execute'],
          displayName: 'Scheduled Work',
          description: 'Use Scheduled Work for governed access to schedules.',
        }],
        skills: [],
      },
    );
    assert.deepEqual(bootstrap.preferredSkills, []);
    // webSearch is permitted for this department but no visible skill declares
    // it, so there is no skill to load and therefore no way to invoke it. The
    // catalogue stays silent rather than routing the model into a refusal.
    assert.deepEqual(bootstrap.routingHints, []);
  });

  it('preserves every visible Zoho choice for pre-terminal account selection', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Finance',
      departmentSlug: 'finance',
      companyRole: 'MEMBER',
      permission: permission([['zohoCrm', ['read']]]),
      visibleSkills: [],
      registryRevision: 1,
      zohoConnections: [
        { connectionId: 'zoho-1', label: 'Emiac', access: 'read_only', services: ['books'] },
        { connectionId: 'zoho-2', label: 'Macobs', access: 'read_only', services: ['crm'] },
      ],
    });

    assert.deepEqual(bootstrap.zohoConnections, [
      { connectionId: 'zoho-1', label: 'Emiac', access: 'read_only', services: ['books'] },
      { connectionId: 'zoho-2', label: 'Macobs', access: 'read_only', services: ['crm'] },
    ]);
  });

  it('routes settled Menhood analysis without hiding the live Airtable path', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Operations',
      departmentSlug: 'operations',
      companyRole: 'COMPANY_ADMIN',
      permission: permission([['menhoodData', ['read']]]),
      visibleSkills: [{
        id: 'menhood-skill-id',
        slug: 'menhood-data',
        name: 'Menhood Data',
        description: 'Query Menhood reporting data.',
        instructions: 'Hidden full recipe.',
        toolIds: ['menhoodData'],
        aliases: [], tags: [], revision: 1,
      }],
      registryRevision: 14,
    });

    assert.ok(bootstrap.routingHints.some(hint =>
      hint.includes('follow the native menhood-data recipe')
      && hint.includes('use menhoodData for settled analysis')
      && hint.includes('current/latest or Airtable-only operational fields')
      && hint.includes('source, divo-python-automation, and google-sheets recipes load together')));
  });

  it('routes a permitted tool through the skill that declares it', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Engineering',
      departmentSlug: 'engineering',
      companyRole: 'MEMBER',
      permission: permission([['webSearch', ['read']]]),
      visibleSkills: [{
        id: 'web-research-id',
        slug: 'web-research',
        name: 'Web Research',
        description: 'Look things up on the public web.',
        instructions: 'Hidden full recipe.',
        toolIds: ['webSearch'],
        aliases: [], tags: [], revision: 1,
      }],
      zohoConnections: [],
    });

    const hint = bootstrap.routingHints.find(entry => entry.includes('webSearch'));
    assert.ok(hint, 'a declared tool should be routed');
    assert.match(hint, /follow the native web-research recipe, then invoke webSearch/);
    assert.doesNotMatch(hint, /directly/);
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
