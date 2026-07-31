interface RecipeContext {
  readonly userConnection: string;
  readonly governedRouting: string;
}

export function larkTasksMarkdown(context: RecipeContext): string {
  return `# Lark Tasks

Use this skill for separate Task v2 tasks, follow-ups, assignments, subtasks, and tasklists. Native checklist blocks inside a document belong to \`lark-documents\`.

## Implemented operations

\`create\`, \`update\`, \`complete\`, \`delete\`, \`list\`, \`listMine\`, \`listOpenMine\`, \`get\`, \`list_tasklists\`, \`create_tasklist\`, \`add_to_tasklist\`, \`remove_from_tasklist\`, \`list_subtasks\`, \`create_subtask\`.

No collaborators, followers management, reminders API, comments, attachments, sections, or activity subscriptions are exposed beyond the fields and operations above.

${context.userConnection}
- Preserve the requested title. Set assignees only for explicit assignment; a person in a meeting title is not automatically an assignee.
- Use \`assignToMe\` for “me”. Include a due date only when given or confirmed.
- Read the task before a destructive or ambiguous update.
- Never claim completion while approval is pending.
- ${context.governedRouting}`;
}

export function larkCalendarMarkdown(context: RecipeContext): string {
  return `# Lark Calendar

## Implemented operations

\`list\`, \`get\`, \`create\`, \`update\`, \`delete\`, \`free_busy\`, \`list_attendees\`, \`create_recurring\`, \`update_attendees\`.

Calendar discovery, ACLs, subscriptions, event replies/instances, meeting minutes, and room reservations are not exposed.

${context.userConnection}
- Use explicit ISO start and end times with timezone offsets. Use a 30-minute duration only when omitted.
- Use \`free_busy\` for availability; a person's open ID is not a calendar ID.
- Use \`create_recurring\` with an explicit recurrence rule for repeating meetings.
- Use \`update_attendees\` for attendee changes rather than recreating an event.
- Confirm title, local date/time, timezone, and attendees only after tool success.
- ${context.governedRouting}`;
}

export function larkMeetingsMarkdown(context: RecipeContext): string {
  return `# Lark Meetings

## Implemented operations

\`search\`, \`get\`, \`get_recording\`.

This capability is read-only. It cannot join or control live meetings, manage participants, create reservations, or retrieve unsupported reports and alerts.

${context.userConnection}
- Use \`search\` for a bounded historical lookup, \`get\` for a known meeting ID, and \`get_recording\` for a known meeting ID.
- Return only the exact recording URL supplied by Lark. A missing recording is a valid outcome.
- ${context.governedRouting}`;
}
