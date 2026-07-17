# Hermes memory, profile, and skill architecture

## Scope and source

**Verified locally.** This review uses the clean checkout at `research/hermes-agent`:

- Repository: `https://github.com/NousResearch/hermes-agent.git`
- Branch: `main`
- Commit: `8fa8aabbbbb1f5f65ad44d747527dfcd9b7a4866`
- Commit date: 2026-07-15

Hermes does not implement Divo's exact concept of an automatically learned, department-shared manager persona. Its closest behavior is spread across four separate systems.

| Hermes concept | Purpose | Learned automatically? | Divo analogue |
|---|---|---:|---|
| `SOUL.md` | Agent identity, voice, and durable baseline | No; normally user-maintained | Not manager persona |
| `USER.md` | User profile, preferences, expectations | Yes, through memory writes/review | Manager preference brief |
| `MEMORY.md` | General persistent notes and facts | Yes, through memory writes/review | Long-term memory, not persona |
| `SKILL.md` | Procedures for classes of work | Yes, through skill review | Manager working-method skills |

### Primary evidence

- `website/docs/user-guide/features/memory.md`
- `website/docs/guides/use-soul-with-hermes.md`
- `tools/memory_tool.py`
- `tools/skill_manager_tool.py`
- `agent/system_prompt.py`
- `agent/agent_init.py`
- `agent/turn_context.py`
- `agent/conversation_loop.py`
- `agent/turn_finalizer.py`
- `agent/background_review.py`
- `agent/memory_provider.py`
- `agent/memory_manager.py`
- `agent/curator.py`
- `agent/learning_graph.py`
- `agent/learning_mutations.py`
- `plugins/memory/{supermemory,mem0,honcho,hindsight}/`
- focused tests under `tests/run_agent/` and `tests/agent/`

## 1. Built-in memory is small and session-frozen

**Verified.** Hermes stores small prose chunks separated by `§` in two files:

- `MEMORY.md`: default maximum 2,200 characters.
- `USER.md`: default maximum 1,375 characters.

`MemoryStore` keeps two views:

- a live on-disk representation used by memory tools;
- a sanitized prompt snapshot captured when the session starts.

Changes made during a session persist immediately but become visible to the model's system context on the next session. This deliberately preserves prompt caching and prevents the system prompt changing mid-conversation.

The memory tool supports add, exact-text replace, and exact-text remove. It rejects exact duplicates, applies character caps, scans content for injection/exfiltration patterns, and allows up to three failed consolidation attempts in a turn. It does not automatically compact memory when full; the agent must rewrite or remove something.

**Limitation.** This is a compact notes system, not a structured confidence-aware user model. Exact duplicate detection and substring editing do not solve semantic duplication, contradiction, provenance, or supersession.

## 2. Review cadence is periodic, while provider capture can be per-turn

**Verified.** Hermes has separate clocks:

- Memory self-review defaults to every 10 user turns (`memory.nudge_interval`).
- Skill self-review defaults to every 10 tool-calling iterations (`skills.creation_nudge_interval`).
- External memory providers can capture/sync after every completed turn.
- Provider session-boundary hooks run separately when a session ends or switches.

Counters are hydrated from conversation history so recreating the agent does not silently reset review cadence. Background review starts only after a successful, non-interrupted final response.

**Lesson.** Immediate durable capture and expensive semantic consolidation are different workloads. Divo should not equate “save evidence after a run” with “rewrite the active persona after every run.”

## 3. The automatic reviewer is a restricted agent fork

**Verified.** `agent/background_review.py` launches a daemon-thread review agent. It:

- uses the main model by default or an optional cheaper `auxiliary.background_review` model;
- replays full history for the same model, preserving warm-cache opportunities;
- uses a digest of older history plus the most recent 24 messages when switching models;
- is capped at 16 iterations;
- disables its own memory/skill review intervals to prevent recursion;
- disables persistent sessions and external memory-provider integrations;
- restricts its useful mutation surface to memory and skill-management tools;
- auto-denies dangerous terminal operations;
- records write origin as `background_review`.

The memory-review prompt asks the agent to identify durable persona, desires, preferences, expectations, and useful facts. The skill-review prompt treats user corrections about style, tone, format, verbosity, workflow, and tool choice as first-class skill signals.

The reviewer is explicitly instructed to avoid persisting transient failures such as a temporarily missing binary or one broken browser attempt. Those warnings were added after observed real failures, showing that prompt-only learning can encode bad constraints.

**Important limitation.** With write approval disabled—the default—the review model can directly apply tool-level changes to active memory and skills. The application restricts the mutation tools, but it does not independently prove that the inferred preference is true.

## 4. Skill learning favors reusable task classes

