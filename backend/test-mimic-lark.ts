import { config } from 'dotenv';
config();

async function mimicLarkMessage() {
    // Determine the API base URL (assuming local dev server runs on 8000 or similar)
    // The webhook route for Lark events
    const url = 'http://[::1]:8000/webhooks/lark/events';

    // TODO: The user will provide the exact JSON structure they receive from Lark.
    // Replace the object below with the actual payload structure.
    const payload = {
        schema: '2.0',
        header: {
            event_id: `mock_event_${Date.now()}`,
            token: process.env.LARK_VERIFICATION_TOKEN || 'WGBrVRDzWxklmnVjEgw8md1Ix1qMSFby',
            create_time: Date.now().toString(),
            event_type: 'im.message.receive_v1',
            tenant_key: '150707d30199d743',
            app_id: process.env.LARK_APP_ID || 'cli_a92d03d75538ded1',
            lark_open_id: 'ou_mock_open_id',
            lark_user_id: 'ou_48b958c283635491b756c0ef23f47159',
        },
        event: {
            sender: {
                sender_id: {
                    union_id: 'on_mock_union_id',
                    user_id: 'ou_48b958c283635491b756c0ef23f47159', // Extracted from logs
                    open_id: 'ou_mock_open_id',
                },
                sender_type: 'user',
                tenant_key: '150707d30199d743',
            },
            message: {
                message_id: `om_mock_${Date.now()}`,
                root_id: '',
                parent_id: '',
                create_time: Date.now().toString(),
                chat_id: 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50', // Extracted from logs
                chat_type: 'p2p',
                message_type: 'text',
                content: JSON.stringify({
                    text: 'Identify the top 3 emerging AI CRM startups on the web. Check if we have any active leads with these domains in Zoho. Then, find 5 technology publishers in Outreach with DA > 50 and prices under $200 for a backlink campaign. Provide a bolded synthesis for Lark.'
                }),
                mentions: [],
            },
        },
    };

    console.log(`Sending mock Lark event to: ${url}`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Lark might require specific headers in the future, if so add them here
            },
            body: JSON.stringify(payload),
        });

        console.log('HTTP Status Code:', response.status);
        const text = await response.text();
        console.log('Response Body:', text);
    } catch (error) {
        console.error('Error sending mock request:', error);
    }
}

mimicLarkMessage().catch(console.error);
