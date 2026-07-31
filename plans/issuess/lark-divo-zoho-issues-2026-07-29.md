# Divo issues extracted from Lark

Date reviewed: 2026-07-29
Issue window: 2026-07-29 only

## Evidence coverage

- `oc_b20894f2a5fb46db0a6f6e22895d0dfc`: all 1,871 messages across 38 pages inspected. Divo was invited on 2026-07-29; its only conversation thread was expanded fully.
- `oc_e00314b99ce6778ee14134052b35311c`: all 29 July messages, Divo threads, and standalone bot responses inspected.
- The MASNOTECHNO verification screenshot was downloaded and inspected. It shows two bills as `OVERDUE BY 53 DAYS`.
- Deleted or unsupported message bodies were not treated as evidence unless a later visible message independently described the failure.
- Older March–June findings are intentionally excluded from this backlog.

## DIVO-001 — Zoho bill status and balance are materially incorrect

Priority: P0  
Status: Open

### Evidence

- Chat: `oc_e00314b99ce6778ee14134052b35311c`
- Thread: `omt_190c6d15b6cf5983`
- Request: `om_x100b69aa130480a4e2f5ffd862f0ee1`
- Incorrect response: `om_x100b69aa2bc0753ce16cd56e6e68bc0`
- Human correction and screenshot: `om_x100b69aa3a9988ace2f6a75ded91fe9`
- Repeated incorrect response: `om_x100b69aa38bc78a8e2ec99a64e1f1b8`

### Observed

Divo reported all four MASNOTECHNO bills as paid with ₹0 outstanding. The Zoho screenshot shows:

- `MM/DA/2026/066`: ₹99,590.25, overdue by 53 days.
- `MM/DA/2026/067`: ₹5,065.36, overdue by 53 days.
- Only `MM/DA/2026/004` and `MM/DA/2026/005` are paid.

After the correction, Divo repeated the paid/₹0 result. Its execution trace also contained a Zoho authentication failure during the retry.

### Expected

Divo must return the same current status and balance shown by the authoritative Zoho record and must not confidently answer after contradictory provider results or an authentication failure.

### Acceptance criteria

- A regression query for MASNOTECHNO identifies 2 paid and 2 overdue bills.
- The outstanding total includes ₹99,590.25 and ₹5,065.36.
- Organization and record IDs are retained through lookup and status normalization.
- Conflicting provider fields or partial authentication failures produce a bounded error, not a confident financial answer.

## DIVO-002 — Export reports success before the job fails and never delivers a file

Priority: P0  
Status: Open

### Evidence

- Chat: `oc_e00314b99ce6778ee14134052b35311c`
- Thread: `omt_190c337e920f19b9`
- Export request: `om_x100b69aa78e1d0a4e1899bb8ecf3f1e`
- Premature success response: `om_x100b69aa788850a0e126fa9667af2be`
- Terminal failure card: `om_x100b69aa79ea88a4e2f897316eca06e`
- Related trace: `om_x100b69aa790eb4a8e2f96fb3fb50358`

### Observed

Divo said “Export queued successfully” and promised a Google Sheet within one or two minutes. The chat then received `Data export transform sandbox stopped unexpectedly`, with no sheet. A related retry failed validation because `source.connectionId` was missing.

### Expected

Queued is not delivered. The user should receive exactly one terminal outcome: a working artifact/link or a clear failed result with a retry path.

### Acceptance criteria

- The export worker receives the resolved Zoho `connectionId`.
- A queued export transitions durably to delivered or failed.
- Transform sandbox failures are retried safely or use a bounded fallback.
- The success message is emitted only after delivery, or is explicitly labelled as non-terminal progress.
- A focused test covers queue success followed by worker failure without contradictory user messages.

## DIVO-003 — Lark directory sync does not create department membership, blocking shared Zoho connections

Priority: P1  
Status: Systemic issue open; Chetan repaired manually on 2026-07-29

### Evidence

- Chat: `oc_e00314b99ce6778ee14134052b35311c`
- Thread: `omt_190c6d15b6cf5983`
- Access failure: `om_x100b69aa13117ca0e2c59991027333a`
- Human report: `om_x100b69aa2d9f74a0e155fc79e7a56dc`
- Backend diagnosis: Chetan existed as a user and Lark identity but had no `DepartmentMembership` or `UserDepartmentPreference`.

### Observed

The Zoho connections were shared with Finance, but Chetan's Lark directory department was not represented in the backend. Connection resolution therefore returned no accessible Zoho connection.

The current directory sync reads `departmentNames` from Lark but only upserts `ChannelIdentity`, `User`, and `AdminMembership`.

### Expected

An active Lark Finance user should be mapped to the existing Finance department and its default role without a manual database repair.

### Acceptance criteria

- Directory sync maps unambiguous Lark department names to existing company departments.
- It upserts active membership using the department's default role.
- It sets an active department only when selection is unambiguous and does not overwrite an intentional user choice.
- Removed or changed memberships are handled explicitly and invalidate identity/permission caches.
- Tests cover new user, existing user, ambiguous department, and department change.

## DIVO-004 — “GST amount due” is answered with total bill balance, not GST liability

Priority: P1  
Status: Open

### Evidence

- Chat: `oc_e00314b99ce6778ee14134052b35311c`
- Thread: `omt_190c337e920f19b9`
- Request: `om_x100b69aff5b6cca0e150860851ba81d`
- Response: `om_x100b69aff542d4ace18c5d4f256c623`

### Observed

The user requested vendors and bills whose GST amount was due. Divo returned vendors with `business_gst` treatment and summed total outstanding bill balances (₹46,62,060). The same response admitted that the exact GST component was not available without fetching individual bills. It also announced a top 20 but rendered only 15 rows.

### Expected

The response must distinguish:

- Vendor GST treatment.
- Unpaid bill balance.
- Actual outstanding GST/tax component.

It should not label one as another.

### Acceptance criteria

- Each bill's tax total is fetched or the answer explicitly states that GST due was not computed.
- Aggregates use the tax component requested by the user.
- The row count in the heading matches the rendered or exported rows.
- Tests include mixed taxable/non-taxable bills and partial payments.

## Recommended fix order

1. DIVO-001 — incorrect financial status/balance.
2. DIVO-002 — false export success and missing artifact.
3. DIVO-003 — systemic department-sync authorization gap.
4. DIVO-004 — GST semantic accuracy.
