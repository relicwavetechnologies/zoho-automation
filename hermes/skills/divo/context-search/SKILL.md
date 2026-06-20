---
name: context-search
description: "Divo company context retrieval: use context_search and document_rag with correct source flags, citations, and follow-up reads."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Context Search, RAG, Documents, Citations, Retrieval]
    requires_toolsets: [rag]
---

# Context Search

Use this skill when the user asks a question that may require company knowledge, indexed documents, CRM context, Lark contacts, or web-backed context.

This is a multi-step retrieval workflow. Use the native tools. Do not grep local files or search the web first unless the context tool requests web or the user specifically asks for public web research.

## Native Tools

- `context_search`
- `document_rag`

## `context_search`

Use when the answer could come from multiple company sources.

Parameters:

```json
{
  "query": "natural language question",
  "limit": 5,
  "sources": {
    "files": true,
    "zoho_crm": true,
    "lark_contacts": true,
    "web": false
  }
}
```

Current Hermes source flags:

- `files`
- `zoho_crm`
- `lark_contacts`
- `web`

Legacy Advance Backend had more source flags (`personalHistory`, `zohoBooksLive`, `workspace`, `skills`, dates, site). Do not pass those until Hermes ports them into `context_search`.

## `document_rag`

Use when the user is clearly asking about indexed files/documents only.

Operations:

- `op="search"` with `query`, optional `fileAssetId`, `limit`
- `op="read_full"` with `fileAssetId`
- `op="list_files"`

## Retrieval Pattern

1. Start with `context_search` for broad company questions.
2. Inspect returned citations and `nextFetchRefs`.
3. If the user asks for exact wording, policy clauses, contract terms, or complete contents, use `document_rag` `read_full` with the relevant `fileAssetId`.
4. When results disagree, prefer higher-authority internal documents over web snippets.
5. Cite source labels/URLs/file names in the final answer.

## Source Selection

- People/contact question: set `lark_contacts=true`.
- Company docs/policies/contracts: set `files=true`.
- CRM/customer/account context: set `zoho_crm=true`.
- Public current info: set `web=true`.
- Unknown or mixed: use `files=true`, `zoho_crm=true`, `lark_contacts=true`, `web=false`.

## Failure Handling

- `no_company_scope`: say company context is unavailable in this session.
- `rag_unavailable`: say Divo context search is not configured or indexed yet.
- No results: say no relevant company context was found and ask whether to search public web or a specific connector.

## Final Response

Answer with:

- concise answer
- citations/source labels
- uncertainty if results are partial
- next action if a deeper read is needed
