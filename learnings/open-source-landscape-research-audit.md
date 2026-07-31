# Audit: open-source memory and persona landscape report

## Verdict

The report is useful for orientation and its central Divo conclusion is broadly correct. It is not strong enough to use as an implementation specification. Several claims marked `[VERIFIED]` are repository documentation, open issue allegations, or the report author's design assumptions rather than confirmed behavior. The repository ranking also misses first-party systems that are closer to Divo's actual after-run pipeline.

## Conclusions we should keep

1. Divo should not adopt one memory framework as its authority.
2. Memory, manager preferences/persona, and procedural skills need separate semantics.
3. Immutable evidence plus atomic, versioned records is safer than one continuously rewritten persona document.
4. The persona tree/brief should be a generated view, not the evidence source of truth.
5. Run processing should be asynchronous and idempotent.
6. Temporal validity and provenance are worth borrowing from Graphiti.
7. Hermes is the strongest local reference for the profile/memory/skill separation and class-level skill learning.
8. Candidate and active states are valuable for automatic learning without routine manager approval.
9. Department and manager scoping must be enforced in the backend/database, never only in prompts or SDK filters.

## High-impact corrections

### 1. The report missed stronger pipeline references

**Verified from primary source.** OpenAI Codex has a two-phase asynchronous memory pipeline:

- Phase 1 claims eligible per-thread extraction jobs in SQLite, filters memory-relevant content, runs bounded parallel extraction, redacts secrets, persists structured output, and records `succeeded`, `succeeded_no_output`, or retryable failure.
- Phase 2 takes a single global lease, selects bounded stage-one results, maintains watermarks and an added/retained/removed diff, heartbeats the lease, runs a restricted consolidation agent, and only advances state on success.

This is a closer reference for Divo P1–P3 than Cognee's graph architecture because our immediate problem is durable after-run orchestration, not knowledge-graph construction.

Primary source: `openai/codex/codex-rs/core/src/memories/README.md`.

**Verified from primary source.** Gemini CLI Auto Memory implements:

- idle/trivial/sub-agent eligibility filtering;
- background extraction;
- lock and processed-session state for concurrency/idempotency;
- an explicit candidate inbox;
- a default-to-no-artifact extraction policy;
- tool and path allowlists, patch parsing, dry runs, and atomic application.

Gemini requires human approval, which Divo does not want, but the candidate boundary and mutation validation remain directly useful. Divo can replace manual approval with deterministic high-confidence promotion.

Primary source: `google-gemini/gemini-cli/docs/cli/auto-memory.md`.

**Verified from primary source.** Memobase is a more direct user-profile reference than several ranked repositories. It uses user-scoped structured profile topics/subtopics, buffers recent interactions, performs cold-path batch processing after a size/idle/session trigger, and assembles a bounded prompt context. It should be added to the comparison.

Primary source: `memodb-io/memobase` README and code require a follow-up deep dive.

### 2. Hermes is described incorrectly in important places

- `SOUL.md` is the agent's identity/voice, not the learned manager persona. `USER.md` is the closer analogue for manager preferences.
- Hermes does automatically review and update memory/profile and skills. Memory review defaults to every 10 user turns and skill review to every 10 tool iterations; it is not merely manual nudging.
- The background reviewer can directly apply memory/skill tool mutations when approval is disabled, which is the default.
- Skill creation is cadence and signal driven, not reliably “after every complex task.”
- Hermes's newer learning graph is a visualization/materialized view over files with lexical edges, not a confidence-aware evidence graph.

These corrections are verified against the local Hermes checkout at commit `8fa8aabbbbb1f5f65ad44d747527dfcd9b7a4866`.

### 3. Open issues are not confirmed production vulnerabilities by themselves

The report calls Letta issue `#3388` a confirmed cross-user leak. The issue is open, reports static code analysis, and reproduces persistence when the same daemon/agent is deliberately reused across independent evaluation tasks. It identifies a real isolation risk, but it does not by itself prove arbitrary user-A-to-user-B leakage in a correctly scoped deployment.

Mem0 issue `#6367` has a stronger code-level argument: incoming metadata can overwrite identity fields in the TypeScript SDK. It is still an open issue, so the report should say “code-supported open vulnerability report,” not imply a released advisory or independently reproduced incident.

### 4. Candidate-vs-active is not absent from open source

The categorical claim that no open-source system implements candidate/active memory is false or at least obsolete. Gemini CLI now has a candidate inbox before activation. Other emerging repositories claim candidate identity/skill lifecycles and require direct code inspection. The report should distinguish:

- candidate requiring human approval;
- candidate automatically promoted by deterministic policy;
- shadow/offline evaluation;
- active memory.

Divo specifically needs the second and third forms.

### 5. “Shadow mode” is defined incorrectly

The report proposes keeping a candidate uninjected for N sessions and promoting it when there is no negative signal. If the candidate never affects behavior, absence of negative feedback provides no evidence that it is correct.

