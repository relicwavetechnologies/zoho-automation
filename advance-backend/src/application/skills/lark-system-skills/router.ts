export function createLarkRouterSkill(governedRouting: string) {
  return {
    slug: 'lark-router',
    name: 'Lark Capability Router',
    summary: 'Route a Lark request to the exact approved family skill before loading any executable tool.',
    toolIds: [],
    tags: ['lark', 'router', 'capabilities'],
    aliases: ['lark', 'feishu', 'lark sdk', 'lark operations'],
    sortOrder: 1,
    markdown: `# Lark Capability Router

Use this skill only to choose the next Lark family skill. It has no executable tools.

## Route

- Documents, document checklists, formatting, tables, sharing, or Drive organization → load \`lark-documents\`.
- Tasks, reminders, subtasks, or tasklists → load \`lark-tasks\`.
- Calendar events, attendees, recurrence, or availability → load \`lark-calendar\`.
- Historical video meetings or recordings → load \`lark-meetings\`.
- Messages, replies, chats, history search, or mentions → load \`lark-messaging\`.
- People or department lookup → load \`lark-contacts\`.
- Base records → load \`lark-base\`.
- Native approvals → load \`lark-approvals\`.

Load the selected family skill before calling a Lark tool. If the destination of “add todos” is unclear, ask whether the member means native checklist blocks inside a document or separate Task v2 tasks.

${governedRouting}`,
  } as const;
}
