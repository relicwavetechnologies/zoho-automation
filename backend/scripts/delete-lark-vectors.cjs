const axios = require('axios');
require('dotenv').config();

const QDRANT_URL = process.env.QDRANT_URL || "https://2debf76c-0e58-4c79-93e6-fea2e7bcc8d1.sa-east-1-0.aws.cloud.qdrant.io";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIn0.io1UDA5vPgVA_pRPnV4NkLKw1MOA6M9hZKYBAbV3sqs";
const COLLECTION = process.env.QDRANT_COLLECTION || "zoho_automation_docs";

async function run() {
  try {
    console.log(`Deleting existing vectors from channel "lark"...`);
    
    // We use the Points Delete API with a filter
    const response = await axios.post(`${QDRANT_URL}/collections/${COLLECTION}/points/delete`, {
      filter: {
        must: [
          { key: "channel", match: { value: "lark" } }
        ]
      }
    }, {
      headers: { 'api-key': QDRANT_API_KEY }
    });

    console.log("Qdrant delete response:", response.data);

    // Also delete from Prisma
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const dbResult = await prisma.$executeRaw`DELETE FROM "VectorDocument" WHERE (payload->>'channel') = 'lark';`;
      console.log(`Deleted ${dbResult} records from PostgreSQL VectorDocument table.`);
    } catch (dbErr) {
      console.warn("Could not delete from Postgres:", dbErr.message);
    } finally {
      await prisma.$disconnect();
    }

    console.log("Done.");
  } catch (error) {
    console.error('Error deleting from Qdrant:', error.response?.data || error.message);
  }
}

run();
