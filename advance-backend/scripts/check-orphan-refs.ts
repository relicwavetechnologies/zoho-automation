/**
 * Pre-flight check: find all FK references to the two orphan users
 * before deleting them. If any non-AdminMembership references exist,
 * we need to transfer them first.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

const ORPHANS = [
  { id: '60edd6fc-52f6-464d-9758-061dc2828120', email: 'anish@emiactech.com' },
  { id: '613391c1-c706-4ea3-9b1d-a1b2875fc966', email: 'abhishek@emiactech.com' },
];

async function main() {
  for (const orphan of ORPHANS) {
    console.log(`\n=== Orphan: ${orphan.email} (${orphan.id}) ===`);

    const adminMemberships = await prisma.adminMembership.findMany({ where: { userId: orphan.id } });
    console.log(`  AdminMembership: ${adminMemberships.length}`);

    const deptMemberships = await prisma.departmentMembership.findMany({ where: { userId: orphan.id } });
    console.log(`  DepartmentMembership: ${deptMemberships.length}`);

    const authLinks = await prisma.larkUserAuthLink.findMany({ where: { userId: orphan.id } });
    console.log(`  LarkUserAuthLink: ${authLinks.length}`);

    const deptPrefs = await prisma.userDepartmentPreference.findMany({ where: { userId: orphan.id } });
    console.log(`  UserDepartmentPreference: ${deptPrefs.length}`);

    const tokenPolicies = await prisma.memberTokenPolicy.findMany({ where: { userId: orphan.id } });
    console.log(`  MemberTokenPolicy: ${tokenPolicies.length}`);

    const tokenUsage = await prisma.aiTokenUsage.findMany({ where: { userId: orphan.id } });
    console.log(`  AiTokenUsage: ${tokenUsage.length}`);

    const approvals = await prisma.runtimeApproval.findMany({ where: { requestedBy: orphan.id }, take: 5 });
    console.log(`  RuntimeApproval (requestedBy): ${approvals.length}`);

    const agentConfigs = await prisma.departmentAgentConfig.findMany({
      where: { OR: [{ createdBy: orphan.id }, { updatedBy: orphan.id }] },
    });
    console.log(`  DepartmentAgentConfig (createdBy/updatedBy): ${agentConfigs.length}`);

    const executionRuns = await prisma.executionRun.findMany({ where: { userId: orphan.id }, take: 5 });
    console.log(`  ExecutionRun: ${executionRuns.length}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
