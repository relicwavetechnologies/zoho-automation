import { config } from 'dotenv';
config();

async function verifyLeads() {
    const fullUrl = process.env.ZOHO_API_BASE_URL;
    if (!fullUrl) {
        console.error('ZOHO_API_BASE_URL not found in .env');
        return;
    }

    const callTool = async (name: string, args: any) => {
        console.log(`\n--- Calling Tool: ${name} ---`);
        const payload = {
            jsonrpc: '2.0',
            id: Math.random().toString(36).substring(7),
            method: 'tools/call',
            params: {
                name,
                arguments: args
            }
        };

        try {
            const response = await fetch(fullUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const text = await response.text();
            console.log('HTTP Status:', response.status);

            if (!text) {
                console.log('Empty response body.');
                return null;
            }

            try {
                const result = JSON.parse(text);
                if (result.result?.content?.[0]?.text) {
                    console.log('Output Text Length:', result.result.content[0].text.length);
                    try {
                        const dataObj = JSON.parse(result.result.content[0].text);
                        const records = dataObj.data || dataObj;
                        console.log('Records Found:', Array.isArray(records) ? records.length : 'N/A');
                        if (Array.isArray(records) && records.length > 0) {
                            console.log('Sample Record:', JSON.stringify(records[0], null, 2));
                        } else if (dataObj.status === 'error') {
                            console.log('Error from API:', JSON.stringify(dataObj, null, 2));
                        } else {
                            console.log('Full Data Object:', JSON.stringify(dataObj, null, 2));
                        }
                    } catch {
                        console.log('Output Content:', result.result.content[0].text);
                    }
                } else {
                    console.log('Response JSON:', JSON.stringify(result, null, 2));
                }
                return result;
            } catch (e) {
                console.log('Raw Response (not JSON):', text);
                return null;
            }
        } catch (error) {
            console.error('Fetch failed:', error);
            return null;
        }
    };

    // 1. Fetch Leads
    console.log('--- FETCHING LEADS ---');
    await callTool('ZohoCRM_Get_Records', {
        path_variables: { module: 'Leads' },
        query_params: {
            per_page: 5,
            fields: 'id,Last_Name,Email,Company'
        }
    });

    // 2. Fetch Contacts
    console.log('\n--- FETCHING CONTACTS ---');
    await callTool('ZohoCRM_Get_Records', {
        path_variables: { module: 'Contacts' },
        query_params: {
            per_page: 5,
            fields: 'id,Full_Name,Email'
        }
    });
}

verifyLeads().catch(console.error);
