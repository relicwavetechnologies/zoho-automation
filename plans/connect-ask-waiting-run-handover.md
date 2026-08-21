# Handover: the waiting connect ask, and the image that lied about itself

**Written 2026-08-21.** Covers one session. Everything below is either shipped to
`main` and `dev` or named as still open.

Two pieces of work happened, and the second only surfaced because the first was
being deployed. They are unrelated in the code and inseparable in the story.

- The Google connect flow was rebuilt so a run waits instead of ending.
- A Development image was found carrying a schema older than its own database,
  and the pipeline flaw that let it be tagged with a commit it was never built
  from was removed.

The connect work itself is specified in
[`plans/scope-gap-connect-ask.md`](./scope-gap-connect-ask.md), which owns that
area. Decision **D15** and **Phase 9** there are the authority on the design.
This file is the session record and the state of the world after it.

---

## 1. What shipped

### The run waits now

The flow used to run twice. One run sent the Connect card and ended, and a worker
rebuilt an equivalent run after OAuth completed. Everything awkward about it came
from that gap: a card that outlived its own question by 95 seconds on a measured
run, a second run invisible to the web thread because it never entered the run
registry, and a client poll invented to notice work it could not otherwise see.

The container could already wait. `ctx.ui.confirm` blocks a turn until something
answers it, but the only adapter at that seam was a policy that decided
immediately, so nobody could ever be on the other side of it. One adapter means a
hypothetical seam.

Now the run stands still. It blocks under `divo_connect_v1`, the controller parks
the question rather than answering it, and the OAuth callback answers it. The run
reads what was actually granted through `connections.resume` and carries on
inside the stream the browser is already watching.

**Deleted, not deprecated:** `google-connection-continuation.ts` in full, worker
and queue; the run-origin recall and identity re-resolve it needed; the client
poll in `admin/src/pages/workspace/chat/live.ts` and its sequence bookkeeping;
and the question of who owns the Connect card's lifetime. The web thread needed
no new mechanism, because the run it was already streaming never stopped.

**The cost, accepted deliberately:** a waiting run holds the member's admission
slot, so they cannot start another request while the card is up. Bounded by the
intent, which expires in 10 minutes against a 20 minute admission slot and a
30 minute run timeout. Those four numbers nest correctly, each outer one
backstopping the inner, so no layer can cut short a wait an inner layer still
considers live. Verified 2026-08-21 by reading each constant.

### A dev image tag now names its own commit

A Development deploy ran `prisma db push` with a schema 19 lines behind its own
database and was told it was about to drop four columns holding real rows.

The database was correct. `prisma migrate diff` against it returned
`-- This is an empty migration.` The image was wrong.

`publish-development-images` retagged `dev-latest` for any component whose paths
had not changed since the previous push. `dev-latest` only moves when a build
happens, so a push that changed a component and then failed CI never built it and
left the alias on pre-change code. The next unrelated push read that component as
unchanged and stamped the stale image with a SHA it had never been built from.

The repository already carried the guard for this: a step comparing the image's
`org.opencontainers.image.revision` label against the commit. It was conditioned
on having built, so it was skipped on the one path that could fail it.

Every component is built now. The retag step is gone, along with the
`development-image-plan` job whose outputs nobody read and a flag that could only
ever say true.

---

## 2. Commits, in order

| commit | what |
|---|---|
| `a7a4f5cd3` | the waiting run: container blocks, controller parks, backend resumes; continuation worker deleted |
| `fa9964962` | stale-image check in `scripts/dev-stack.sh`; the callback closes an ask nobody caught |
| `99d0f2d66` | the resume carries the run's execution provenance |
| `7d233a8d7` | the resume message names its field instead of saying "above" |
| `98c2a064a` | a resumed run answers with its own words |
| `3ee6ba648` | the backend CI job gets the stylesheet its test reads |
| `64e2618c8` | a dev image tag names the commit it was built from |

