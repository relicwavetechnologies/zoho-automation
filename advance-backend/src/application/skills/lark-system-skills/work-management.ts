interface RecipeContext {
  readonly userConnection: string;
  readonly governedRouting: string;
}

export function larkTasksMarkdown(context: RecipeContext): string {
  return `# Lark Tasks

Use this skill for separate Task v2 tasks, follow-ups, assignments, subtasks, and tasklists. Native checklist blocks inside a document belong to \`lark-documents\`.

\`larkTask\` exposes no collaborators, followers, reminders, comments, attachments, sections, or activity subscriptions.

${context.userConnection}
- Preserve the requested title. Set assignees only for explicit assignment; a person named in a meeting title is not an assignee.
- Use \`assignToMe\` for “me”. Include a due date only when given or confirmed.
- Read the task before a destructive or ambiguous update.
- Never claim completion while approval is pending.
- ${context.governedRouting}`;
}

export function larkCalendarMarkdown(context: RecipeContext): string {
  return `# Lark Calendar

\`larkCalendar\` exposes no calendar discovery, ACLs, subscriptions, event replies, meeting minutes, or room reservations.

${context.userConnection}
- Use explicit ISO start and end times with timezone offsets. Assume a 30-minute duration only when the member gave none.
- A person's open ID is not a calendar ID. Use \`free_busy\` for availability.
- Change attendees with \`update_attendees\` rather than recreating the event.
- Confirm title, local date/time, timezone, and attendees only after tool success.
- ${context.governedRouting}`;
}

export function larkMeetingsMarkdown(context: RecipeContext): string {
  return `# Lark Meetings

This capability reads historical meetings. It cannot manage participants, create reservations, or retrieve reports and alerts.

${context.userConnection}
- Return only the exact recording URL Lark supplied. A meeting with no recording is a valid outcome, not a failure to report as one.
- ${context.governedRouting}`;
}
