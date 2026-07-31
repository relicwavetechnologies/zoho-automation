interface RecipeContext {
  readonly userConnection: string;
  readonly governedRouting: string;
}

export function larkDocumentsMarkdown(context: RecipeContext): string {
  return `# Lark Documents

Use this skill for Lark documents, native document checklists, rich block formatting, tables, sharing, and the currently implemented Drive organization operations.

## Implemented operations

\`get\`, \`create\`, \`list_blocks\`, \`append_block\`, \`append_blocks\`, \`update_block\`, \`update_block_style\`, \`delete_block\`, \`insert_table\`, \`share\`, \`get_metadata\`, \`list_files\`, \`create_folder\`, \`copy_file\`, \`move_file\`, \`check_drive_task\`.

These are the complete operations currently exposed by \`larkDoc\`. This skill does not provide uploads, downloads, comments, versions, subscriptions, imports, exports, Drive deletion, or arbitrary SDK execution.

## Connection

${context.userConnection}
- If several accounts are returned and the member did not identify one, ask which account to use.
- ${context.governedRouting}

## Document recipe

1. Create only when asked. Preserve the returned \`docToken\` and canonical \`url\`; never construct a URL.
2. Prefer one \`append_blocks\` call for an ordered section. Use \`append_block\` for a single addition.
3. Supported native blocks are text, headings 1–9, bullet, ordered, code, quote, todo, and divider.
4. Use \`textStyle\` only for supported inline formatting and \`blockStyle\` for alignment, todo completion, folding, code settings, backgrounds, or indentation.
5. For an existing block, call \`list_blocks\` first, then use \`update_block\`, \`update_block_style\`, or \`delete_block\` with the exact block ID.
6. Keep tables within 9 rows by 9 columns for the current Docx block-create route. Supply headers and body data inside \`insert_table\`.

## Native document todos

- “Todos/checklist in this document” means \`todo\` blocks, not Task v2 tasks.
- Use \`append_blocks\` with \`blockType: "todo"\`. Never imitate checkboxes with bullets or emoji.
- Use \`update_block_style\` with \`done\` to change completion state.
- Create separate Lark tasks only when the member asks for tasks in their task list.

## Drive organization recipe

- Use \`get_metadata\` with the exact file token and matching provider file type.
- Use \`list_files\` for a folder or Drive root and preserve provider pagination.
- Use \`create_folder\`, \`copy_file\`, and \`move_file\` only for those actions. Names are limited to 256 UTF-8 bytes.
- A successful \`move_file\` means the move was accepted, not necessarily completed. When Lark returns \`task_id\`, poll only with \`check_drive_task\` and report completion only from its successful terminal status.

## Truthfulness

- Never claim a document, block, folder, copy, share, or completed move without the corresponding successful tool result.
- If document creation returns no URL, report that creation succeeded but no canonical link was returned.
- Respect Divo RBAC, connection selection, and approval results exactly.`;
}
