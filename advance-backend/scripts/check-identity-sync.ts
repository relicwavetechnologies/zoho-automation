/**
 * Diagnostic: check identity sync state for Abhishek + Anish.
 * Looks for duplicate users, stale emails, ChannelIdentity mismatches.
 * Usage: pnpm tsx scripts/check-identity-sync.ts
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

async function main() {
  console.log('\n════════════════════════════════════════');
  console.log('  ABHISHEK VERMA — Identity Audit');
  console.log('════════════════════════════════════════\n');

  // 1. Find ALL users with either email
  const abhishekUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { contains: 'vabhi', mode: 'insensitive' } },
        { email: { contains: 'abhishek', mode: 'insensitive' } },
        { email: { contains: 'emiactech', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
  });
  console.log(`Users matching abhishek/vabhi/emiactech (${abhishekUsers.length}):`);
  for (const u of abhishekUsers) {
    console.log(`  id=${u.id}  email=${u.email}  name=${u.name}  created=${u.createdAt.toISOString()}  updated=${u.updatedAt.toISOString()}`);
  }

  // 2. Find ALL ChannelIdentities for both emails + any with Abhishek's known larkOpenId
  const abhishekOpenId = 'ou_48b958c283635491b756c0ef23f47159';
  const abhishekCIs = await prisma.channelIdentity.findMany({
    where: {
      OR: [
        { email: { contains: 'vabhi', mode: 'insensitive' } },
        { email: { contains: 'abhishek', mode: 'insensitive' } },
        { email: { contains: 'emiactech', mode: 'insensitive' } },
        { larkOpenId: abhishekOpenId },
      ],
    },
    select: {
      id: true, email: true, displayName: true, larkOpenId: true, larkUserId: true,
      aiRole: true, companyId: true, createdAt: true, updatedAt: true,
    },
  });
  console.log(`\nChannelIdentities matching (${abhishekCIs.length}):`);
  for (const ci of abhishekCIs) {
    console.log(`  id=${ci.id}  email=${ci.email}  displayName=${ci.displayName}  larkOpenId=${ci.larkOpenId}  aiRole=${ci.aiRole}  created=${ci.createdAt.toISOString()}  updated=${ci.updatedAt.toISOString()}`);
  }

  // 3. LarkUserAuthLinks for Abhishek
  const abhishekAuthLinks = await prisma.larkUserAuthLink.findMany({
    where: {
      OR: [
        { larkOpenId: abhishekOpenId },
        ...abhishekUsers.map(u => ({ userId: u.id })),
      ],
    },
    select: { id: true, userId: true, larkOpenId: true, larkUserId: true, larkEmail: true, companyId: true },
  });
  console.log(`\nLarkUserAuthLinks (${abhishekAuthLinks.length}):`);
  for (const al of abhishekAuthLinks) {
    console.log(`  id=${al.id}  userId=${al.userId}  larkOpenId=${al.larkOpenId}  larkEmail=${al.larkEmail}  companyId=${al.companyId}`);
  }

  // 4. AdminMemberships for all Abhishek users
  for (const u of abhishekUsers) {
    const memberships = await prisma.adminMembership.findMany({
      where: { userId: u.id },
      select: { id: true, companyId: true, role: true },
    });
    console.log(`\nAdminMemberships for ${u.email} (${memberships.length}):`);
    for (const m of memberships) {
      console.log(`  id=${m.id}  companyId=${m.companyId}  role=${m.role}`);
    }
  }

  // 5. DepartmentMemberships for all Abhishek users
  for (const u of abhishekUsers) {
    const deptMembers = await prisma.departmentMembership.findMany({
      where: { userId: u.id },
      include: {
        department: { select: { name: true } },
        role: { select: { name: true, slug: true } },
      },
    });
    console.log(`\nDepartmentMemberships for ${u.email} (${deptMembers.length}):`);
    for (const dm of deptMembers) {
      console.log(`  dept=${dm.department.name}  role=${dm.role.name}/${dm.role.slug}  status=${dm.status}`);
    }
  }

  console.log('\n\n════════════════════════════════════════');
  console.log('  ANISH SUMAN — Identity Audit');
  console.log('════════════════════════════════════════\n');

  const anishUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { contains: 'anish', mode: 'insensitive' } },
        { name: { contains: 'anish', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
  });
  console.log(`Users matching anish (${anishUsers.length}):`);
  for (const u of anishUsers) {
    console.log(`  id=${u.id}  email=${u.email}  name=${u.name}  created=${u.createdAt.toISOString()}  updated=${u.updatedAt.toISOString()}`);
  }

  const anishOpenId = 'ou_a1c4b19abc483d674dde1955142e6b7d';
  const anishCIs = await prisma.channelIdentity.findMany({
    where: {
      OR: [
        { email: { contains: 'anish', mode: 'insensitive' } },
        { larkOpenId: anishOpenId },
      ],
    },
    select: {
      id: true, email: true, displayName: true, larkOpenId: true, larkUserId: true,
      aiRole: true, companyId: true, createdAt: true, updatedAt: true,
    },
  });
  console.log(`\nChannelIdentities matching (${anishCIs.length}):`);
  for (const ci of anishCIs) {
    console.log(`  id=${ci.id}  email=${ci.email}  displayName=${ci.displayName}  larkOpenId=${ci.larkOpenId}  aiRole=${ci.aiRole}  created=${ci.createdAt.toISOString()}  updated=${ci.updatedAt.toISOString()}`);
  }

  const anishAuthLinks = await prisma.larkUserAuthLink.findMany({
    where: {
      OR: [
        { larkOpenId: anishOpenId },
        ...anishUsers.map(u => ({ userId: u.id })),
      ],
    },
    select: { id: true, userId: true, larkOpenId: true, larkUserId: true, larkEmail: true, companyId: true },
  });
  console.log(`\nLarkUserAuthLinks (${anishAuthLinks.length}):`);
  for (const al of anishAuthLinks) {
    console.log(`  id=${al.id}  userId=${al.userId}  larkOpenId=${al.larkOpenId}  larkEmail=${al.larkEmail}  companyId=${al.companyId}`);
  }

  // Also dump ALL ChannelIdentities to see what the last sync created
  const allCIs = await prisma.channelIdentity.findMany({
    where: { channel: 'lark' },
    select: { id: true, email: true, displayName: true, larkOpenId: true, aiRole: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });
  console.log(`\n\n════════════════════════════════════════`);
  console.log(`  ALL Lark ChannelIdentities (latest 20)`);
  console.log(`════════════════════════════════════════\n`);
  for (const ci of allCIs) {
    console.log(`  ${ci.email ?? '(no email)'}  name=${ci.displayName}  openId=${ci.larkOpenId}  role=${ci.aiRole}  updated=${ci.updatedAt.toISOString()}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
