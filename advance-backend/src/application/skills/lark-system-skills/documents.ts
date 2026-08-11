interface RecipeContext {
  readonly userConnection: string;
  readonly governedRouting: string;
}

export function larkDocumentsMarkdown(context: RecipeContext): string {
  return `# Lark Documents

Use this skill for Lark documents, native document checklists, rich block formatting, tables, sharing, and the currently implemented Drive organization operations.

\`larkDoc\` exposes no uploads, downloads, comments, versions, subscriptions, imports, exports, or Drive deletion. Say that plainly instead of describing a workaround for one.

## Connection

${context.userConnection}
- ${context.governedRouting}

## Document recipe

1. Create only when asked. Preserve the returned \`docToken\` and canonical \`url\`; never construct a URL yourself.
2. Before touching an existing block, call \`list_blocks\` and work from the exact block ID it returns.
3. Keep tables within 9 rows by 9 columns — the current Docx block-create route accepts no more.

## Native document todos

- “Todos/checklist in this document” means \`todo\` blocks inside the document. Create separate Lark tasks only when the member asks for tasks in their task list, which is \`lark-tasks\`.

## Drive organization recipe

- Preserve provider pagination when listing a folder or the Drive root; a first page is not the folder.
- A successful \`move_file\` means the move was accepted, not that it finished. When Lark returns \`task_id\`, poll only with \`check_drive_task\` and report completion only from its successful terminal status.

## Truthfulness

- Never claim a document, block, folder, copy, share, or completed move without the corresponding successful tool result.
- If document creation returns no URL, report that creation succeeded but no canonical link was returned.
- Respect Divo RBAC, connection selection, and approval results exactly.`;
}
