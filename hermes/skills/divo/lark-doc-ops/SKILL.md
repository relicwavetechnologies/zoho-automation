---
name: lark-doc-ops
description: "Create, read, edit, append, and share Lark Docs with correct markdown import and URL handling."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Docs, Markdown, Wiki, Document URLs]
    requires_toolsets: [lark]
---

# Lark Doc Ops

Use this skill for Lark/Feishu documents, pages, notes, specs, meeting notes, task docs, and wiki/doc links.

## Native Tool

Use `lark_doc`.

Supported operations:

- `create_markdown`
- `create`
- `get`
- `list_blocks`
- `append_markdown`
- `append_block`
- `update_block`
- `delete_block`
- `insert_table`
- `share`

## Create Polished Docs

For new content-rich documents, always prefer:

```json
{
  "op": "create_markdown",
  "title": "Document Title",
  "markdown": "# Document Title\n\n## Summary\n...\n\n## Action Items\n- ...\n\n| Area | Owner | Status |\n| --- | --- | --- |\n| ... | ... | ... |"
}
```

Do not create a blank doc and then append paragraphs unless the user explicitly asked for a blank document.

## Markdown Rules

- Include a top-level `# Title`.
- Use normal markdown headings, bullets, numbered lists, and tables.
- Keep tables simple: header row, separator row, plain text cells.
- Avoid HTML unless the user provided it.
- If markdown import fails, retry with simpler markdown before giving up.

## Existing Docs

- Read: `op="get"` with `docToken`.
- Append: `op="append_markdown"` with `docToken` and `markdown`.
- Precise edit:
  1. `op="list_blocks"`
  2. choose the block id
  3. `op="update_block"` or `op="delete_block"`

## URL Handling

Created/read docs should return one of:

- `url`
- `docUrl`
- `docToken`
- `urlHint`

Always report the URL if present. If only `docToken` is present, report the token and say Lark metadata did not return a clickable URL.

## Final Response

Keep it short:

- title
- URL or doc token
- what changed
