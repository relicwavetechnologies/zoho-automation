# Lark Company Config And Verification Isolation

## Why This Task Exists
Lark verification data is company-specific. Storing it in global env is operationally wrong for a multi-company system and weakens tenant isolation.

## Current State
1. Webhook processing can resolve tenant/company identity.
2. Verification still relies on env-based token/secret resolution in the current runtime.
3. There is no complete company-scoped workspace config store wired into verification flow.

## In Scope
1. Add persisted company-scoped Lark workspace config with encrypted secrets.
2. Resolve company config before signature/token verification.
3. Keep env fallback only when company config is absent.
4. Add admin API and UI surface to manage workspace config.
5. Preserve tenant-binding enforcement behavior for unmapped tenants.

## Out of Scope
1. Full Lark directory sync.
2. Role enrichment logic.
3. Broader multi-channel configuration redesign.

## Dependencies
None, but schema work should land before task 26.

## Deliverables
1. Schema/model for company-scoped Lark workspace config.
2. Verification flow updated to use tenant->company->config resolution.
3. Admin CRUD surface for Lark company config.
4. Tests for company config resolution and env fallback behavior.

## Exit Criteria
Webhook verification is tenant-aware and company-isolated by default.
