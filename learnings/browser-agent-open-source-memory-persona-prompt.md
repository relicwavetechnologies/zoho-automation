# Browser-agent prompt: open-source memory and persona research

Copy the prompt below into the browser research agent.

---
Research the strongest current open-source implementations of long-term user learning, persona/profile construction, memory consolidation, preference extraction, and context recall for AI agents.

## Product context

We are building **Divo**, an enterprise agent. A manager works normally and Divo should gradually learn the manager's working style, standards, preferences, corrections, and reusable ways of doing work. The resulting manager persona and skills are available only to that manager's department so team members can receive work at the quality and style the manager expects.

Important constraints:

- Learning is always available for the manager; it is not a manual recording toggle.
- V1 learns only from manager runs, not from team-member suggestions.
- Run evidence is captured first, then selected runs are processed asynchronously.
- Memory, persona, and procedural skills are distinct concepts and must not be collapsed into one store.
- We do not want managers approving routine updates.
- High-confidence changes may be automatic, but the system must protect against false memories, persona drift, contradictory preferences, and one-off behavior being promoted as policy.
- A compact persona/skill-tree brief may be injected into each department member's system context; detailed instructions should be retrieved only when applicable.
- The backend remains the authority for identity, department scope, permissions, audit, versioning, and promotion.
- The proposed extraction model for the first version is DeepSeek V4 Flash behind a replaceable model interface.

## Repositories to investigate

Find and inspect 8–12 active, production-relevant open-source repositories. Include the current NousResearch/Hermes agent implementation and investigate candidates such as Letta/MemGPT, Mem0, Zep/Graphiti, Open WebUI, and LangMem when relevant. Do not include a project merely because its README uses the word “memory”; verify the implementation in code.

Search for additional repositories that are stronger than the named examples, especially systems that learn stable preferences automatically or maintain a structured user model over time.

## Questions to answer for every repository

1. Repository URL, license, recent activity, adoption signal, and whether the relevant feature is genuinely open source.
2. Exact source files, classes, schemas, prompts, workers, and tests implementing memory/persona behavior.
3. Trigger and cadence: every message, every completed run, periodic review, session boundary, explicit command, or adaptive gate?
4. Which parts are deterministic code, model judgment, or a hybrid?
5. Data model: monolithic profile document, atomic facts/preferences, vector memories, graph, hierarchy/tree, events, or generated materialized view?
6. How are explicit statements distinguished from inferred behavior?
7. How are repetition, recency, successful outcomes, negative feedback, contradictions, supersession, confidence, decay, and forgetting handled?
8. Does the model directly mutate active memory, or propose structured operations that application code validates?
9. Are candidate/shadow and active states separate? Is there version history, audit, rollback, provenance, evidence linkage, and tenant/user scoping?
10. How does recall work? What is always injected, what is retrieved on demand, and how is token growth controlled?
11. How are prompt injection, poisoned memories, cross-user leakage, and sensitive-data retention handled?
12. What queue, retry, idempotency, locking, and concurrency patterns protect asynchronous consolidation?
13. What evaluations exist for precision, recall, stale-memory use, contradiction resolution, personalization correctness, latency, and cost?

## Special focus: automatic persona writing

Explain how confidence can be established without trusting the model's self-reported confidence. Look for application-computed evidence such as:

- explicit manager correction or stated preference;
- repeated independent observations across runs;
- observed acceptance or successful outcome;
- contradiction count and recency;
- source diversity;
- stability over time;
- scope consistency (global, department, task class, app, client);
- safe shadow evaluation before active promotion.

Compare these source-of-truth designs:

1. one continuously rewritten `persona.md` document;
2. atomic versioned preferences plus a generated persona brief;
3. a hierarchical persona tree as the primary store;
4. an evidence graph with generated views.

State which design is safest and simplest for Divo's first version, and why.

## Negative evidence

Read relevant issues, bug reports, discussions, and tests. Specifically look for failures involving persona drift, false memory, duplicated or contradictory facts, prompt growth, stale recall, over-personalization, bad consolidation, latency/cost, data leakage, and irreversible model-written updates.

## Required output

1. An executive conclusion: the 3–5 best repositories to learn from and the exact subsystem each contributes.
2. A comparison matrix covering the questions above.
3. For each top repository: what Divo should copy, adapt, and explicitly avoid.
4. A proposed Divo architecture from evidence capture through candidate extraction, confidence computation, promotion, active brief generation, retrieval, correction, and rollback.
5. A proposed minimal schema and job/state machine, but do not over-design implementation details unsupported by evidence.
6. A staged rollout and evaluation plan for automatic writes without routine manager approval.
7. Unresolved questions and experiments required before choosing thresholds.

## Evidence rules

- Prefer primary sources: repository code, tests, maintainers' documentation, issues, and relevant papers.
- Cite exact repository paths and stable commit links or line ranges.
- Label every substantial claim as **verified**, **inference**, or **unresolved**.
- Distinguish marketing claims from implemented behavior.
- Do not recommend a design with less than 80% confidence; instead identify what must be tested.
- Keep the report implementation-oriented and concise enough that an engineering team can act on it.

---
