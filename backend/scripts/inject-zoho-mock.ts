import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { ZohoHttpClient } from '../src/company/integrations/zoho/zoho-http.client';
import { zohoTokenService } from '../src/company/integrations/zoho/zoho-token.service';

const prisma = new PrismaClient();
const TARGET_COMPANY_ID = '2af7e2d1-e5f9-4bf3-8a13-59556de09a26';

async function run() {
    console.log(`Checking connection for Company ID: ${TARGET_COMPANY_ID}`);

    // 1. Get the connection and oauth config to find the correct API domain
    const connection = await prisma.zohoConnection.findFirst({
        where: { companyId: TARGET_COMPANY_ID }
    });
    const oauthConfig = await prisma.zohoOAuthConfig.findUnique({
        where: { companyId: TARGET_COMPANY_ID }
    });

    if (!connection || !oauthConfig) {
        console.log('❌ No Zoho connection or OAuth config record found for this company.');
        return;
    }

    // Ensure status is CONNECTED
    if (connection.status !== 'CONNECTED') {
        console.log(`Updating connection status from ${connection.status} to CONNECTED...`);
        await prisma.zohoConnection.update({
            where: { id: connection.id },
            data: { status: 'CONNECTED' }
        });
    }

    // 2. Create a dedicated HTTP client for the correct domain (.in vs .com)
    const client = new ZohoHttpClient({
        accountsBaseUrl: oauthConfig.accountsBaseUrl,
        apiBaseUrl: oauthConfig.apiBaseUrl
    });
    console.log(`✅ Using Zoho API Domain: ${oauthConfig.apiBaseUrl}`);

    // 3. Get a valid access token
    console.log('Fetching valid access token...');
    let token: string;
    try {
        token = await zohoTokenService.getValidAccessToken(TARGET_COMPANY_ID, connection.environment);
        console.log('✅ Access token retrieved.');
    } catch (error) {
        console.error('❌ Failed to get access token:', error);
        return;
    }

    // 4. Inject a Mock Contact
    console.log('Injecting Mock Contact...');
    try {
        const contactRes = await client.requestJson({
            base: 'api',
            path: '/crm/v2/Contacts',
            method: 'POST',
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            body: {
                data: [{
                    First_Name: 'Alex',
                    Last_Name: 'Testing',
                    Email: 'alex.testing@example.com',
                    Phone: '555-0198'
                }]
            }
        });
        console.log('Contact Response:', JSON.stringify(contactRes, null, 2));
    } catch (error) {
        console.error('❌ Failed to inject contact:', error);
    }

    // 5. Inject a Mock Deal
    console.log('Injecting Mock Deal...');
    try {
        const dealRes = await client.requestJson({
            base: 'api',
            path: '/crm/v2/Deals',
            method: 'POST',
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            body: {
                data: [{
                    Deal_Name: 'Q3 Enterprise Expansion',
                    Stage: 'Needs Analysis',
                    Amount: 75000,
                    Closing_Date: '2026-09-30'
                }]
            }
        });
        console.log('Deal Response:', JSON.stringify(dealRes, null, 2));
    } catch (error) {
        console.error('❌ Failed to inject deal:', error);
    }

    console.log('\n🎉 Mock data injection attempt complete.');
    await prisma.$disconnect();
}

run().catch(console.error);
