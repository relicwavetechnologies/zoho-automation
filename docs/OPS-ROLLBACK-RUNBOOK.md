# Ops Rollback Runbook (LangGraph <-> Legacy)

This runbook defines the emergency rollback drill and real rollback procedure for orchestration engine mode.

## Scope

Applies to backend runtime engine selection controlled by:

1. `ORCHESTRATION_ENGINE=langgraph|legacy`
2. `ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true|false`

## Trigger Conditions

Start rollback when one or more of the following is true:

1. sustained runtime failures on LangGraph path with user-visible impact
2. repeated classified routing/planning/synthesis failures that exceed acceptable threshold
3. incident commander asks for immediate stabilization under legacy runtime

## Prechecks

1. Confirm latest release gate evidence exists:
   1. `docs/evidence/v1-release-gate-<timestamp>.json`
   2. `docs/evidence/v1-release-gate-<timestamp>.md`
2. Confirm current env values:
   1. `ORCHESTRATION_ENGINE`
   2. `ORCHESTRATION_LEGACY_ROLLBACK_ENABLED`
3. Ensure admin runtime API is reachable.
4. Ensure operator has admin bearer token for runtime validation.

## Rollback Drill Procedure

### Phase A: Validate Current Mode (LangGraph)

1. Set env for API validation (optional but recommended):
   1. `ROLLBACK_DRILL_BASE_URL=http://localhost:8000`
   2. `ROLLBACK_DRILL_ADMIN_TOKEN=<admin bearer token>`
2. Run:

```bash
node backend/scripts/validate-v1-rollback-drill.cjs --expected-engine=langgraph
```

3. Expected result:
   1. `ok=true`
   2. `configuredEngine=langgraph`
   3. API validation `pass` (or `skipped` if API check intentionally disabled)

### Phase B: Emergency Switch to Legacy

1. Update runtime env:

```bash
ORCHESTRATION_ENGINE=legacy
ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true
```

2. Restart backend process.
3. Run:

```bash
node backend/scripts/validate-v1-rollback-drill.cjs --expected-engine=legacy
```

4. Validate:
   1. new tasks process successfully
   2. admin runtime list/trace shows effective engine `legacy`

### Phase C: Restore Default Mode

1. Revert env to:

```bash
ORCHESTRATION_ENGINE=langgraph
ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true
```

2. Restart backend process.
3. Run:

```bash
node backend/scripts/validate-v1-rollback-drill.cjs --expected-engine=langgraph
```

4. Validate resumed normal operation.

## Validation Commands (Package Aliases)

From `backend/`:

1. `pnpm run validate:rollback:langgraph`
2. `pnpm run validate:rollback:legacy`

## Failure Handling

If rollback validation fails:

1. Check backend logs for `orchestration.task.engine.rollback` and engine metadata in runtime traces.
2. Check `/api/admin/runtime/tasks` and `/api/admin/runtime/tasks/:taskId/trace` for `configuredEngine`, `engineUsed`, `rolledBackFrom`, `rollbackReasonCode`.
3. Keep `legacy` mode active and escalate incident with evidence artifacts.

## Evidence Capture

Record the following in incident/release notes:

1. timestamped command outputs for Phase A/B/C
2. task IDs used to validate runtime behavior
3. admin runtime API samples proving effective engine
4. any deviations and corrective action

## Notes

1. Script supports config-only validation if API token/base URL is not provided.
2. For strict API enforcement, set `ROLLBACK_DRILL_REQUIRE_API=true`.
