/**
 * harness-perm-step.ts
 *
 * Reproduces the EXACT supervisor-v2 lark-ops-agent → larkTask.create flow that
 * fails with "Permission denied: larkTask cannot perform create for the current
 * department role." — without going through Lark, an LLM, or the worker queue.
 *
 * Steps:
 *   1. Resolve user from Lark openId
 *   2. Pull the channel identity's aiRole (the runtime role that the engine uses)
 *   3. Run the same allowedActionsByTool resolution supervisor-v2.engine.ts:3088-3134 does
 *   4. Build a VercelRuntimeRequestContext just like supervisor-v2 hands to runLarkAgent
 *   5. Build the larkTask tool via createVercelDesktopTools (same call runLarkAgent uses)
 *   6. Invoke larkTask.execute({operation: 'write', taskOperation: 'create', ...})
 *      and report the verdict
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register --project tsconfig.json scripts/harness-perm-step.ts
 */
import 'dotenv/config';
import { prisma } from '../src/utils/prisma';
import { departmentService } from '../src/company/departments/department.service';
import { departmentPreferenceService } from '../src/company/departments/department-preference.service';
import { toolPermissionService } from '../src/company/tools/tool-permission.service';
import { createVercelDesktopTools } from '../src/company/orchestration/vercel/legacy-tools';
import { departmentRuntimeCache } from '../src/company/departments/department-runtime.cache';
import { toolAccessCache } from '../src/company/tools/tool-access.cache';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../src/company/orchestration/vercel/types';

const COMPANY_ID    = '9f9360aa-28d1-49df-919f-3b121b7403df';
const DEPARTMENT_ID = 'b03bf6d3-b3cb-4e8f-8355-541c0ecbf3af';
const LARK_OPEN_ID  = 'ou_48b958c283635491b756c0ef23f47159';
const CHAT_ID       = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';

