---
name: lark-approval-ops
description: "Query and create Lark Approval instances and current-user approval inbox items."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Approvals, Workflow]
    requires_toolsets: [lark]
---

# Lark Approval Ops

Use this skill for Lark/Feishu approvals, approval inbox, initiated approvals, and approval instance status.

## Native Tool

Use `lark_approval`.

Supported operations:

- `listPendingMine`
- `listInitiatedPending`
- `list`
- `get`
- `create`

## Rules

- Current user's pending approvals: `op="listPendingMine"`.
- Current user's initiated pending approvals: `op="listInitiatedPending"`.
- List instances for a definition: `op="list"` with `approvalCode`.
- Get one instance: `op="get"` with `approvalCode` and `instanceCode`.
- Create: `op="create"` with `approvalCode` and `formValues`.

## Boundary

Approvals are not Lark Tasks. If the user says approval/request/sign-off workflow, use this tool. If they say todo/action item, use `lark-task-ops`.

## Final Response

Report approval title/status and `instanceCode` or `approvalCode`.
