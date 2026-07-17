# Divo manager-persona research decisions

## Current conclusion

The foundation work can start before the final persona representation is chosen, provided the foundation stores immutable run evidence and queues versioned analysis jobs rather than prematurely writing a `persona.md` file.

The safest provisional shape is:

```text
manager run
  -> deterministic eligibility gate
  -> immutable evidence bundle
  -> durable persona-analysis job
  -> model proposes structured observations
  -> backend validates and scores evidence
  -> candidate preference/skill changes
  -> high-confidence automatic promotion
  -> versioned active brief + retrievable skill details
```

No routine manager approval is required. “Automatic” means the backend automatically promotes changes that satisfy evidence policy; it does not mean the language model gets unrestricted write access.

## Decisions that are safe now

### 1. Persona remains separate from memory

**Decision.** Keep episodic/factual memory, manager preferences, and procedural skills separate. They may reference the same evidence but have different retention, retrieval, and conflict rules.

### 2. The after-run process is queued

**Decision.** The run-completion path should only finalize evidence and enqueue an idempotent analysis job. It should not block the user's response or run the learning model inline.

Recommended initial states:

```text
captured -> eligible | skipped
eligible -> queued -> analyzing
analyzing -> proposed -> validated
validated -> promoted | shadowed | rejected
failure -> retryable | terminal
```

The job must be independently retryable and keyed so duplicate run-end events cannot create duplicate persona updates.

### 3. The extraction model is replaceable

**Decision.** DeepSeek V4 Flash is acceptable for the first extractor, behind a provider/model adapter. Model choice is configuration, not domain architecture.

The extractor should return schema-validated operations, not prose or an edited persona file.

### 4. Manager evidence is the only V1 learning source

**Decision.** Team members consume the active manager brief and skills but do not propose learning changes in V1.

### 5. The backend remains the authority

**Decision.** Evidence scope, department ownership, confidence calculation, promotion, versions, rollback, audit, and prompt assembly remain in `advance-backend`. Pi/desktop captures and forwards evidence but cannot decide what becomes active department guidance.

## Provisional design pending external research

### Atomic records should probably be the source of truth

**Recommendation, not final.** Store small, structured, versioned observations/preferences with links to their evidence. Generate `persona.md`-like briefs and tree views from those records.

Why:

- One preference can be promoted, superseded, rolled back, or scoped without rewriting unrelated persona content.
- Contradictions and provenance remain inspectable.
- A compact brief can be regenerated for each session without forcing every detail into the prompt.
- A tree can change as taxonomy improves without migrating the actual evidence.

This means a “persona node” is not necessarily a Markdown file. It may simply be one stable preference or one task-class skill in a generated hierarchy.

### Model proposal and backend promotion should be separate

**Recommendation, not final.** The model proposes operations such as:

```json
{
  "kind": "preference",
  "scope": "client_report/review",
  "claim": "Show the variance table before the narrative explanation",
  "evidenceIds": ["..."],
  "signal": "explicit_correction",
  "operation": "upsert_candidate"
}
```

The backend then verifies schema, ownership, evidence existence, allowed scope, duplication, conflicts, and promotion thresholds. The model's own confidence field may be logged but must not decide promotion.

### Confidence should come from evidence policy

**Recommendation, not final.** Promotion strength should depend on observable facts:

- explicit manager instruction or correction;
- repetition across independent runs;
- accepted/successful outcomes;
- recency and stability;
- contradiction and supersession history;
- whether the behavior is global or task-specific;
- whether retrieved guidance improves held-out/shadow evaluations.

Likely initial policy:

- explicit durable instruction: can promote quickly after safety/scope checks;
- repeated inferred behavior: remains candidate until independently observed multiple times;
- one-off implicit behavior: store as evidence only, not active persona;
- contradictory evidence: stop automatic promotion and retain both sides for resolution/supersession analysis;
- security-sensitive or permission-changing content: never persona-promoted.

Exact thresholds remain unresolved until real Divo traces are evaluated.

## Context given to the learning agent

The analysis agent should receive a bounded evidence package, not the entire company history:

1. run metadata and department/manager identity references;
2. relevant transcript excerpts and explicit corrections;
3. tool/app actions, outputs, outcomes, and HITL decisions;
4. the currently active preferences/skills in the likely task scope;
5. nearby candidates and known contradictions;
6. the allowed operation schema and policy constraints;
7. examples of valid classification and required “nothing durable learned” output.

The agent should not receive SaaS credentials, unrelated department data, raw system secrets, or authority to execute business tools.

## Retrieval for department members

The active manager persona should be available by default, but not all detail should be injected on every turn.

Recommended split:

- **Always injected:** a small generated tree/brief naming major working principles and available task-class skills.
- **Retrieved when applicable:** detailed preference records, relevant skill instructions, examples, templates, and pitfalls.
- **Enforced by backend regardless of persona:** permissions, RBAC, approvals, tenant isolation, and integration access.

The agent must be instructed that the brief is a routing map: identify the current work class, load the relevant manager skill, then follow it unless the current user explicitly overrides a non-policy preference.

## Foundation phases

### Phase 1 — evidence contract

- Define the immutable after-run evidence bundle and eligibility reasons.
- Record explicit corrections separately from inferred behavior.
- Add privacy classification, retention markers, manager/department scope, and trace provenance.
- Do not add persona-writing behavior yet.

### Phase 2 — durable queue and job lifecycle

- Add a persona-analysis queue separate from existing ingestion work.
- Make enqueueing idempotent and transactional with run completion, preferably through an outbox or equivalent durable handoff.
- Add retry, terminal-failure, model/version, and processing-attempt records.
- Still do not write active persona.

### Phase 3 — model adapter and shadow extraction

- Add DeepSeek V4 Flash through a replaceable structured-output adapter.
- Produce evidence-linked candidate observations only.
- Run in shadow mode and measure precision before any active promotion.

### Phase 4 — promotion and versioning

- Finalize atomic preference/skill schemas using Hermes plus external-repository evidence.
- Add deterministic validation, contradiction handling, automatic high-confidence promotion, versions, and rollback.
- Generate the active brief/tree as a materialized view.

### Phase 5 — department recall and evaluation

- Inject the compact brief for department members.
- Retrieve detailed manager skills only when relevant.
- Evaluate correct recall, wrong recall, stale guidance, task outcomes, latency, and token cost.

## Main unresolved questions

1. Which atomic preference schema and scope taxonomy gives useful structure without becoming rigid?
2. What evidence thresholds produce high enough precision for automatic promotion?
3. Should explicit corrections promote immediately or pass one shadow evaluation first?
4. How should a manager's current explicit instruction override an older durable preference?
5. Which changes update persona preferences versus procedural skills versus both?
6. How should sensitive content be redacted before model analysis and long-term retention?
7. What is the correct session refresh behavior when the active manager brief changes mid-session?

These questions affect Phase 4, not the evidence and queue foundations in Phases 1–3.