**Verified.** Hermes's review policy avoids creating one skill per conversation. It prefers this order:

1. update the skill that was loaded for the work;
2. update an existing class-level umbrella skill;
3. add a focused support file such as a reference, template, or script;
4. create a new class-level umbrella only when necessary.

Hermes's manual `/learn` flow aims for structured skills with “When to Use,” prerequisites, quick reference, procedure, pitfalls, and verification. The background curator tracks usage, archives stale agent-created skills instead of deleting them, and can consolidate narrow skills into umbrellas. LLM consolidation is currently opt-in/off by default; deterministic pruning can run independently. Backups and restore paths protect against a bad consolidation.

The skill manager also contains fail-closed guards learned from earlier failures: during curator consolidation, deletion/archive must be tied to a declared absorbed-into target, and existing skills must be read before a background reviewer edits them.

**Lesson.** A manager's correction should improve a reusable task-class skill when procedural, not be copied blindly into a global persona document.

## 5. External memory has a clean lifecycle boundary

**Verified.** `MemoryProvider` and `MemoryManager` isolate external recall/capture behind lifecycle hooks:

- prefetch context before a turn;
- asynchronously sync a completed turn;
- queue the next prefetch;
- flush/commit at session end;
- optionally expose explicit search/store/forget/profile tools.

The manager uses a serialized background worker and maintains session-boundary ordering. Retrieved context is fenced as `<memory-context>` and scrubbed from later capture/output so recalled memory is not mistaken for fresh user evidence.

Examples show different policies:

- **Supermemory:** semantic search every turn; profile facts on the first turn and every configurable N turns (default 50); full-session ingestion for richer profile/graph processing.
- **Mem0:** semantic prefetch and per-turn synchronization.
- **Honcho:** per-turn capture plus peer/profile reasoning and file seeding.
- **Hindsight:** configurable asynchronous recall/retain cadence and scoped memory banks.

**Lesson.** Divo should keep a provider-like boundary for recall, but enterprise identity, department scope, provenance, and promotion must remain backend-owned rather than delegated to a client plugin.

## 6. Hermes's “learning graph” is mainly a view, not the source of truth

**Verified.** The newer `agent/learning_graph.py` combines:

- learned/used non-base skills;
- chunks from `MEMORY.md` and `USER.md`;
- declared skill-to-skill `related_skills` edges;
- memory-to-skill edges inferred by simple lexical overlap.

`learning_mutations.py` maps visible graph nodes back to the underlying files. Skill deletion archives recoverably; memory deletion rewrites the source file atomically.

**Critical interpretation.** This graph is a desktop visualization/materialized view over files. It is not a semantic evidence graph, confidence model, or independently durable tree. Its memory node IDs depend on list position and can become stale after edits.

For Divo, this supports treating a persona tree as a generated navigation/retrieval view rather than automatically assuming the tree itself should be the authoritative database.

## 7. Optional approval exists but is not required

**Verified.** Hermes can stage memory and skill writes under a pending directory when write approval is enabled. Approval is disabled by default, so automatic writes are a supported normal mode.

This validates the product choice that a manager should not approve every update. It does **not** validate unrestricted direct writes. Divo can remove routine human approval while still requiring deterministic backend promotion checks, versioning, and rollback.

## What Divo should copy

1. Separate agent identity, user profile, general memory, and procedural skills.
2. Capture evidence immediately but consolidate asynchronously and less frequently.
3. Use a restricted review worker with no general tool authority.
4. Keep a compact, stable session brief and retrieve details only when relevant.
5. Fence recalled context so it cannot be re-ingested as new evidence.
6. Prefer reusable class-level skills and support files over session-specific skills.
7. Track provenance, read-before-write, atomic updates, versions, backups, archive, and restore.
8. Keep deterministic maintenance separate from optional LLM consolidation.
9. Make automatic learning observable through a graph/timeline UI without making that view the source of truth.

## What Divo should not copy directly

1. Direct prompt-driven writes into the only active profile representation.
2. A fixed “every 10 turns” rule as the sole relevance gate.
3. One monolithic `USER.md` as department persona source of truth.
4. Exact-string duplicate handling as a substitute for semantic conflict resolution.
5. An in-process daemon thread for enterprise-durable jobs; use the backend queue and database.
6. Model self-reported confidence as promotion authority.
7. Full-history replay without minimization, data classification, and retention controls.
8. Lexical graph edges as proof that two learned behaviors are semantically related.

## Bottom line

Hermes strongly supports the overall direction, especially the separation of profile, memory, and skills and its asynchronous restricted reviewer. Its weakest point for Divo's use case is exactly the risky part: deciding that an inferred behavior deserves to become active truth. Divo needs a stronger evidence and promotion layer around the model, not merely a smarter review prompt.
