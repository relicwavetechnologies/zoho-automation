# Divo domain context

## Knowledge and skills

- **Knowledge mutation** is the durable, versioned proposal to create, update, publish, or delete one knowledge resource. It stores the exact canonical content, content hash, policy snapshot, requester, scope, and current state.
- **Skill review** is the requester-owned lifecycle for one correction-driven skill mutation. It opens the mutation, asks the requester through a Decision, hands shared authority to the approval module when required, applies the mutation, and reports projection truthfully.
- **Requester review** confirms that the complete replacement content is exactly what the requester meant. It is not authority to publish outside the requester's scope.
- **Authority decision** is the manager or administrator decision required by the mutation's policy. Department managers may confirm their own department skill mutations. Company skill mutations still require a distinct administrator.
- **Skill projection** turns an applied knowledge version into the active `Skill`, immutable `SkillVersion`, access grants, and registry revision used by Pi.
- **Applied** means the canonical knowledge mutation committed. It does not mean the skill projection is active.
- **Active skill revision** means projection completed and the next runtime bootstrap can carry the new revision.

## Human decisions

- **Decision** is the durable question shown by web and Lark adapters. It owns ask, delivery, actor checks, expiry, answer validation, and atomic answer settlement.
- A Decision does not own knowledge policy or tool execution. Producer modules settle their domain transitions through the linked Decision seam.
- A **linked Decision** is a requester-owned Decision that waits on a separate authority decision. The authority outcome returns to the producer that owns the domain transition.

## Runtime use

- Pi receives skills from the backend native-skill bootstrap. It never writes the mounted skill files.
- A changed bootstrap digest replaces the warm Pi process between turns. The new skill is therefore promised from the next turn, not the turn that approved it.
- A **member grant scope** is one fresh, principal-bound projection of the member's active department IDs, department-role IDs, and optional active admin role. Runtime context may share it with skill- and connection-grant adapters to avoid duplicate membership reads; it is input to those modules, never execution authority, and each module still evaluates its own grants.
- A **provider schema artifact** is a sanitized, bounded, content-addressed snapshot of one reviewed external provider's tool schemas. It contains no member data, connection identifier, credential, endpoint URL, lease, permission snapshot, or execution authority.
- Postgres owns immutable provider schema artifact bytes and a freshness-fenced current head keyed by an endpoint fingerprint. Backend and Pi process maps are read accelerators only, so process loss does not force Google or Airtable schema discovery back onto a member's turn.
- Provider schema artifacts expire by policy and refresh through their provider adapter. Corrupt or expired bytes are never called current. Actual provider calls still cross the backend gateway and re-check current permission, connection, approval, and rate policy.

## WhatsApp follow-ups

- A WhatsApp webhook is **admitted** only after its ingress receipt is persisted. HTTP acknowledgement follows admission; message processing may continue asynchronously because the receipt is recoverable.
- A `queued` broadcast means Divo has a durable request but may not yet know whether OpenWA accepted it. The same reviewed client request produces the same gateway batch id, and polling owns the transition to a terminal result.
- A WhatsApp session becomes `disconnected` only after a successful gateway probe reports a confirmed unusable state. A gateway error or unknown status changes nothing. Recovery restores `linked` but does not clear `darkSince`; only a completed history repair proves the gap is filled.
- A required audit checkpoint is written as `pending` before an irreversible follow-up effect. Outcome settlement changes it to `success` or `failure`; a settlement outage leaves the pending row as explicit reconciliation work rather than erasing the audit trail or returning a false failure after the effect.
