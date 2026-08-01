import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeScopeRequestSchema,
  resolveKnowledgeScope,
} from '../../src/domain/knowledge/knowledge-scope.ts';
import { asCompanyId, asDepartmentId, asUserId } from '../../src/shared/ids.ts';

const authority = {
  companyId: asCompanyId('company-1'),
  userId: asUserId('user-1'),
  selectedDepartmentId: asDepartmentId('department-1'),
  authorizedDepartments: [
    { id: asDepartmentId('department-1'), name: 'Tech Testing' },
  ],
};

describe('knowledge scope', () => {
  it('accepts only the three canonical scope names', () => {
    for (const scope of ['personal', 'department', 'company']) {
      const input = scope === 'department' ? { scope, departmentId: 'department-1' } : { scope };
      assert.equal(KnowledgeScopeRequestSchema.safeParse(input).success, true);
    }

    for (const scope of ['user', 'team', 'global', 'both', 'session', 'draft']) {
      assert.equal(KnowledgeScopeRequestSchema.safeParse({ scope }).success, false);
    }
  });

  it('never accepts caller-supplied personal or company ownership', () => {
    assert.equal(KnowledgeScopeRequestSchema.safeParse({
      scope: 'personal',
      userId: 'another-user',
    }).success, false);
    assert.equal(KnowledgeScopeRequestSchema.safeParse({
      scope: 'company',
      companyId: 'another-company',
    }).success, false);
  });

  it('derives personal and company ownership from authenticated authority', () => {
    assert.deepEqual(resolveKnowledgeScope({ scope: 'personal' }, authority), {
      ok: true,
      value: { scope: 'personal', companyId: 'company-1', userId: 'user-1' },
    });
    assert.deepEqual(resolveKnowledgeScope({ scope: 'company' }, authority), {
      ok: true,
      value: { scope: 'company', companyId: 'company-1' },
    });
  });

  it('resolves only an authorized department and fails closed otherwise', () => {
    assert.deepEqual(resolveKnowledgeScope({ scope: 'department' }, authority), {
      ok: true,
      value: {
        scope: 'department',
        companyId: 'company-1',
        departmentId: 'department-1',
        departmentName: 'Tech Testing',
      },
    });

    assert.equal(resolveKnowledgeScope({
      scope: 'department',
      departmentId: 'department-2',
    }, authority).ok, false);

    assert.deepEqual(resolveKnowledgeScope({ scope: 'department' }, {
      ...authority,
      selectedDepartmentId: undefined,
      authorizedDepartments: [],
    }), {
      ok: false,
      reason: 'department_not_selected',
      message: 'Select an authorized department before targeting department knowledge.',
    });
  });
});
