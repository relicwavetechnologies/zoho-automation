# Context

## Task
- 20 - Company Admin Users Invites And Onboarding UI

## Objective
- Implement company-admin screens for user management, invites, and Zoho onboarding controls in one operational hub.

## Dependency
- 17-react-admin-dashboard-foundation, 18-admin-rbac-management-ui-and-api, 13-company-onboarding-zoho-connect, 14-async-historical-zoho-to-vectordb

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- Company onboarding and user access operations should be centrally managed in admin dashboard.
- Zoho connection and sync status must be visible and actionable from UI.

## V0 Architecture Slice For This Task
- Build screens for members, invites, and onboarding integration state.
- Show async historical sync progress and current status from backend.

## DTO Focus For This Task
- InviteDTO, MemberDTO, ZohoConnectionDTO, IngestionJobDTO.

## State Sync Rules (No Deviation)
- Invite actions and onboarding controls must call authorized backend APIs.
- UI status for sync progress must be derived from backend polling/stream endpoint.

## Expected Code Touchpoints
- dashboard pages/components for users/invites/onboarding
- backend APIs for invite and onboarding status

## Execution Steps
- Build members and invites pages with actions.
- Build onboarding panel for Zoho connect/disconnect and sync status.
- Add state refresh and error handling for async sync operations.

## Validation
- Company-admin can invite/manage users.
- Company-admin can connect Zoho and view async historical sync status.
- Errors are displayed clearly and logged.

## Definition Of Done
- Company-admin operational workflows run fully from dashboard.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not implement unrelated analytics views in this task.

## Anti-Hallucination Rules
- Do not expose controls to unauthorized roles.
- Do not fake sync progress client-side without backend source.
