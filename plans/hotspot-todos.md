# Hotspot Todos

Captured: 2026-08-20

These are the next actionable hot points from the planning/review notes, kept
small on purpose.

## 1. Connection and Scope-Limit UX

- Analyze connection state and OAuth scope gaps as typed states, not one generic
  "connect your account" failure.
- Show the right Connect/Reconnect button or card in the member's current
  surface.
- Scope the connect action narrowly to the blocked provider, tool/action, and
  missing scope group.
- Preserve the original request so the work can continue after connection.

## 2. Self-Updating Skill Proof

- Prove whether Divo actually updates a skill after explicit learning.
- Trigger the loop with a clear correction, not silent model self-opinion.
- Watch for: `KnowledgeMutation`, `KnowledgeOutbox`, updated `Skill`,
  `SkillVersion`, `SkillRegistryRevision`, changed Pi bootstrap digest, and the
  next turn using the new instruction.
- If the proof fails, inspect `divo_knowledge_review` and the
  `openVerifiedLarkKnowledgeReview` channel guard first.

Guardrail: Divo should propose skill updates after explicit correction and human
approval. It should not silently rewrite live skills on its own.
