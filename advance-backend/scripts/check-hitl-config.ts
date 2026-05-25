/**
 * Diagnostic: check Anish Suman's HITL approval config in DB.
 * Usage: pnpm tsx scripts/check-hitl-config.ts
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

async function main() {
  const anish = await prisma.user.findFirst({
    where: { email: 'anishsuman2305@gmail.com' },
    select: { id: true, name: true, email: true },
  });
  console.log('\n=== Anish Suman ===');
  console.log(anish);
  if (!anish) { console.log('NOT FOUND'); return; }

  const memberships = await prisma.departmentMembership.findMany({
    where: { userId: anish.id, status: 'active' },
    include: {
      department: { select: { id: true, name: true } },
      role: { select: { id: true, name: true, slug: true } },
    },
  });
  console.log('\n=== Memberships ===');
  for (const m of memberships) {
    console.log(`  dept: ${m.department.name} (${m.department.id}), role: ${m.role.name} / ${m.role.slug}`);
  }

  for (const m of memberships) {
    const config = await prisma.departmentAgentConfig.findUnique({
      where: { departmentId: m.department.id },
      select: { managerApprovalJson: true, isActive: true },
    });
    console.log(`\n=== DepartmentAgentConfig for "${m.department.name}" ===`);
    console.log('isActive:', config?.isActive);
    console.log('managerApprovalJson:', JSON.stringify(config?.managerApprovalJson, null, 2));
  }

  for (const m of memberships) {
    const perms = await prisma.departmentToolPermission.findMany({
      where: { departmentId: m.department.id, toolId: 'googleGmail' },
      select: { roleId: true, toolId: true, actionGroup: true, allowed: true },
    });
    console.log(`\n=== googleGmail perms in "${m.department.name}" ===`);
    for (const p of perms) {
      const isAnishRole = p.roleId === m.role.id ? ' ← ANISH' : '';
      console.log(`  roleId=${p.roleId}${isAnishRole}: ${p.actionGroup}=${p.allowed}`);
    }
  }

  for (const m of memberships) {
    const manager = await prisma.departmentMembership.findFirst({
      where: {
        departmentId: m.department.id,
        status: 'active',
        role: { slug: { in: ['MANAGER', 'manager'] } },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    console.log(`\n=== Manager for "${m.department.name}" ===`);
    if (manager) {
      console.log(`  ${manager.user.name} (${manager.user.email}) userId=${manager.user.id}`);
      const authLink = await prisma.larkUserAuthLink.findFirst({
        where: { userId: manager.user.id },
        select: { larkOpenId: true },
      });
      console.log(`  larkOpenId: ${authLink?.larkOpenId ?? 'NONE'}`);
    } else {
      console.log('  NO MANAGER FOUND');
    }
  }

  // Also check Anish's lark identity
  const anishAuth = await prisma.larkUserAuthLink.findFirst({
    where: { userId: anish.id },
    select: { larkOpenId: true, larkUserId: true },
  });
  console.log('\n=== Anish LarkUserAuthLink ===');
  console.log(anishAuth);

  const anishCI = await prisma.channelIdentity.findFirst({
    where: { email: 'anishsuman2305@gmail.com', channel: 'lark' },
    select: { id: true, larkOpenId: true, aiRole: true, companyId: true },
  });
  console.log('\n=== Anish ChannelIdentity ===');
  console.log(anishCI);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
