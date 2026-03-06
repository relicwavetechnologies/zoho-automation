import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
    const config = await prisma.zohoConnection.findFirst({
        where: { status: 'active' }
    });

    if (!config) {
        console.log('No active Zoho connection found');
        return;
    }

    console.log('COMPANY_ID:', config.companyId);
    console.log('Config:', config);
}

run()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
