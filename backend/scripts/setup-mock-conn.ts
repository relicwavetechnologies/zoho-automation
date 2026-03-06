import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
    // 1. Get the admin user
    const admin = await prisma.user.findUnique({
        where: { email: 'admin@relicwave.com' },
        include: { company: true }
    });

    if (!admin || !admin.company) {
        console.log('❌ Admin user or company not found');
        return;
    }

    const companyId = admin.company.id;
    console.log(`✅ Found Admin Company ID: ${companyId}`);

    // 2. Clear out any existing inactive connections
    await prisma.zohoConnection.deleteMany({
        where: { companyId }
    });

    // 3. Create a mock ZohoConnection to satisfy the DB checks
    console.log('Creating active mock ZohoConnection...');
    const conn = await prisma.zohoConnection.create({
        data: {
            companyId,
            environment: 'prod',
            status: 'active',
            scopes: ['ZohoCRM.modules.all'],
            refreshToken: '1000.mock_refresh_token_for_testing.xxxxx',
            accessToken: '1000.mock_access_token_for_testing.xxxxx',
            tokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365), // 1 year
            zohoDomain: 'com'
        }
    });

    console.log('✅ Created mock connection:', conn.id);
    console.log('\nRun the inject-zoho-mock script now. Note: Because this is a mock token, the actual POST to Zoho might fail with an auth error unless this is a real dev environment that bypasses Zoho, but it will test our internal wiring.');
}

run()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
