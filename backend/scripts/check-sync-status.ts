import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();
const companyId = '2af7e2d1-e5f9-4bf3-8a13-59556de09a26';

async function run() {
    console.log(`Checking Sync Status for Company ID: ${companyId}`);

    const jobs = await prisma.zohoSyncJob.findMany({
        where: { companyId },
        orderBy: { queuedAt: 'desc' },
        take: 5
    });

    console.log('Recent Sync Jobs:', JSON.stringify(jobs, null, 2));
}

run()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