Merged to `main` as `298e3e159` via
[PR #129](https://github.com/relicwavetechnologies/zoho-automation/pull/129),
checks skipped at Abhishek's instruction.

---

## 3. Where the pieces live

Paths verified 2026-08-21 by opening each one.

**Container**

- `divo-pi/divo/extensions/divo-gateway/approval-gate.ts` — `DIVO_CONNECT_PROTOCOL_TITLE`, `awaitConnectionAsk`
- `divo-pi/divo/extensions/divo-gateway/gateway-execution.ts` — handles `connection_pending` **before** the runtime-channel guard, which is the ordering the whole flow rests on
- `divo-pi/divo/runtime-ask-registry.mjs` — parks questions, owns the deadline and the abandoned run
- `divo-pi/divo/approval-responder.mjs` — `createRuntimeExtensionResponder`, delegating everything else to the headless policy
- `divo-pi/divo/local-rpc-server.mjs` — `POST /v1/runtime-asks/:askId`, and `pendingAsks` on `/health`

**Backend**

- `advance-backend/src/application/connections/connection-resume.ts` — claims atomically, checks ownership, reads granted scopes, withdraws the card, clears the pending authorization
- `advance-backend/src/application/connections/connection-ask-courier.ts` — posts the answer to the controller
- `advance-backend/src/application/connections/google-granted-scopes.ts` — the one place that says what Google actually returned
- `advance-backend/src/http/google/google-connection.routes.ts` — the callback answers the waiting run
- `advance-backend/src/application/gateway/gateway.types.ts` — `connection_pending` status, `connections.resume` op

**Tooling**

- `scripts/dev-stack.sh` — `start|status|stop|logs|build`, and the stale-image check
- `.github/workflows/ci.yml` — always build, never retag

---

## 4. Deployment state

Both green, both verified serving, 2026-08-21.

| | run | serving |
|---|---|---|
| Production, `main` | [32486288191](https://github.com/relicwavetechnologies/zoho-automation/actions/runs/32486288191) | `divo.outreachdeal.com` → 200 |
| Development, `dev` | [32486602498](https://github.com/relicwavetechnologies/zoho-automation/actions/runs/32486602498) | `app-dev.103.172.92.187.sslip.io` → 200 |

Production ran with `apply_schema=true` and passed the schema step with no
data-loss warning, so the production database was in sync the same way dev's was.
Development ran with `apply_development_schema=false`, because the database was
already proved identical to the schema and there was nothing to apply.

Before deploying dev I read the schema inside the newly built backend image:
3161 lines, matching `advance-backend/prisma/schema.prisma` line for line, with
all four publish columns and `personalApprovalsJson` present. The image it
replaced had 3142 lines and none of them. That is the retag fix proved in
practice rather than in principle.

**One thing that was transient, so nobody hunts it again.** The first production
deploy hung 2 hours 40 minutes on "Smoke published Pi image" against a 10 to 12
minute baseline. Both commands in that step were reproduced locally inside the
container: `npm run divo:check` passes in 1.6s, and the Pi CLI prints `0.80.3`
and exits 0. The re-dispatch cleared the same step normally. It was the
`docker pull` opening the step, not the code.

---

## 5. What is proven, and what is not

**Proven.** Backend 4003 tests pass. Container 552 across the controller and
extension suites. Admin 451, plus `tsc -b` and `pnpm build`. The container holds
a turn open: a Development run on 2026-08-20 waited 36 seconds between sending
the card and the member connecting, and the proof is a gateway call at 04:46:20
that could only have come from a live run.

**Not proven.** `connections.resume` has never completed against a real backend.
Every live attempt so far died at a different hop, and each one only surfaced by
running it: the container image was stale, then the resume dropped its execution
provenance, then the runtime overwrote the answer. Each was fixed and the next
appeared. There is no reason to believe a fourth exists, and no evidence that one
does not.

**Also never proven:** the classifier path in Phase 1 of the connect plan. Every
successful run so far reached the connect ask through the front-door tool, not
through a real Google 403.

---

## 6. Open items

1. **The live gate.** Run the connect flow once on Development. `## 12. Next
   action` in [`scope-gap-connect-ask.md`](./scope-gap-connect-ask.md) has the
   steps and the diagnostic split. This is the one thing standing between "built"
   and "working".
2. **Another agent's uncommitted files.** `AGENTS.md`,
   `admin/src/components/admin/brand-mark.tsx`, and
   `admin/src/pages/workspace/data/use-skills.ts` are modified and not committed.
   `use-skills.ts` still fails typecheck on `humanizeId`, so it must not be
   pushed until its author fixes it.
3. **`docs/LOCAL-RUNBOOK.md` is written and uncommitted.** It was held back
   because committing it would have swept in `AGENTS.md`. Safe to commit alone
   whenever.
4. **`scripts/dev-stack.sh stop` is the one path never exercised**, because
   testing it would have torn down the stack under a live test.

---

## 7. Two things worth carrying forward

**A tag is a claim about provenance.** The dev image was not merely out of date.
It asserted a commit it had never been built from, and every downstream check
trusted that assertion. The guard that would have caught it existed and was
skipped on exactly the path that could fail it. When adding a cheap reuse path,
ask which check it routes around.

**A stale container is the quietest failure in this stack.** `divo-pi/Dockerfile`
does `COPY . .`, so everything Pi runs is baked in at build time. Restarting the
controller reloads the host's `.mjs` files and nothing else. Every service
reports healthy and the code you just wrote is simply not the code that runs.
`scripts/dev-stack.sh status` now says so out loud.
