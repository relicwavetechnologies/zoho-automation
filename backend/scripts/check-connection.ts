import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();
const companyId = '2af7e2d1-e5f9-4bf3-8a13-59556de09a26';

async function run() {
    console.log(`Checking connection for Company ID: ${companyId}`);

    const company = await prisma.company.findUnique({
        where: { id: companyId }
    });

    if (!company) {
        console.log('❌ Company not found');
        return;
    }

    console.log('Company Name:', company.name);

    const connections = await prisma.zohoConnection.findMany({
        where: { companyId }
    });
    console.log('Zoho Connections:', JSON.stringify(connections, null, 2));

    const oauthConfig = await prisma.zohoOAuthConfig.findUnique({
        where: { companyId }
    });
    console.log('Zoho OAuth Config:', JSON.stringify(oauthConfig, null, 2));
}

run()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
