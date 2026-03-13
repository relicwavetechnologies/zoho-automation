import { prisma } from '../src/utils/prisma';

const QDRANT_URL = "https://2debf76c-0e58-4c79-93e6-fea2e7bcc8d1.sa-east-1-0.aws.cloud.qdrant.io";
const QDRANT_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIn0.io1UDA5vPgVA_pRPnV4NkLKw1MOA6M9hZKYBAbV3sqs";
const COLLECTION = "zoho_automation_docs";

async function run() {
  console.log("=== 1. Checking Postgres VectorDocument for Desktop Channel ===");
  const docs = await prisma.vectorDocument.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  
  // @ts-ignore
  const desktopDocs = docs.filter(d => d.payload && d.payload.channel === 'desktop');
  console.log(`Found ${desktopDocs.length} recent desktop docs out of ${docs.length} total recent docs.`);
  // @ts-ignore
  console.dir(desktopDocs.map(d => ({ id: d.id, ownerUserId: d.ownerUserId, text: (d.payload || {}).text })), { depth: null });

  console.log("\n=== 2. Checking Qdrant for ALL recent chat_turn vectors regardless of channel ===");
  try {
    const qResponse = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 
        'api-key': QDRANT_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filter: {
          must: [
            { key: "sourceType", match: { value: "chat_turn" } }
          ]
        },
        limit: 10,
        with_payload: true
      })
    });
    const data = await qResponse.json();
    const points = data.result?.points || [];
    console.log(`Found ${points.length} recent points in Qdrant.`);
    console.dir(points.map((p: any) => ({ id: p.id, ownerUserId: p.payload?.ownerUserId, text: p.payload?.text, channel: p.payload?.channel })), { depth: null });
  } catch (err: any) {
    console.error("Qdrant query failed:", err.message);
  }

  await prisma.$disconnect();
}
run();
