import 'dotenv/config';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';

async function main() {
  const env = loadAndValidateEnv(process.env);
  const c = await buildContainer(env);

  console.log('=== Zoho Token Test ===');
  try {
    const token = await c.zohoTokenService.getValidToken('9f9360aa-28d1-49df-919f-3b121b7403df');
    console.log('SUCCESS — token length:', token.length);

    // Quick API test with the token
    const res = await fetch('https://www.zohoapis.com/books/v3/organizations', {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const data = await res.json() as any;
    console.log('API test — status:', res.status, 'orgs:', data.organizations?.length ?? 0);
  } catch (e: any) {
    console.log('FAILED:', e.message);
  }

  await c.prisma.$disconnect();
  process.exit(0);
}

main();
