# Pi typed tool surface

> Status: **Phase 0 in progress**
>
> Last updated: **2026-08-10**
>
> Confidence: **88%**
>
> Scope: cloud Pi extension layer only. No backend schema, route, or
> permission change. Runs beside
> `pi-native-skills-and-terminal-export-simplification.md` without sharing a
> file.

## 1. Target outcome

Replace the single `divo_gateway` mega-tool with one typed Pi tool per
reachable backend capability, using the JSON Schema the backend already emits.

```text
today:  Zod argsSchema -> zod-to-json-schema -> bootstrap -> JSON.stringify
        -> prompt prose -> model imitates -> untyped args -> backend safeParse
        -> error as prose -> model retries

target: Zod argsSchema -> zod-to-json-schema -> bootstrap
        -> pi.registerTool({ parameters }) -> provider constrains generation
        -> Pi validates locally -> backend executes
```

The backend remains the only authority for identity, RBAC, connections, SaaS
credentials, approvals, schemas, rate limits, and audit. Pi gains local
*validation*; it never gains local *authorization*.

## 2. Locked decisions

1. **No backend changes.** The schemas already ship. `serializeToolArgsSchema`
   feeds both `tools.list` and the run bootstrap. Consume what exists.
2. **Flat surface, one Pi tool per canonical backend tool ID.** Not per family,
   not one per operation. `CANONICAL_TOOL_IDS` is a compile-time constant, so
   tool *names* are static even though *registration* is per-run and
   RBAC-scoped.
3. **Static names, dynamic registration.** `runtime-manifest.json`
   `toolAllowlist` carries all canonical names. Only reachable tools are
   registered for a given run.
4. **Denial is visible, never absent.** A tool the user cannot reach must not
   silently vanish; absence is what makes the model invent confident false
   reasons. See `project_divo_denial_vs_absence`.
5. **Guidance moves to the tool it belongs to.** Every bullet in the
   `divo_gateway` `promptGuidelines` block is either a schema constraint (goes
   into `parameters`) or a per-tool rule (goes into that tool's
   `promptGuidelines`). Nothing survives as a global bullet by default.
6. **Skills keep "when", tools take "how".** Typed schemas remove call syntax
   from skill text. Workflow sequence and company policy stay in skills. This
   makes the native-skill work smaller and sharper, not redundant.
7. **`divo_gateway` is deleted, not deprecated in place** — but only after the
   typed path is proven on a real cloud run. Both may coexist during Phase 3
   only.
8. **Do not touch `divo-gateway/index.ts` until Phase 4.** It is the one file
   the parallel export project may also edit.

## 3. Current state

- `divo_gateway` exposes 13 operations behind one flat `payload` object where
  every field is optional, because it must hold the union of all operations.
  `op: "connections.list"` with `filePath` set passes validation.
- Two mechanisms compensate: `gateway-arguments.ts` normalizes raw calls by
  hand, and ~34 `promptGuidelines` bullets carry rules a schema would enforce.
- The backend already produces JSON Schema per tool via
  `serializeToolArgsSchema` (`zod-to-json-schema`), from the
  `argsSchema: ZodType` that every `Tool` declares in `tool.contract.ts`.
- It already ships to Pi in the run bootstrap
  (`work-bootstrap.service.ts`) and in `tools.list`
  (`gateway-dispatcher.ts`).
- Pi then discards its structure: `work-bootstrap.ts` renders
  `args schema: ${JSON.stringify(tool.argsSchema)}` into the prompt as text.
- Pi's `registerTool` accepts **raw JSON Schema**, not only TypeBox:
  `validateToolArguments` branches on `hasTypeBoxMetadata` and runs a dedicated
  JSON-Schema coercion path before `Compile(schema).Check(args)`.
- `registerTool` post-load is supported; the loader calls `runtime.refreshTools()`
  after each registration.
- 38 canonical tool IDs across 18 families are statically defined in
  `TOOL_CAPABILITY_DEFINITIONS`.

## 4. Delivery phases

### Phase 0 — Prove the schema round-trip

- [x] Confirm a real backend `argsSchema` compiles under Pi's validator and
      rejects a malformed call with a readable error.
