const LIVE_SUPERVISOR_CAPABILITY_LINES = [
  '`planner-agent` plans only. Use it for multi-step, cross-domain, or order-dependent work. It does not execute tasks.',
  '`zoho-agent` handles grounded Zoho CRM reads such as deals, contacts, tickets, leads, pipeline health, and risk summaries.',
  '`outreach-agent` handles outreach inventory and SEO publisher filtering.',
  '`search-agent` handles current external web research, exact-site lookup, docs-style crawl/retrieval, and internal uploaded document search when the request is about company files or policies.',
  '`lark-base-agent` handles Lark Base record reads and writes when the Base app token and table ID are available.',
  '`lark-task-agent` handles Lark task listing, creation, and updates.',
  '`lark-doc-agent` handles Lark Docs creation and editing only after the required research or CRM work is already grounded.',
  'Current live Lark action coverage includes Lark Docs, Lark Base, and Lark Tasks. Calendar, VC/Meetings, Minutes, and approval actions are not yet live in this tool layer.',
];

const LIVE_PLANNER_OWNER_GUIDE_LINES = [
  'Supported `ownerAgent` values right now: `supervisor`, `zoho`, `outreach`, `search`, `larkBase`, `larkTask`, `larkDoc`, `workspace`, `terminal`.',
  'Use `supervisor` for orchestration, synthesis, adaptation, or any reasoning step that does not map to a live specialist.',
  'Use `larkBase` for Lark Base record work.',
  'Use `larkTask` for Lark Tasks work.',
  'Use `larkDoc` only for Lark Docs creation or edit/export steps.',
  'Do not create plan tasks for unsupported Lark surfaces such as Calendar, Meetings, Minutes, or approvals until dedicated specialists exist.',
  'Never emit a non-listed ownerAgent value.',
];

export const buildLiveSupervisorCapabilityLines = (): string[] => [...LIVE_SUPERVISOR_CAPABILITY_LINES];

export const buildPlannerOwnerGuideLines = (): string[] => [...LIVE_PLANNER_OWNER_GUIDE_LINES];
