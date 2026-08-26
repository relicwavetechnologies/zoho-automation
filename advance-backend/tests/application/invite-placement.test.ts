import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placementFor } from '../../src/application/departments/invite-placement';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const DEPT = '33333333-3333-4333-8333-333333333333';
const ROLE_DEFAULT = '44444444-4444-4444-8444-444444444444';
const ROLE_OTHER = '55555555-5555-4555-8555-555555555555';
const ROLE_MISSING = '66666666-6666-4666-8666-666666666666';

function dept(
  companyId: string,
  roles: readonly { id: string; isDefault: boolean }[],
  status = 'active',
) {
  return { id: DEPT, companyId, status, roles };
}

/** The refusal reason, or null when the placement held. */
const refusalOf = (r: ReturnType<typeof placementFor>): string | null =>
  r.ok ? null : r.error.reason;

describe('placementFor', () => {
  it('departmentId null -> company_only, ignores departmentRoleId', () => {
    const r1 = placementFor({
      companyId: COMPANY,
      departmentId: null,
      departmentRoleId: ROLE_OTHER,
      department: null,
    });
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.ok ? r1.value : null, { kind: 'company_only' });

    const r2 = placementFor({
      companyId: COMPANY,
      departmentId: null,
      departmentRoleId: null,
      department: dept(COMPANY, [{ id: ROLE_DEFAULT, isDefault: true }]),
    });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.ok ? r2.value : null, { kind: 'company_only' });
  });

  it('refuses when department is null but departmentId is set', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: null,
      department: null,
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.reason, 'department_not_in_company');
    assert.equal(!r.ok && r.error.departmentId, DEPT);
  });

  it('refuses when department.companyId !== companyId', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: null,
      department: dept(OTHER_COMPANY, [{ id: ROLE_DEFAULT, isDefault: true }]),
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.reason, 'department_not_in_company');
    assert.equal(!r.ok && r.error.departmentId, DEPT);
  });

  it('refuses role_not_in_department when role id not in department.roles', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: ROLE_MISSING,
      department: dept(COMPANY, [
        { id: ROLE_DEFAULT, isDefault: true },
        { id: ROLE_OTHER, isDefault: false },
      ]),
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.reason, 'role_not_in_department');
    if (!r.ok && r.error.reason === 'role_not_in_department') {
      assert.equal(r.error.roleId, ROLE_MISSING);
      assert.equal(r.error.departmentId, DEPT);
    }
  });

  it('refuses department_has_no_role when departmentRoleId null and no default role', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: null,
      department: dept(COMPANY, [
        { id: ROLE_OTHER, isDefault: false },
      ]),
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.reason, 'department_has_no_role');
    assert.equal(!r.ok && r.error.departmentId, DEPT);
  });

  it('refuses department_has_no_role when roles is empty', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: null,
      department: dept(COMPANY, []),
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.reason, 'department_has_no_role');
  });

  it('uses default role when departmentRoleId is null', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: null,
      department: dept(COMPANY, [
        { id: ROLE_OTHER, isDefault: false },
        { id: ROLE_DEFAULT, isDefault: true },
      ]),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok ? r.value : null, { kind: 'department', departmentId: DEPT, roleId: ROLE_DEFAULT });
  });

  it('uses explicit role when departmentRoleId is set and valid', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: ROLE_OTHER,
      department: dept(COMPANY, [
        { id: ROLE_DEFAULT, isDefault: true },
        { id: ROLE_OTHER, isDefault: false },
      ]),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok ? r.value : null, { kind: 'department', departmentId: DEPT, roleId: ROLE_OTHER });
  });

  it('explicit role wins even when it is the default', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: ROLE_DEFAULT,
      department: dept(COMPANY, [
        { id: ROLE_DEFAULT, isDefault: true },
        { id: ROLE_OTHER, isDefault: false },
      ]),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok ? r.value : null, { kind: 'department', departmentId: DEPT, roleId: ROLE_DEFAULT });
  });

  it('refuses an archived department, and says so rather than calling it another company\'s', () => {
    // Two different situations that used to be one. Raising an invite into an
    // archived department was allowed by the create side and then silently
    // dropped on accept, so the administrator saw a working invite and the
    // person arrived in the company alone — the exact failure this whole
    // change exists to remove.
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: ROLE_DEFAULT,
      department: dept(COMPANY, [{ id: ROLE_DEFAULT, isDefault: true }], 'archived'),
    });
    assert.equal(refusalOf(r), 'department_archived');
  });

  it('checks the company before the archive state', () => {
    // Another company's archived department is not this company's business to
    // be told about. The stronger refusal wins.
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: null,
      department: dept(OTHER_COMPANY, [{ id: ROLE_DEFAULT, isDefault: true }], 'archived'),
    });
    assert.equal(refusalOf(r), 'department_not_in_company');
  });

  it('never trusts caller-supplied department id: mismatch still refuses even if role matches', () => {
    const r = placementFor({
      companyId: COMPANY,
      departmentId: DEPT,
      departmentRoleId: ROLE_DEFAULT,
      department: dept(OTHER_COMPANY, [{ id: ROLE_DEFAULT, isDefault: true }]),
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.reason, 'department_not_in_company');
  });
});
