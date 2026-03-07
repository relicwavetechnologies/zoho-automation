# Lark Directory Sync And Role Bootstrap

## Why This Task Exists
The product needs company-scoped user identity sync from Lark so routing, role enforcement, and per-user behavior do not rely on partial or manual state.

## Current State
1. Some Lark identity handling exists in the codebase.
2. The V1 contract for connect-triggered, nightly, and manual sync is not fully restored.
3. Persisted sync run tracking and admin visibility are incomplete.
4. Role bootstrap from Lark signals is not fully reliable.

## In Scope
1. Add company-scoped Lark user sync service and persisted sync run records.
2. Trigger sync on connect/setup completion, nightly scheduler, and manual admin action.
3. Upsert `ChannelIdentity` with Lark user metadata.
4. Bootstrap AI role defaults from Lark admin/manager signals when available.
5. Expose sync status, last run, counts, and diagnostics in admin UI.

## Out of Scope
1. Fine-grained access control beyond default role bootstrap.
2. Card-based approval UX.
3. Non-Lark identity providers.

## Dependencies
25-lark-company-config-and-verification-isolation

## Deliverables
1. Sync service, scheduler, and admin trigger/status endpoints.
2. Persisted sync run model and diagnostics.
3. Role bootstrap mapping with tests.
4. Admin UI sync controls and status surface.

## Exit Criteria
Lark user directory sync is repeatable, visible, and company-scoped.
