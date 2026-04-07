import { resolveSupervisorAgentToolIds } from '../src/company/orchestration/supervisor/agent-registry';
import { createVercelDesktopTools } from '../src/company/orchestration/vercel/tools';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../src/company/orchestration/vercel/types';
import { ALIAS_TO_CANONICAL_ID, DOMAIN_TO_TOOL_IDS, TOOL_REGISTRY_MAP } from '../src/company/tools/tool-registry';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const activeDomainTools = (domain: string): string[] =>
  (DOMAIN_TO_TOOL_IDS[domain] ?? []).filter((toolId) => TOOL_REGISTRY_MAP.get(toolId)?.deprecated !== true);

const runtime: VercelRuntimeRequestContext = {
  threadId: 'p4-thread',
  executionId: 'p4-exec',
  companyId: 'p4-company',
  userId: 'p4-user',
  requesterAiRole: 'COMPANY_ADMIN',
  mode: 'fast',
  allowedToolIds: [
    'zohoBooks',
    'zohoCrm',
    'larkTask',
    'googleWorkspace',
    'documentRead',
    'workflow',
    'devTools',
    'contextSearch',
    'outreach',
    'larkBase',
    'larkCalendar',
    'larkApproval',
    'larkMessage',
    'larkDoc',
    'larkMeeting',
    'zoho-books-read',
    'zoho-books-write',
    'zoho-books-agent',
    'search-zoho-context',
    'read-zoho-records',
    'zoho-read',
    'zoho-agent',
    'zoho-write',
    'lark-task-read',
    'lark-task-write',
    'lark-task-agent',
  ],
};

const hooks: VercelRuntimeToolHooks = {
  onToolStart: async () => {},
  onToolFinish: async () => {},
};

const main = async () => {
  const activeZohoBooks = activeDomainTools('zoho_books');
  assert(activeZohoBooks.includes('zohoBooks'), 'zoho_books domain should expose canonical zohoBooks');
  assert(!activeZohoBooks.includes('zoho-books-read'), 'zoho_books domain should not expose deprecated zoho-books-read');

  const zohoAgentTools = resolveSupervisorAgentToolIds({
    agentId: 'zoho-ops-agent',
    allowedToolIds: runtime.allowedToolIds,
  });
  assert(zohoAgentTools.includes('zohoBooks'), 'zoho-ops-agent should receive canonical zohoBooks');
  assert(!zohoAgentTools.includes('zoho-books-read'), 'zoho-ops-agent should not receive deprecated zoho-books-read');
  console.log('PASS canonical tool surface prefers zohoBooks over zoho-books-read');

  const toolMap = createVercelDesktopTools(runtime, hooks);
  assert(toolMap.zohoBooks, 'canonical zohoBooks wrapper should exist');
  assert(toolMap.larkTask, 'canonical larkTask tool should exist');
  assert(toolMap.devTools, 'canonical devTools wrapper should exist');

  const overdueResult = await toolMap.zohoBooks.execute({ operation: 'buildOverdueReport' });
  assert(typeof overdueResult?.summary === 'string', 'zohoBooks should return an envelope');
  assert(
    !overdueResult.summary.includes('requires a supported Zoho Books module'),
    'zohoBooks buildOverdueReport should route to overdue handler, not generic module validation',
  );
  console.log('PASS zohoBooks wrapper routes buildOverdueReport without falling into generic module validation');

  const larkTaskResult = await toolMap.larkTask.execute({
    operation: 'write',
    summary: 'Create a task for Anish',
  });
  assert(typeof larkTaskResult?.summary === 'string', 'larkTask write should return an envelope');
  assert(!larkTaskResult.summary.toLowerCase().includes('unsupported'), 'larkTask write should route into existing task handler');
  console.log('PASS larkTask wrapper accepts write and routes into the existing task workflow');

  assert(ALIAS_TO_CANONICAL_ID['zoho-books-read'] === 'zohoBooks', 'old zoho-books-read alias should resolve to zohoBooks');
  assert(ALIAS_TO_CANONICAL_ID['search-zoho-context'] === 'zohoCrm', 'old search-zoho-context alias should resolve to zohoCrm');
  console.log('PASS old learned-prior aliases resolve to canonical tool ids');

  console.log('All 4 P4 consolidation harness cases passed.');
};

void main();
