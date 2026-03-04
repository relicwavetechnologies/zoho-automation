# V1 LangGraph Runtime Contract

## Purpose
Define the runtime contract for the V1 orchestration engine switch to LangGraph while preserving compatibility with existing V0 DTOs, checkpoints, HITL, and admin runtime controls.

## Engine Selection Contract

Environment flags:

```env
ORCHESTRATION_ENGINE=langgraph|legacy
ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true|false
```

Rules:
1. Default engine is `langgraph`.
2. If LangGraph execution fails and rollback is enabled, runtime retries once through `legacy` engine for the same task execution request.
3. Worker and admin runtime APIs must surface actual engine used (`engineUsed`) in task metadata.

## State Schema (`LangGraphState`)

Required state keys:

```ts
{
  task: OrchestrationTaskDTO
  message: NormalizedIncomingMessageDTO
  route: {
    intent: "zoho_read" | "write_intent" | "general"
    complexityLevel: 1 | 2 | 3 | 4 | 5
    executionMode: "sequential" | "parallel" | "mixed"
  }
  plan: string[]
  agentInvocations: AgentInvokeInputDTO[]
  agentResults: AgentResultDTO[]
  hitl?: HITLActionDTO
  synthesis?: {
    text: string
    taskStatus: OrchestrationTaskStatus
  }
  runtimeMeta: {
    engine: "langgraph"
    threadId: string
    node: string
    stepHistory: string[]
    routeIntent?: string
    retryCount?: number
  }
  errors: ErrorDTO[]
  finalStatus?: OrchestrationTaskStatus
}
```

## Node Graph Contract

Primary graph:
1. `route.classify`
2. `plan.build`
3. `hitl.gate`
4. `agent.dispatch`
5. `error.classify_retry` (conditional branch)
6. `synthesis.compose`
7. `response.send`
8. `finalize.task`

## Transition Rules

1. `hitl.gate`:
- if destructive intent or write keywords present, create HITL action and block on resolution.
- `cancelled`/`expired` resolution sets `finalStatus=cancelled` and routes directly to `finalize.task`.
- `confirmed` resumes to `agent.dispatch`.

2. `agent.dispatch`:
- if any failed agent result is retriable, route to `error.classify_retry`.
- otherwise route to `synthesis.compose`.

3. `error.classify_retry`:
- bounded retry attempts for retriable agent failures.
- on terminal failure, set failure synthesis and `finalStatus=failed`.

4. `synthesis.compose`:
- always sets synthesis output (`text`, `taskStatus`) unless already set by terminal error handling.

5. `response.send`:
- sends synthesis text through channel adapter.

6. `finalize.task`:
- emits final task status and last node metadata.

## Checkpoint and Recovery Contract

1. Checkpoints are written at each node boundary using existing `checkpointRepository.save(taskId, node, state)`.
2. Checkpoint state must include recovery message fields:
- `channel`, `messageId`, `chatId`, `chatType`, `timestamp`, `userId`, `text`.
3. Runtime metadata in checkpoint state includes:
- `runtimeMeta.engine`, `runtimeMeta.threadId`, `runtimeMeta.node`, `runtimeMeta.stepHistory`.
4. Existing admin recovery endpoint remains valid and requeues tasks using latest checkpoint message payload.

## Runtime Task Metadata Contract (Additive)

Runtime task snapshots expose:
- `engine?: "legacy" | "langgraph"`
- `graphThreadId?: string`
- `graphNode?: string`
- `graphStepHistory?: string[]`
- `routeIntent?: string`

Admin runtime APIs include these fields in:
- `GET /api/admin/runtime/tasks`
- `GET /api/admin/runtime/tasks/:taskId`
- `GET /api/admin/runtime/tasks/:taskId/trace` (transition history)

## Failure Semantics

1. Worker control signal cancellation still wins at node boundaries.
2. Terminal task statuses:
- `done`
- `failed`
- `cancelled`
3. `hitl` remains transient and is not considered completed execution.
4. Rollback failures are logged with structured error classification and task/message correlation IDs.

## Compatibility Guarantees

1. Existing V0 DTO types are unchanged except additive runtime metadata.
2. Existing webhook ingestion and channel adapter seams stay intact.
3. Existing HITL confirm/cancel commands and timeout behavior are preserved.
4. Existing checkpoint repository/storage keys are unchanged.
