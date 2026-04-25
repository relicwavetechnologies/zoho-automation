/**
 * Manually re-trigger ApprovalResumerService for a stuck/already-approved approval.
 * Usage: pnpm tsx scripts/mock-hitl-approval.ts <approvalId>
 */
import 'dotenv/config';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';

async function main() {
  const approvalId = process.argv[2];
  if (!approvalId) {
    console.error('Usage: pnpm tsx scripts/mock-hitl-approval.ts <approvalId>');
    process.exit(1);
  }

  const env       = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const resumer   = container.approvalResumer;

  console.log(`Resuming approval ${approvalId}...`);
  await resumer.resume(approvalId, 'approved');
  console.log('Done.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
