import 'dotenv/config';
import { hitlActionRepository } from '../src/company/state/hitl';
import { executeStoredRemoteToolAction } from '../src/company/state/hitl/hitl-remote-action.executor';

async function main() {
  console.log('=== Checking for pending HITL action ===');

  const openId = 'ou_48b958c283635491b756c0ef23f47159';
  const slim = await hitlActionRepository.getLatestPendingByChat('lark', openId);

  if (!slim) {
    console.log('NO PENDING HITL ACTION FOUND for', openId);
    console.log('Run the harness first to create one.');
    return;
  }

  // Use getHydratedByActionId to get payload + metadata (same as production flow)
  const action = await hitlActionRepository.getHydratedByActionId(slim.actionId);
  if (!action) {
    console.log('ACTION NOT FOUND (hydrated) for actionId', slim.actionId);
    return;
  }

  const p = (action.payload ?? {}) as Record<string, unknown>;
  const m = (action.metadata ?? {}) as Record<string, unknown>;
  console.log('FOUND ACTION:', JSON.stringify({
    actionId: action.actionId,
    toolId: action.toolId,
    operation: p.operation,
    to: p.to,
    subject: p.subject,
    bodyPreview: typeof p.body === 'string' ? p.body.slice(0, 120) : null,
    hasCanonicalOp: Boolean(p.canonicalOperation),
    summary: action.summary,
    metadataCompanyId: m.companyId,
    metadataUserId: m.userId,
    metadataEmail: m.requesterEmail,
  }, null, 2));

  console.log('\n=== Executing action (simulating approval) ===');
  try {
    const result = await executeStoredRemoteToolAction(action as any);
    console.log('EXECUTION OK:', result.ok);
    console.log('SUMMARY:', result.summary);
    console.log('MUTATION:', JSON.stringify(result.mutationResult ?? null, null, 2));
  } catch (err) {
    console.log('EXECUTION ERROR:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.log('STACK:', err.stack.split('\n').slice(0, 8).join('\n'));
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
