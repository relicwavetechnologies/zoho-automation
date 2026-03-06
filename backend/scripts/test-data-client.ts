import 'dotenv/config';
import { zohoDataClient } from '../src/company/integrations/zoho/zoho-data.client';

const companyId = '2af7e2d1-e5f9-4bf3-8a13-59556de09a26';

async function run() {
    console.log(`Testing zohoDataClient.fetchHistoricalPage for Company ID: ${companyId}`);

    try {
        const page = await zohoDataClient.fetchHistoricalPage({
            companyId,
            environment: 'prod',
            pageSize: 10
        });
        console.log('✅ Success! Fetched records:', page.records.length);
    } catch (error) {
        console.error('❌ Failed to fetch historical page:', error);
    }
}

run().catch(console.error);