Real shadow evaluation needs at least one of:

- offline replay comparing candidate-guided decisions with known manager outcomes;
- a parallel judge scoring active-only versus active-plus-candidate outputs;
- counterfactual retrieval logging plus later explicit manager behavior;
- controlled limited activation with measurable rollback signals.

Waiting seven days is not validation.

### 6. The numerical confidence formula is invented, not validated

The weights, sigmoid, 5/8-observation thresholds, 0.80 promotion threshold, 30-day decay, seven-day waiting period, and weekly/monthly schedules are design hypotheses. They are not established by the surveyed repositories.

They also create bad edge cases:

- one explicit manager instruction may score too low despite being authoritative;
- repeated correlated observations may falsely look independent;
- recency decay can weaken a durable standard merely because it was not recently mentioned;
- retrieval usage can create circular confidence: the system retrieves a belief, acts on it, then treats that usage as new support;
- “no contradiction found” is not positive evidence.

For V1, use policy bands and evaluate them on labeled Divo runs before choosing numeric weights.

### 7. Several storage recommendations are premature

- Do not introduce Qdrant/FAISS in P1 merely because Mem0 supports them. Divo already has a backend database and should first prove that semantic retrieval is needed beyond scoped relational lookup and existing capabilities.
- Do not store `source_sessions[]` inside a persona row. Use an evidence link/join table so provenance, polarity, and independent observations remain queryable.
- Do not build role/user inheritance yet. V1 learns from one manager and exposes the active manager guidance to that department; extra inheritance is scope creep.
- Do not make an enum taxonomy such as communication/quality/tools irreversible. Start with a small controlled scope plus a versioned classifier/taxonomy.

### 8. Some metrics are misnamed

“Percentage of signals that survive the confidence threshold” is a promotion/retention rate, not extraction precision. Precision requires labeled truth: of the extracted/promoted claims, how many are actually valid and correctly scoped? Recall requires knowing which durable manager lessons should have been extracted but were missed.

## Evidence-quality problems

1. Exact commit SHAs and stable source links are mostly absent.
2. Several `[VERIFIED]` claims cite only README/marketing language.
3. Proprietary systems are included in an open-source ranking without a clean separation.
4. “Observation Engine” and “Adaptive Recall” thresholds appear without repository definitions or primary citations.
5. Benchmark scores and token-cost claims are not normalized by model, dataset version, retrieval configuration, or evaluation method.
6. The report ranks repositories using broad feature appeal rather than Divo's immediate architectural problem.

## Corrected learning priority for Divo

This is a subsystem priority, not a final repository leaderboard:

1. **OpenAI Codex:** durable two-phase extraction/consolidation jobs, leases, retries, watermarks, restricted consolidation, usage-based retention.
2. **Gemini CLI Auto Memory:** eligibility filtering, concurrency lock, candidate isolation, mutation allowlists, dry-run/atomic application, default abstention.
3. **Hermes:** memory/profile/skill separation, frozen compact context, periodic restricted review, reusable class-level skills, archive/restore.
4. **Graphiti:** temporal validity, supersession without deletion, evidence provenance, hybrid retrieval if needed later.
5. **Memobase:** structured user profiles, buffered cold-path processing, bounded context assembly.
6. **Mem0/LangMem:** extraction prompts and library interfaces, but not promotion authority.
7. **Cognee:** later inspiration for improve/forget lifecycle if graph complexity becomes justified; not the P1 foundation.

Shisa/Shisad and MnemeBrain may contain highly relevant trust/evidence/candidate designs, but they need direct source and license inspection before being adopted as evidence.

## What this changes in the Divo plan

It does not change the main P1–P3 direction. It sharpens it:

### P1 — evidence contract

- Store immutable, scoped evidence and extraction eligibility reasons.
- Separate explicit correction, explicit durable instruction, confirmed preference, inferred pattern, outcome, and contradiction.
- Include sensitivity/redaction state, evidence polarity, model/prompt version, and run provenance.

### P2 — durable jobs

- Copy Codex-like claim/lease/backoff/watermark/idempotency concepts using Divo's existing backend queue/database patterns.
- Record valid no-learning results as successful abstentions, not failures.

### P3 — shadow extraction

- DeepSeek returns schema-validated proposals only.
- Default to “nothing durable learned.”
- Build a labeled evaluation set before automatic promotion.
- Do not implement the report's confidence formula yet.

### P4 — promotion and generated views

- Atomic evidence-linked records remain authoritative.
- Deterministic policy promotes only evaluated high-confidence classes.
- Persona brief/tree is generated and versioned.
- Detailed skills are retrieved by task scope.
- Contradictions suspend or supersede affected claims rather than silently choosing by vector rank.

## Final assessment

Use the report as a useful survey and idea catalog. Do not copy its rankings, fixed formula, thresholds, schedules, shadow-mode logic, or database schema. Its strongest conclusion—build an evidence-first Divo-owned pipeline with atomic records and generated persona views—survives the audit.