const banner = (label: string) => console.log(`\n${'═'.repeat(60)}\n${label}\n${'═'.repeat(60)}`);
const dim = (label: string, value: unknown) =>
  console.log(`  ${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);

const noOpToolHooks: VercelRuntimeToolHooks = {
  onToolStart: async () => {},
  onToolFinish: async () => {},
  onToolError: async () => {},
} as unknown as VercelRuntimeToolHooks;

async function main() {
  banner('1. Resolve user + channel identity');
  const link = await prisma.larkUserAuthLink.findFirst({
    where: { larkOpenId: LARK_OPEN_ID, companyId: COMPANY_ID },
    select: { userId: true, larkName: true },
  });
  if (!link?.userId) {
    console.error('No linked user.');
    process.exit(1);
  }
  const channelIdentity = await prisma.channelIdentity.findFirst({
    where: { companyId: COMPANY_ID, channel: 'lark', larkOpenId: LARK_OPEN_ID },
    select: { id: true, aiRole: true },
  });
  const requesterAiRole = channelIdentity?.aiRole ?? 'MEMBER';
  dim('userId', link.userId);
  dim('channelIdentity.aiRole', requesterAiRole);

  banner('2. Clear caches');
  await departmentRuntimeCache.invalidateCompany(COMPANY_ID);
  await toolAccessCache.invalidateCompany(COMPANY_ID);

  banner('3. Replicate supervisor-v2 runtime construction (lines 3088-3134)');
  const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(COMPANY_ID, requesterAiRole);
  let allowedToolIds = fallbackAllowedToolIds;
  let allowedActionsByTool = await toolPermissionService.getAllowedActionsByTool(
    COMPANY_ID, requesterAiRole, fallbackAllowedToolIds,
  );
  dim('post-company allowedActionsByTool[larkTask]', allowedActionsByTool.larkTask ?? null);

  // Mimic the linkedUserId branch
  const departments = await departmentService.listUserDepartments(link.userId, COMPANY_ID);
  const preferred = await departmentPreferenceService.resolveForRuntime(COMPANY_ID, link.userId, departments);
  dim('preferredDepartment.reason', preferred.reason);
  dim('preferredDepartment.departmentId', (preferred as any).departmentId ?? null);

  if (preferred.reason !== 'needs_selection') {
    const resolved = await departmentService.resolveRuntimeContext({
      userId: link.userId,
      companyId: COMPANY_ID,
      departmentId: (preferred as any).departmentId,
      fallbackAllowedToolIds,
      requesterAiRole,
    });
    allowedToolIds = resolved.allowedToolIds;
    allowedActionsByTool = (resolved as any).allowedActionsByTool ?? {};
    dim('post-department allowedActionsByTool[larkTask]', allowedActionsByTool.larkTask ?? null);
  } else {
    console.log('  ⚠ preferredDepartment needs_selection — DEPARTMENT RESOLUTION SKIPPED');
  }

  // contextSearch top-up (same as supervisor-v2 does)
  if (!allowedToolIds.includes('contextSearch')) {
    allowedToolIds = [...allowedToolIds, 'contextSearch'];
  }

  banner('4. Build runtime exactly like resolveRuntimeContext returns');
  const runtime: VercelRuntimeRequestContext = {
    channel: 'lark',
    threadId: 'harness-thread',
    chatId: CHAT_ID,
    taskId: 'harness-task',
    executionId: 'harness-exec',
    companyId: COMPANY_ID,
    userId: link.userId,
    requesterAiRole,
    requesterName: link.larkName ?? undefined,
    sourceMessageId: 'harness-msg',
    sourceReplyToMessageId: 'harness-msg',
    sourceChatType: 'p2p',
    sourceChannelUserId: LARK_OPEN_ID,
    latestUserMessage: 'create a lark task',
    departmentId: DEPARTMENT_ID,
    larkOpenId: LARK_OPEN_ID,
    authProvider: 'lark',
    mode: 'lark_v2',
    allowedToolIds,
    allowedActionsByTool,
  } as unknown as VercelRuntimeRequestContext;

  dim('runtime.allowedToolIds.includes(larkTask)', runtime.allowedToolIds.includes('larkTask'));
  dim('runtime.allowedActionsByTool.larkTask', (runtime as any).allowedActionsByTool?.larkTask ?? null);

  banner('5. Direct permission check on supervisor-v2 runtime');
  const { ensureActionPermission } = await import('../src/company/orchestration/vercel/legacy-tools');
  const { toCanonicalToolId } = await import('../src/company/tools/canonical-tool-id');
  const v2Verdict = ensureActionPermission(runtime, toCanonicalToolId('larkTask'), 'create' as any);
  console.log(v2Verdict === null
    ? '  ✅ supervisor-v2 path: PASS'
    : `  ❌ supervisor-v2 path: DENIED → ${v2Verdict.summary}`);

  // ── 5b. Now mimic the LEGACY supervisor path (vercel-orchestration.engine.ts) ──
  // The execution payload from the failing live run included `eligibleAgentIds`,
  // a field that ONLY appears in the legacy supervisor (vercel-orchestration.engine.ts).
  // So the actual run is taking THAT path, not supervisor-v2. The legacy path does
  // step-level delegation via `runStep` which builds a fresh `stepAllowedActionsByTool`
  // from `ensureAllowedActionsByTool({companyId, requesterAiRole, allowedToolIds: familyToolIds})`
  // — IGNORING the department-resolved `allowedActionsByTool` on effectiveRuntime.
  //
  // Reproduce that exactly here:
  banner('5b. Legacy supervisor step delegation (the actual failing path)');
  const familyToolIds = ['larkTask']; // matches getRequiredToolIdsForSupervisorStep for create_task

  // Replicate the buggy call: no allowedActionsByTool passed → falls through to company-level.
  const stepAllowedActionsByTool = await toolPermissionService.getAllowedActionsByTool(
    runtime.companyId,
    runtime.requesterAiRole,
    familyToolIds,
  );
  dim('familyToolIds', familyToolIds);
  dim('stepAllowedActionsByTool', stepAllowedActionsByTool);

  const stepRuntime = {
    ...runtime,
    allowedToolIds: familyToolIds,
    allowedActionsByTool: stepAllowedActionsByTool,
    delegatedAgentId: 'lark-ops-agent',
    runExposedToolIds: familyToolIds,
  } as unknown as VercelRuntimeRequestContext;

  const legacyVerdict = ensureActionPermission(stepRuntime, toCanonicalToolId('larkTask'), 'create' as any);
  console.log(legacyVerdict === null
    ? '  ✅ legacy step path: PASS'
    : `  ❌ legacy step path: DENIED → ${legacyVerdict.summary}`);

  console.log('\n────────────────────────────────────────────────────────────');
  if (v2Verdict === null && legacyVerdict === null) {
    console.log('🤔 BOTH paths PASS. Bug must be in some narrower runtime modification');
    console.log('   between the engine and ensureActionPermission. Time to add an');
    console.log('   instrumentation log to the live runtime to capture the exact state.');
  } else {
    console.log('✅ Bug REPRODUCED — fix the failing path.');
  }
  console.log('────────────────────────────────────────────────────────────');

  // Also explicitly print what the runtime's permission map looks like for larkTask.
  banner('6. Final state inspection');
  dim('runtime.companyId', runtime.companyId);
  dim('runtime.requesterAiRole', runtime.requesterAiRole);
  dim('runtime.departmentId', (runtime as any).departmentId);
  dim('runtime.departmentRoleSlug', (runtime as any).departmentRoleSlug ?? null);
  dim('runtime.allowedToolIds.includes(larkTask)', runtime.allowedToolIds.includes('larkTask'));
  dim('runtime.allowedActionsByTool[larkTask]', (runtime as any).allowedActionsByTool?.larkTask ?? null);

  // Optional: also try the OTHER aliases that might be in the map
  const alts = ['larkTask', 'lark-task-write', 'lark-task-agent'];
  for (const alt of alts) {
    dim(`runtime.allowedActionsByTool[${alt}]`, (runtime as any).allowedActionsByTool?.[alt] ?? null);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
