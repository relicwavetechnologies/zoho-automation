interface RecipeContext {
  readonly userConnection: string;
  readonly governedRouting: string;
}

export function larkMessagingMarkdown(context: RecipeContext): string {
  return `# Lark Messaging

\`larkMessaging\` exposes no reactions, pins, message edit/delete/forward, file or image sending, group administration, announcements, or moderation.

${context.userConnection}
- Send only when explicitly asked and the recipient or destination is identified.
- Resolve an explicitly named group with \`list_chats\`. Never search chats or message history to infer a missing destination; ask the member.
- Exact mention IDs are valid only from the current structured inbound turn; never infer or reuse IDs from prose.
- Pending or rejected approval means the message was not sent.
- ${context.governedRouting}`;
}

export function larkContactsMarkdown(governedRouting: string): string {
  return `# Lark Contacts

\`larkContacts\` resolves people and lists a department. Full user, department, group, job, and unit administration is not exposed.

- Return all plausible candidates for an ambiguous name; never pick silently.
- Treat IDs as internal routing values. Never include that block or any Lark ID in user-facing output.
- Prefer the person's name, email, job title, department names, and organization when available. Omit fields the governed directory did not return.
- ${governedRouting}`;
}

export function larkBaseMarkdown(context: RecipeContext): string {
  return `# Lark Base

\`larkBase\` reads and writes records. App, table, field, view, form, dashboard, role, workflow, and batch administration are not exposed.

${context.userConnection}
- Read before updating when the record is unclear.
- Preserve typed fields and never guess field names or record IDs.
- Confirm a mutation only after tool success and final approval.
- ${context.governedRouting}`;
}

export function larkApprovalsMarkdown(governedRouting: string): string {
  return `# Lark Approvals

\`larkApproval\` inspects and creates approval instances. Approval actions, comments, CC, cancel/recall/remind, rollback, subscriptions, and external approvals are not exposed — an approval Divo created still has to be acted on inside Lark.

- Submit only confirmed form values.
- Pending, rejected, denied, or misconfigured actions are not successful submissions.
- ${governedRouting}`;
}
