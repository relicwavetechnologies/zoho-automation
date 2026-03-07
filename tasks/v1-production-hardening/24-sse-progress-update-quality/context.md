# SSE Progress Update Quality

## Why This Task Exists
Streaming progress is currently useful but low quality. The user sees broken fragments because emission is based on size and timer heuristics rather than sentence-safe boundaries.

## Current State
1. Mastra orchestration buffering exists in the runtime.
2. The current implementation flushes on timing and threshold logic.
3. Sentence-safe punctuation and newline rules are not enforced consistently.
4. Lark progress updates should align with the same boundary behavior where practical.

## In Scope
1. Buffer stream text until sentence-safe boundaries.
2. Flush on `.`, `?`, `!`, newline, max-size fallback, or inactivity timeout.
3. Flush remainder on `done` and `error`.
4. Keep progressive UX without mid-phrase fragments.
5. Add automated tests for boundary behavior.

## Out of Scope
1. Rewriting the orchestration model stack.
2. UI redesign of streaming components.
3. Changing final response synthesis contract.

## Dependencies
None.

## Deliverables
1. Buffered sentence-safe streaming logic in runtime/orchestration path.
2. Updated tests covering flush rules and regressions.
3. Progress log evidence showing sentence-level behavior.

## Exit Criteria
User-visible progress no longer breaks at arbitrary token fragments.