- [x] Confirm coercion behaves on the shapes Divo actually emits: enums,
      nested objects, arrays, optional fields, `additionalProperties`.
- [x] Record any JSON Schema keyword Pi's compiler rejects; those become the
      sanitizer's job, not a reason to abandon the approach.

Result: six real tool contracts (`zohoBooks`, `zohoCrm`, `webSearch`,
`knowledge`, `larkTask`, `scheduledWorkflows`) were serialized through the
backend's own `serializeToolArgsSchema` and fed to Pi's `validateToolArguments`.
All six compiled. Every one rejected empty arguments naming its exact required
properties. No keyword needed sanitizing — the serializer emits only
`type/properties/required/enum/const/anyOf/additionalProperties/minimum/maximum/
exclusiveMinimum/minLength/maxLength/minItems/maxItems/description/$schema`, and
the draft-07 `$schema` annotation compiles untouched. `$refStrategy: 'none'`
means no `$ref` or `$defs` reach Pi.

Two results carry the argument on their own:

- `larkTask` rejects `op: "notARealOp"` with *must be equal to one of the
  allowed values*. The operation enum is now mechanical.
- `zohoBooks` rejects `connectionId: "the-finance-account"` with *must match
  format "uuid"*. The standing guideline "never guess connection IDs" is a
  format constraint the model cannot violate rather than a bullet it can miss.

Pi also coerces a near-miss primitive (`query: 42` → `"42"`) instead of failing
the run, which matches how Divo already prefers to treat malformed input.

Contract test: `divo-gateway/backend-schema-contract.test.ts`, 7/7. Gateway
extension suite 148/148.

**Exit gate:** met — a test feeds real serialized backend schemas to Pi's
validator and asserts accept/reject on known-good and known-bad arguments.

**Rollback:** none needed; no shipped behavior changed.

### Phase 1 — Typed tool registration module

- [x] New file `divo-gateway/typed-tools.ts`. The only edit to an existing file
      is adding the two new test files to the extension `test` script.
- [x] Name tools `divo_<canonical_tool_id>` in snake case; keep the mapping
      total and reversible.
- [x] `parameters` comes from `argsSchema`; `description` from the backend
      description; `promptGuidelines` from `parameterDocs` split into bullets.
- [x] Sanitize schemas before registration: strip `$schema`/`$id`/`title`,
      require an object root with properties, refuse a surviving `$ref`.
- [x] Reject rather than guess: a tool whose schema is unusable is not
      registered, and the reason is returned with its tool ID.
- [x] Register an unreachable tool as an explicit denial rather than omitting
      it, so absence never stands in for a permission decision.
- [x] Unit-test the mapper against real serialized schemas.
- [ ] `registerTypedTools(pi, bootstrap, invoke)` wrapper that turns each
      definition into a `pi.registerTool` call. **Deferred into Phase 2** — see
      below.

`buildTypedTools` is deliberately pure: bootstrap in, definitions out, no Pi
and no network. The execute path has to reuse `executeGatewayRequest` and
`formatGatewayResponse` so trace, approval, and audit behavior stay identical,
and both `gateway-client.ts` and `gateway-execution.ts` currently carry
uncommitted work from the export project. Building the wrapper on top of files
being rewritten would entangle the two efforts for no gain, so the wrapper moves
to Phase 2 where the wiring belongs anyway.

Proof: `typed-tools.test.ts` 12/12, `backend-schema-contract.test.ts` 7/7,
together 19/19 in isolation. `tsc --strict --noEmit` clean on the module.
Full gateway extension suite 162/162, and divo runtime 171/171.

**Exit gate:** met — focused suite green, module unused in production paths.

**Rollback:** delete `typed-tools.ts`, `typed-tools.test.ts`,
`backend-schema-contract.test.ts`, `backend-schema-fixture.json`, and revert the
one-line `package.json` test-script change.

### Phase 2 — Wire registration into the run

- [ ] Register typed tools once the run bootstrap is known, before the agent
      starts.
- [ ] Add all 38 canonical names to `runtime-manifest.json` `toolAllowlist`.
- [ ] Register only tools reachable for the run; carry `allowedActions` into
      each tool's guidance.
