/** Friendly status-card labels shown during each supervisor tool call. */
export const STATUS_LABELS: Record<string, string> = {
  larkAgent:            '📋 Working on Lark…',
  googleAgent:          '📧 Working on Google Workspace…',
  zohoAgent:            '💼 Checking Zoho…',
  contextAgent:         '🔍 Searching…',
  manageTodos:          '📌 Updating todos…',
  scheduleTask:         '⏰ Scheduling task…',
  listScheduledTasks:   '📅 Fetching schedules…',
  cancelScheduledTask:  '🗑 Cancelling schedule…',
  runScheduledTaskNow:  '▶️ Triggering now…',
};

export function getLabelForTool(toolName: string): string {
  return STATUS_LABELS[toolName] ?? '🤖 Working…';
}
