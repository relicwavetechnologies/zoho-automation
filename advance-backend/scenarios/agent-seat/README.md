# Agent Seat scenarios

Manual walkthrough checklists for skill and tool behavior. Run with
`pnpm tsx scripts/agent-seat.ts scenario show <name>` from `advance-backend/`.

## Before you start

1. `pnpm dev:e2e` (Development DB + Redis).
2. Set `AGENT_SEAT_DELIVERY_CHAT_ID` in local `.env` or use `init --chat-id`.
3. `pnpm tsx scripts/agent-seat.ts init --user "<you@company.com>"`.

Full harness docs: `docs/cloud-pi-testing/06-agent-seat.md`.

## Bundled scenarios

No legacy export-planner scenario is bundled. New scenarios must exercise
currently registered provider contracts; terminal/file workflows belong in the
Cloud-Pi harness because Agent Seat does not run the container.

## Notes for authors

- Keep prompts realistic member language.
- Document expected tools and anti-patterns (`avoid` in YAML).
- Respect tool limits (e.g. `backlinks_comparison` max 10 targets per call).
- Never embed personal Lark chat ids in tracked files.
