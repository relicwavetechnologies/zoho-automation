import { config } from 'dotenv';
config();
import { agentRegistry } from './src/company/agents';
import { randomUUID } from 'crypto';

async function testOutreachReadAgent() {
    console.log('--- Testing OutreachReadAgent directly ---');

    const result = await agentRegistry.invoke({
        taskId: `test_${Date.now()}`,
        agentKey: 'outreach-read',
        objective: 'Find me technology publishers with DA over 50',
        correlationId: randomUUID(),
        constraints: [],
        contextPacket: {
            rawFilterString: `"niche" LIKE '%tech%' AND "domainAuthority" >= 50`,
            limit: 5
        }
    });

    console.log('Status:', result.status);
    console.log('Message:', result.message);
    console.log('Result:', JSON.stringify(result.result, null, 2));
}

testOutreachReadAgent().catch(console.error);
