---
name: lark-base-ops
description: "Operate Lark Base/Bitable records with native lark_base."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Base, Bitable, Records]
    requires_toolsets: [lark]
---

# Lark Base Ops

Use this skill for Lark Base/Bitable record CRUD.

## Native Tool

Use `lark_base`.

Supported operations:

- `list_records`
- `get_record`
- `create_record`
- `update_record`
- `delete_record`
- `search_records`

## Required IDs

Most calls require:

- `appToken`
- `tableId`

Do not invent these. If the user gives a Base URL, extract or ask for the app/table identifiers if the native tool cannot infer them.

## Parameters

- Create/update: pass `fields` as an object matching Base field names.
- Search: use `fieldName` and `filterValue`.
- Get/update/delete: use `recordId`.

## Final Response

Report record id and changed fields. For destructive deletes, only say deleted when `success: true`.
