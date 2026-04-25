import 'dotenv/config';
import { prisma } from '../src/utils/prisma';

const COMPANY_ID = '9f9360aa-28d1-49df-919f-3b121b7403df';
const LARK_OPEN_ID = 'ou_48b958c283635491b756c0ef23f47159';
const USER_ID = 'f6312e2b-d0d3-49fa-acba-786be69949e4';

async function main() {
  // 1. Company AI role from ChannelIdentity
  const ci = await prisma.channelIdentity.findFirst({
    where: { companyId: COMPANY_ID, channel: 'lark', larkOpenId: LARK_OPEN_ID },
    select: { id: true, displayName: true, aiRole: true, aiRoleSource: true, syncedAiRole: true },
  });
  console.log('\n=== 1. Your ChannelIdentity (company AI role) ===');
  console.log(JSON.stringify(ci, null, 2));

  // 2. AiRoleDefinitions for this company
  const aiRoles = await prisma.aiRoleDefinition.findMany({ where: { companyId: COMPANY_ID } });
  console.log('\n=== 2. Company AiRoleDefinitions (validRoleSlugs) ===');
  aiRoles.forEach(r => console.log(`  slug=${r.slug}  displayName=${r.displayName}  isBuiltIn=${r.isBuiltIn}`));

  // 3. Find the user's linked userId via LarkUserAuthLink
  const larkLink = await prisma.larkUserAuthLink.findFirst({
    where: { larkOpenId: LARK_OPEN_ID },
    select: { userId: true },
  });
  const userId = larkLink?.userId ?? USER_ID;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  console.log('\n=== 3. Linked User ===');
  console.log(JSON.stringify(user, null, 2));

  // 4. Department memberships + roles
  const memberships = await prisma.departmentMembership.findMany({
    where: { userId: userId, status: 'active' },
    include: {
      department: { select: { id: true, name: true, companyId: true } },
      role: { select: { id: true, name: true, slug: true, isDefault: true } },
    },
  });
  console.log('\n=== 4. Department Memberships ===');
  memberships.forEach(m => {
    console.log(`  dept=${m.department.name} (${m.department.id})`);
    console.log(`    deptRole: slug=${m.role.slug}  name=${m.role.name}  roleId=${m.role.id}`);
  });

  // 5. For each dept the user is in, check DepartmentToolPermission for larkTask
  for (const m of memberships) {
    const perms = await prisma.departmentToolPermission.findMany({
      where: { departmentId: m.department.id, roleId: m.role.id },
      orderBy: { toolId: 'asc' },
    });
    console.log(`\n=== 5. DepartmentToolPermission rows for ${m.department.name} / ${m.role.slug} ===`);
    if (perms.length === 0) {
      console.log('  !! NONE — no explicit rows. Falls through to company fallback.');
    } else {
      perms.forEach(p => console.log(`  toolId=${p.toolId}  actionGroup=${p.actionGroup}  allowed=${p.allowed}`));
    }
    const larkTaskPerms = perms.filter(p => p.toolId.toLowerCase().replace('-', '').includes('larktask'));
    console.log(`  larkTask entries: ${larkTaskPerms.length === 0 ? 'NONE' : JSON.stringify(larkTaskPerms)}`);
  }

  // 6. ToolActionPermission at company level for all roles
  const tapRows = await prisma.toolActionPermission.findMany({
    where: { companyId: COMPANY_ID, toolId: { in: ['larkTask', 'lark-task-agent', 'lark-task-write'] } },
    orderBy: [{ role: 'asc' }, { actionGroup: 'asc' }],
  });
  console.log('\n=== 6. ToolActionPermission rows (company-level) for larkTask tools ===');
  if (tapRows.length === 0) {
    console.log('  NONE — means default "allow all actions" applies IF role is in validRoleSlugs');
  } else {
    tapRows.forEach(r => console.log(`  role=${r.role}  toolId=${r.toolId}  actionGroup=${r.actionGroup}  enabled=${r.enabled}`));
  }

  // 7. ToolPermission (tool-level enable/disable) for larkTask
  const tpRows = await prisma.toolPermission.findMany({
    where: { companyId: COMPANY_ID, toolId: { in: ['larkTask', 'lark-task-agent', 'lark-task-write'] } },
  });
  console.log('\n=== 7. ToolPermission rows (company-level, tool on/off per role) for larkTask ===');
  if (tpRows.length === 0) {
    console.log('  NONE — means default tool defaults apply');
  } else {
    tpRows.forEach(r => console.log(`  role=${r.role}  toolId=${r.toolId}  enabled=${r.enabled}`));
  }

  // 8. Simulate what getAllowedActionsByTool does for "MANAGER" vs actual aiRole
  const userAiRole = ci?.aiRole ?? 'MEMBER';
  console.log(`\n=== 8. Role slug used in company fallback (THE BUG) ===`);
  for (const m of memberships) {
    console.log(`  dept "${m.department.name}": code passes "${m.role.slug}" to getAllowedActionsByTool`);
    console.log(`    validRoleSlugs = ${aiRoles.map(r => r.slug).join(', ')}`);
    const isValid = aiRoles.some(r => r.slug === m.role.slug.toUpperCase());
    console.log(`    "${m.role.slug}" in validRoleSlugs? ${isValid ? 'YES ✓' : 'NO ✗ → returns {} → larkTask DENIED'}`);
    console.log(`    SHOULD pass: "${userAiRole}" (your company AI role from ChannelIdentity.aiRole)`);
    const fixedIsValid = aiRoles.some(r => r.slug === userAiRole.toUpperCase());
    console.log(`    "${userAiRole}" in validRoleSlugs? ${fixedIsValid ? 'YES ✓ — fix works' : 'NO ✗ — extra issue'}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