- [ ] For a tool the department has but the member cannot use, register a
      denial stub that returns the backend's own permission wording.
- [ ] Route every typed execute through the existing gateway client so trace,
      approval, and audit behavior are unchanged.
- [ ] Keep `divo_gateway` registered and untouched.

**Exit gate:** a cloud run shows both surfaces; typed tools appear in the model
tool list with real schemas; no regression in the existing suites.

**Rollback:** stop calling `registerTypedTools`; the manifest addition is inert.

### Phase 3 — Prove typed beats prose

- [ ] Measure on the same prompts, typed path versus gateway path: tool-call
      retries, invalid-argument errors, steps to completion, wall clock,
      prompt tokens.
- [ ] Include the cases that motivated the guideline bullets: a missing
      `provider` on `connections.list`, a guessed `connectionId`, a
      `tools.invoke` with wrong `args` shape.
- [ ] Confirm the provider constrains generation against the registered
      schemas rather than only post-validating.
- [ ] Record the numbers in this document, not in a commit message.

**Exit gate:** typed path is measurably better on retries and invalid
arguments, or the plan stops here with the evidence written down.

**Rollback:** keep `divo_gateway`; the typed surface stays off.

### Phase 4 — Delete the mega-tool

- [ ] Remove the `divo_gateway` registration and its `promptGuidelines` block.
- [ ] Redistribute any surviving bullet to the one tool it constrains; delete
      the rest with a note on which schema now enforces it.
- [ ] Delete the parts of `gateway-arguments.ts` that exist only to untangle
      the 13-operation union; move whatever remains to per-tool
      `prepareArguments`.
- [ ] Keep `divo_skill_resolve`; it is routing, not a capability call.
- [ ] Remove `args schema:` stringification from `formatWorkBootstrap`; the
      schema now arrives as a tool definition.
- [ ] Update `runtime-manifest.json` to drop `divo_gateway`.
- [ ] Coordinate: this phase edits `index.ts`. Confirm the export project is
      not mid-edit in the same file before starting.

**Exit gate:** one cloud run completes a governed Zoho and Google flow with no
`divo_gateway` registered.

**Rollback:** revert the single commit; nothing else depends on the deletion.

### Phase 5 — Harvest what the typed surface unlocks

- [ ] Mark independent read tools `executionMode: "parallel"`; measure the
      step-count effect on multi-page and multi-provider work.
- [ ] Give the largest families per-tool `prepareArguments` where a real
      compatibility shim is still needed.
- [ ] Emit per-tool telemetry so error rate is attributable to a capability
      rather than to `divo_gateway`. This is what Phase 9 of the export plan
      asks for and cannot currently get.
- [ ] Evaluate `renderCall`/`renderResult` per tool against the desktop tool
      cards already built downstream.
- [ ] Re-measure prompt tokens after guidance redistribution.

**Exit gate:** measured step-count and token deltas recorded here.

## 5. Coordination with the export project

`pi-native-skills-and-terminal-export-simplification.md` is active. Its live
surface is backend `skills/*`, `tools/families/zoho-*`, `zoho/*`,
`desktop-auth.routes.ts`, and `local-rpc-controller.mjs`.

This project touches none of those. Phases 0–3 add new files only. Phase 4 is
the sole edit to a shared file (`divo-gateway/index.ts`) and is deliberately
last.

Commit with explicit pathspecs. Never `git add -A`.

## 6. Risks

- **Schema fidelity.** `zod-to-json-schema` output may contain keywords Pi's
  compiler does not implement. Phase 0 exists to find these before any wiring.
- **Prompt size.** A user reaching all 38 tools could cost more prompt than the
  compact catalogue. Measured in Phase 3; family grouping is the fallback, and
  guidance removal is a large offsetting credit.
- **Denial regression.** Registering only reachable tools is exactly the shape
  that caused the earlier "exception explosion". The denial stub in Phase 2 is
  mandatory, not optional polish.
- **Two surfaces at once.** During Phase 3 the model can see both; it may
  prefer the familiar one. Guidance must state the typed tool is primary.
