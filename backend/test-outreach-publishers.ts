import { config } from 'dotenv';
config();

// We need to fetch directly to test raw string filters since the OutreachClient
// in the codebase currently only supports the object-based OutreachQueryFilters
// (The previous string-filter implementation was reverted by the git reset).

async function testOutreachPublishers() {
    console.log('--- Testing Outreach API directly with string filters ---');

    // We will test the equivalent of what the LLM should be able to send
    const rawFilterString = `"niche" LIKE '%tech%' AND "domainAuthority" >= 50`;

    const body = {
        limit: 5,
        offset: 0,
        page: 1,
        filters: rawFilterString
    };

    try {
        const response = await fetch(process.env.OUTREACH_API_URL || 'https://api.outreach.com/publishers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                // Add authorization headers if required by the API
            },
            body: JSON.stringify(body),
        });

        console.log('HTTP Status:', response.status);
        const text = await response.text();

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }

        console.log('Response:');
        console.log(JSON.stringify(data, null, 2).substring(0, 500) + '...');

    } catch (error) {
        console.error('Error fetching from Outreach API:', error);
    }
}

testOutreachPublishers().catch(console.error);
