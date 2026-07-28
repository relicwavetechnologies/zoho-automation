interface RecipeContext {
  readonly userConnection: string;
  readonly governedRouting: string;
}

export function larkMessagingMarkdown(context: RecipeContext): string {
  return `# Lark Messaging

## Implemented operations

\`send\`, \`list\`, \`reply\`, \`send_dm\`, \`list_chats\`, \`search\`, \`mention\`.

Reactions, pins, message update/delete/forward, file/image management, group administration, announcements, tabs, and moderation are not exposed.

${context.userConnection}
- Send only when explicitly asked and the recipient or destination is identified.
- Resolve a group with \`list_chats\`. Search is bounded to recent history; do not claim full server-side search.
- Exact mention IDs are valid only from the current structured inbound turn; never infer or reuse IDs from prose.
- Pending or rejected approval means the message was not sent.
- ${context.governedRouting}`;
}

export function larkContactsMarkdown(governedRouting: string): string {
  return `# Lark Contacts

## Implemented operations

\`lookup\`, \`list_department\`.

Full user, department, group, job, and unit administration is not exposed.

- Return all plausible candidates for ambiguous names; never pick silently.
- Treat IDs as internal routing values. Never include that block or any Lark ID in user-facing output.
- Prefer the person's name, email, job title, department names, and organization when available. Omit fields the governed directory did not return.
- ${governedRouting}`;
}

export function larkBaseMarkdown(context: RecipeContext): string {
  return `# Lark Base

## Implemented operations

\`list_records\`, \`get_record\`, \`create_record\`, \`update_record\`, \`delete_record\`, \`search_records\`.

App, table, field, view, form, dashboard, role, workflow, and batch administration are not exposed.

${context.userConnection}
- Require exact app and table identifiers. Read before updating when the record is unclear.
- Preserve typed fields and never guess field names or record IDs.
- Confirm a mutation only after tool success and final approval.
- ${context.governedRouting}`;
}

export function larkApprovalsMarkdown(governedRouting: string): string {
  return `# Lark Approvals

## Implemented operations

\`list\`, \`get\`, \`get_definition\`, \`create\`.

Approval actions, comments, CC, cancel/recall/remind, rollback, subscriptions, and external approvals are not exposed.

- Read a definition before creation when required fields are unknown.
- Submit only confirmed form values.
- Pending, rejected, denied, or misconfigured actions are not successful submissions.
- ${governedRouting}`;
}
