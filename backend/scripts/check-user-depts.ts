import 'dotenv/config';
import { prisma } from '../src/utils/prisma';
import { departmentService } from '../src/company/departments/department.service';
import { departmentPreferenceService } from '../src/company/departments/department-preference.service';

const COMPANY_ID = '9f9360aa-28d1-49df-919f-3b121b7403df';
const USER_ID = 'f6312e2b-d0d3-49fa-acba-786be69949e4';

async function main() {
  const memberships = await departmentService.listUserDepartments(USER_ID, COMPANY_ID);
  console.log(`User has ${memberships.length} active department membership(s):`);
  memberships.forEach((m: any) => {
    console.log(`  - id=${m.id}  name=${m.name}  roleSlug=${m.roleSlug ?? m.role?.slug ?? '?'}`);
  });

  const persisted = await prisma.userDepartmentPreference.findUnique({
    where: { companyId_userId: { companyId: COMPANY_ID, userId: USER_ID } },
  });
  console.log(`\nPersisted preference: activeDepartmentId=${persisted?.activeDepartmentId ?? 'NONE'}`);

  const resolved = await departmentPreferenceService.resolveForRuntime(COMPANY_ID, USER_ID, memberships);
  console.log(`\nresolveForRuntime → reason=${resolved.reason} departmentId=${(resolved as any).departmentId ?? 'NONE'}`);

  if (resolved.reason === 'needs_selection') {
    console.log('\n⚠️  THIS IS THE BUG: department resolution will be SKIPPED →');
    console.log('    runtime falls back to company-level MEMBER permissions.');
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
