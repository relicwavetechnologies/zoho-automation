import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

const companyId = '9f9360aa-28d1-49df-919f-3b121b7403df';
const finDeptId = 'b03bf6d3-b3cb-4e8f-8355-541c0ecbf3af';

async function main() {
  const finDept = await prisma.department.findUnique({
    where: { id: finDeptId },
    include: { agentConfig: { select: { managerApprovalJson: true } } },
  });
  console.log('\n=== Finance Dept agentConfig.managerApprovalJson ===');
  console.log(JSON.stringify(finDept, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
