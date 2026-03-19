# LangGraph Runtime Rebuild Handoff

## Short Answer First

Yes, this can be built while keeping the current Vercel path safe.

That is the correct way to do it.

Do **not** replace the current runtime in one shot.

Build the LangGraph runtime as a parallel engine behind feature flags, with:
- per-channel flags
- per-company flags
- shadow mode
- replay testing
- controlled cutover

That lets the current Vercel path keep serving production traffic while the new runtime is validated.

Also, do not try to port every tool at once.

For the LangGraph rebuild:
- define a new LangGraph-native tool contract
- port only a minimal core tool set first
- prove the runtime with those tools
- expand the tool surface later

## Why Rebuild At All

The current runtime problems are mostly architecture problems, not model-quality problems:

- desktop and Lark behave differently in too many places
- approvals are split across backend and UI flows
- some history is durable, some is in-memory only
- duplicate tool traces and repeated planning loops are hard to reason about
- delivery logic is too close to execution logic

A clean LangGraph rebuild can be better than the current setup if we enforce one rule:

> one runtime core, two channel adapters

Not:
- one desktop orchestration path
- another Lark orchestration path
- extra legacy fallbacks sprinkled across both

It can also be cleaner than the current Vercel runtime because the current tool surface grew incrementally. The rebuild is a chance to standardize tool syntax, result envelopes, approval behavior, and loop control instead of carrying forward inconsistent wrappers.

## Non-Negotiable Design Principles

1. One canonical runtime state object
2. One normalized durable conversation history model
3. One shared context builder
4. One approval pipeline
5. One tool invocation contract
6. Desktop and Lark are delivery/capability adapters only
7. No channel should own business logic
8. No in-memory-only history for Lark
9. No hidden fallback logic inside tools
10. Loop control must be explicit and stateful
11. The new runtime must use a fresh LangGraph-native tool contract
12. Only a minimal core tool set should be ported first

## Current Runtime Facts To Preserve

The rebuild must preserve these existing product rules:

- Department-scoped runtime resolution
- Department prompt + structured skills + fallback skills markdown if still needed
- Action-group RBAC:
  - `read`
  - `create`
  - `update`
  - `delete`
  - `send`
  - `execute`
- Shared HITL for write-capable actions
- Desktop can use coding/workspace tools
- Lark must not get coding/workspace tools
- Lark needs concise status updates and final messages
- Desktop needs richer streaming/tool trace UX

Relevant current code:

- Desktop runtime:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts)
- Lark runtime:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts)
- Department runtime context:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts)
- Tool action-group enforcement:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts)

The rebuild should preserve runtime rules, but it should not blindly preserve the current tool wrapper structure.

## Current-State Findings From Code

### Desktop and Lark already duplicate runtime logic

The current desktop runtime in [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts) and the current Lark runtime in [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts) both perform:

- conversation-key construction
- prompt assembly
- date-scope inference
- approval detection from tool outputs
- channel delivery decisions

That duplication is the main signal that the rebuild should move shared behavior into one runtime core.

### Current conversation state is not durable enough

[/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/conversation/conversation-memory.store.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/conversation/conversation-memory.store.ts) is an in-memory TTL cache for:

- recent turns
- Lark doc references
- Lark calendar references
- Lark task references
- file references

It is useful as a cache, but it cannot remain the source of truth for cross-process resume, Lark durability, or replay.

### Current task state is also only in memory

[/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/runtime-task.store.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/runtime-task.store.ts) already tracks useful run fields such as:

- status
- plan
- current step
- engine used
- graph node
- graph step history
- HITL action id

Those fields should inform the LangGraph run schema, but the store itself should not be reused as the durable runtime source.

### HITL persistence is the best current reusable primitive

[/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/hitl/hitl-action.repository.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/hitl/hitl-action.repository.ts) and [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/hitl/hitl-action.service.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/hitl/hitl-action.service.ts) already preserve:

- exact action ids
- payload json
- metadata json
- task linkage
- resolution status

The rebuild should wrap or evolve this, not create a second unrelated approval mechanism.

### Department runtime resolution already belongs outside the graph

[/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts) already resolves:

- department id
- department name
- department role slug
- system prompt
- skills markdown
- allowed tool ids
- allowed actions by tool

That should remain an input to a shared context builder rather than being reimplemented across nodes or adapters.

## Safe Coexistence Strategy With Vercel

This is the most important migration decision.

### Recommendation

Keep Vercel as the live production path while building LangGraph in parallel.

### Required Flags

Add runtime selection flags like:

- `runtime.desktop = vercel | langgraph | shadow-langgraph`
- `runtime.lark = vercel | langgraph | shadow-langgraph`
- optional company override
- optional department override for controlled testing

Recommended resolver shape:

```ts
type RuntimeEngineMode = 'vercel' | 'langgraph' | 'shadow-langgraph';

type RuntimeEngineSelection = {
  desktop: RuntimeEngineMode;
  lark: RuntimeEngineMode;
  companyOverrides?: Record<string, Partial<Record<'desktop' | 'lark', RuntimeEngineMode>>>;
  departmentOverrides?: Record<string, Partial<Record<'desktop' | 'lark', RuntimeEngineMode>>>;
};
```

Resolution order:

1. department override
2. company override
3. channel default

### Shadow Mode

Shadow mode means:
- Vercel still produces the real user-visible result
- LangGraph runs in parallel
- LangGraph writes only diagnostics, not user-visible messages or side effects
- compare:
  - chosen tools
  - number of steps
  - final answer quality
  - approval points
  - latency
  - failure reasons

Hard rule for shadow mode:

- LangGraph may persist traces, snapshots, and parity diagnostics
- LangGraph must not send visible channel messages
- LangGraph must not execute mutating side effects

This is the safest way to validate parity.

### Cutover Order

Recommended order:

1. Shadow mode for desktop
2. Shadow mode for Lark
3. LangGraph for desktop internal/testing users
4. LangGraph for Lark internal/testing users
5. Wider rollout

Lark should not be first to cut over, because delivery and duplicate-message errors are harder to debug there.

## LangGraph Tool Migration Strategy

### Important Scope Decision

Yes, the LangGraph pathway should use LangGraph-native tools.

That means the new runtime should not just reuse the current Vercel-facing tool syntax as-is.

Instead:
- keep stable low-level provider/client code where useful
- rebuild the runtime-facing tool contract cleanly
- port only a small core tool set first

### What “LangGraph-Native Tools” Means

Each runtime-facing tool should share one clean contract:

- structured input schema
- explicit action group
- deterministic validation
- centralized permission enforcement
- structured approval-required outcome
- structured success/failure outcome
- optional dedupe/idempotency hints

Conceptually:

```ts
type GraphToolResult =
  | { kind: 'success'; output: unknown; summary: string }
  | { kind: 'approval_required'; pendingAction: PendingApprovalActionInput }
  | { kind: 'authorization_failed'; reason: string }
  | { kind: 'validation_failed'; reason: string; details?: unknown }
  | { kind: 'error'; retriable: boolean; reason: string };
```

This is better than mixing:
- assistant text
- thrown exceptions
- UI assumptions
- partial approval behavior

### Phase-1 Tool Set Only

Do not port everything first.

Port only these tool groups in phase 1:

1. `lark`
2. `coding/workspace`
3. `search`

That is enough to prove:
- desktop vs Lark channel handling
- durable history
- approval flow
- loop control
- tool persistence
- delivery adapters

### Why These Tools First

`lark` proves:
- remote/chat channel behavior
- Lark-specific delivery rules
- non-desktop conversation flow

`coding/workspace` proves:
- desktop-only capability handling
- command/file approvals
- continuation after local actions
- the most failure-prone loop patterns

`search` proves:
- non-mutating tool usage
- source-heavy workflows
- read/analyze flows without extra side effects

If these three groups are not clean, adding Zoho/Books/Google first will only hide runtime problems.

### Do Not Port These In Phase 1

Leave these on Vercel initially:
- Zoho CRM
- Zoho Books
- Gmail
- Drive
- Calendar
- Outreach

Only port them after the new runtime is already stable with the core tool set.

### Reuse Strategy

For phase-1 tools:
- low-level clients can be reused if stable
- runtime-facing wrappers should be rewritten
- approval integration should be rewritten
- result envelopes should be rewritten

So the correct statement is:
- rebuild the tool syntax/contract
- do not necessarily rewrite every provider client on day one

## Canonical Data Model

### 1. Conversation

One conversation record for both channels.

Fields:
- `id`
- `companyId`
- `departmentId`
- `channel` (`desktop` or `lark`)
- `channelConversationKey`
  - desktop: thread id
  - lark: chat id
- `createdByUserId` or channel actor identity
- `status`
- `title`
- `createdAt`
- `updatedAt`

Notes:
- store both the normalized runtime key and the raw channel key
- preserve current semantics:
  - desktop currently keys as `desktop:${threadId}`
  - lark currently keys as `${channel}:${chatId}`

### 2. ConversationMessage

Normalized message history shared across channels.

Fields:
- `id`
- `conversationId`
- `role` (`system`, `user`, `assistant`, `tool`, `status`)
- `sourceChannel`
- `sourceMessageId` if any
- `contentJson`
- `attachmentsJson`
- `toolCallJson`
- `toolResultJson`
- `visibility`
- `createdAt`

This becomes the durable source of history.

Desktop DB history and Lark history should both map into this.

Add:
- `runId` nullable
- `sequence` monotonic per conversation
- `dedupeKey`
- `messageKind`:
  - `chat`
  - `tool_call`
  - `tool_result`
  - `status`
  - `approval_request`
  - `approval_resolution`

### 3. RuntimeRun

Every execution attempt gets its own run record.

Fields:
- `id`
- `conversationId`
- `engine` (`vercel`, `langgraph`)
- `status`
- `stepCount`
- `startedAt`
- `finishedAt`
- `stopReason`
- `errorJson`
- `channel`
- `traceJson`

Add:
- `engineMode` (`primary` or `shadow`)
- `entrypoint`
- `parentRunId` for resume/replay chains
- `currentNode`
- `stepHistoryJson`

### 4. PendingApprovalAction

Approval must be first-class state.

Fields:
- `id`
- `conversationId`
- `runId`
- `toolId`
- `actionGroup`
- `kind`
- `summary`
- `payloadJson`
- `riskLevel`
- `status`
- `channel`
- `requestedBy`
- `approvedBy`
- `approvedAt`
- `rejectedAt`
- `expiresAt`
- `executionResultJson`

Add:
- `idempotencyKey`
- `decisionMessageId`
- `resolutionReason`

### 5. RuntimeSnapshot

Optional but useful for replay/debug.

Fields:
- `id`
- `runId`
- `stepIndex`
- `nodeName`
- `stateJson`
- `createdAt`

Use sparingly to avoid storage blow-up.

Recommended snapshot policy:
- always snapshot before first model call
- always snapshot before waiting for approval
- always snapshot on failure
- snapshot after tool results only for sampled or failing runs

## Canonical Runtime State

This should be the in-graph state object.

Suggested shape:

```ts
type RuntimeState = {
  runId: string;
  conversationId: string;
  companyId: string;
  departmentId?: string;
  channel: 'desktop' | 'lark';
  actor: {
    userId?: string;
    email?: string;
    larkUserId?: string;
    larkTenantKey?: string;
  };
  capabilities: {
    allowedToolIds: string[];
    allowedActionsByTool: Record<string, string[]>;
    blockedToolIds: string[];
  };
  workflow: {
    currentNode: string;
    stepIndex: number;
    maxSteps: number;
  };
  promptContext: {
    baseSystemPrompt: string;
    departmentPrompt?: string;
    skills: Array<{ id: string; name: string; markdown: string }>;
    channelGuidance: string;
  };
  history: NormalizedMessage[];
  incomingMessage?: NormalizedMessage;
  attachments: NormalizedAttachment[];
  recentToolResults: ToolResult[];
  pendingApproval?: PendingApprovalState;
  delivery: {
    statusMessageId?: string;
    pendingBlocks?: DeliveryBlock[];
  };
  finalResponse?: {
    assistantMessage: NormalizedMessage;
    statusSummary?: string;
  };
  error?: {
    type: string;
    message: string;
    retriable: boolean;
  };
};
```

This state should be persisted/recoverable enough to resume after approval or process restart.

Recommended production shape:

```ts
type RuntimeState = {
  version: 1;
  run: {
    id: string;
    mode: 'primary' | 'shadow';
    channel: 'desktop' | 'lark';
    entrypoint: 'desktop_send' | 'desktop_act' | 'lark_message' | 'resume_after_approval';
    currentNode: string;
    stepIndex: number;
    maxSteps: number;
    stopReason?: string;
  };
  conversation: {
    id: string;
    key: string;
    rawChannelKey: string;
    companyId: string;
    departmentId?: string;
    status: 'active' | 'waiting_for_approval' | 'completed' | 'failed';
  };
  actor: {
    userId?: string;
    requesterEmail?: string;
    aiRole?: string;
    linkedUserId?: string;
    larkUserId?: string;
    larkOpenId?: string;
    larkTenantKey?: string;
  };
  permissions: {
    allowedToolIds: string[];
    allowedActionsByTool: Record<string, string[]>;
    blockedToolIds: string[];
  };
  prompt: {
    baseSystemPrompt: string;
    departmentPrompt?: string;
    skillsMarkdown?: string;
    channelInstructions: string;
    dateScope?: string;
  };
  history: {
    messages: Array<{
      id: string;
      role: 'system' | 'user' | 'assistant' | 'tool' | 'status';
      messageKind: 'chat' | 'tool_call' | 'tool_result' | 'status' | 'approval_request' | 'approval_resolution';
      content: string;
      createdAt: string;
      runId?: string;
      dedupeKey?: string;
    }>;
    refs: {
      latestLarkDoc?: Record<string, unknown>;
      latestLarkCalendarEvent?: Record<string, unknown>;
      latestLarkTask?: Record<string, unknown>;
      recentFiles?: Array<Record<string, unknown>>;
    };
  };
  approval?: {
    pendingApprovalId: string;
    status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed';
    toolId: string;
    actionGroup: 'create' | 'update' | 'delete' | 'send' | 'execute';
  };
  delivery: {
    statusMessageId?: string;
    finalMessageId?: string;
    sentDedupeKeys: string[];
  };
  diagnostics: {
    repeatedToolCallCount: Record<string, number>;
    repeatedValidationFailureCount: Record<string, number>;
    repeatedPlanHashCount: Record<string, number>;
    repeatedDeliveryKeyCount: Record<string, number>;
  };
  failure?: {
    code: string;
    message: string;
    retriable: boolean;
  };
};
```

## Context Management

This is where the rebuild must be better than current behavior.

### One Shared Context Builder

Create one service:

- `RuntimeContextBuilder`

Responsibilities:
- load department runtime context
- load normalized conversation history
- load recent attachments
- load recent tool results
- load relevant skills
- apply channel-specific constraints
- produce:
  - final system prompt
  - model messages
  - runtime capability map

Suggested interface:

```ts
interface RuntimeContextBuilder {
  build(input: {
    channel: 'desktop' | 'lark';
    conversationId: string;
    incomingMessageId?: string;
    runId: string;
    companyId: string;
    actor: {
      userId?: string;
      linkedUserId?: string;
      aiRole?: string;
    };
    resumeFromApprovalId?: string;
  }): Promise<{
    statePatch: Partial<RuntimeState>;
    modelMessages: ModelMessage[];
    systemPrompt: string;
  }>;
}
```

This builder should absorb logic currently duplicated across both Vercel engines:
- date-scope inference
- department prompt resolution
- conversation-ref hydration
- attached-file context preparation
- channel-specific tool blocking

### Inputs To Context Builder

1. Base system prompt
2. Department system prompt
3. Structured skills
4. Relevant durable message history
5. Recent tool results
6. Attachment/file references
7. Channel rules
8. Current pending approval state if resuming

### What Not To Inject Blindly

Do not dump:
- full raw tool traces every step
- entire file contents every turn
- repeated long status text

Instead, summarize and reference.

### History Windowing

Use durable normalized history plus a controlled selection strategy:

- latest user turns
- latest assistant turns
- latest tool results that still matter
- latest attachment references
- system prompt layers

Use explicit trimming rules, not a vague in-memory TTL only.

### Attachments

Normalize attachments into reusable references:
- file id
- name
- MIME type
- extracted text summary
- whether vision content is available

If a file has already been read and summarized, the runtime should reuse the stored artifact instead of “reading it again and again” unless there is a reason.

## Graph Structure

Keep the graph simple.

Recommended nodes:

1. `load_run_context`
2. `build_prompt_context`
3. `model_decide`
4. `tool_router`
5. `execute_tool`
6. `store_tool_result`
7. `check_approval_required`
8. `await_approval`
9. `resume_after_approval`
10. `synthesize_response`
11. `deliver_response`
12. `persist_and_finish`
13. `fail_run`

Recommended edge rules:

1. `load_run_context -> build_prompt_context`
2. `build_prompt_context -> model_decide`
3. `model_decide -> synthesize_response` when no tool call is needed
4. `model_decide -> tool_router` when tool calls are present
5. `tool_router -> execute_tool`
6. `execute_tool -> store_tool_result`
7. `store_tool_result -> check_approval_required`
8. `check_approval_required -> await_approval` when outcome is `approval_required`
9. `check_approval_required -> model_decide` when more tool/model work is needed
10. `check_approval_required -> synthesize_response` when the run is ready to answer
11. `await_approval -> persist_and_finish` with stop reason `needs_approval`
12. `resume_after_approval -> store_tool_result`
13. `synthesize_response -> deliver_response`
14. `deliver_response -> persist_and_finish`
15. any node -> `fail_run` on unrecoverable error

### Core Rule

Approval is not a special UI branch.

Approval is a graph state transition:
- if tool action is non-read and allowed
- create pending approval
- persist state
- stop in `waiting_for_approval`
- later resume from `resume_after_approval`

This is where LangGraph can be cleaner than the current setup.

Resume contract:
- approval stop writes the pending approval id and resume node
- approval resume loads the stored approval decision and stored execution result
- duplicate final delivery must be blocked by dedupe key, not by hope

## Tool Invocation Model

### Keep Existing Tool Surface Where Possible

Do not immediately rewrite every tool.

Wrap the existing tool layer behind a clean interface like:

```ts
type RuntimeToolExecutor = (
  state: RuntimeState,
  toolCall: PlannedToolCall
) => Promise<ToolExecutionOutcome>;
```

### Tool Execution Outcome

Should always be one of:
- `success`
- `approval_required`
- `authorization_failed`
- `validation_failed`
- `retriable_error`
- `fatal_error`

This is much cleaner than mixing tool exceptions with assistant text.

Concrete contract:

```ts
type GraphToolCall = {
  id: string;
  toolId: string;
  actionGroup: 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute';
  input: Record<string, unknown>;
  dedupeKey: string;
};

type GraphToolResult =
  | { kind: 'success'; summary: string; output: Record<string, unknown> }
  | {
    kind: 'approval_required';
    summary: string;
    pendingAction: {
      toolId: string;
      actionGroup: 'create' | 'update' | 'delete' | 'send' | 'execute';
      title: string;
      subject?: string;
      payload: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
  }
  | { kind: 'authorization_failed'; summary: string; reason: string }
  | { kind: 'validation_failed'; summary: string; reason: string; details?: Record<string, unknown> }
  | { kind: 'error'; summary: string; retriable: boolean; reason: string; details?: Record<string, unknown> };
```

### Phase-1 Runtime Tool Scope

For the first LangGraph implementation, only support:
- Lark core tools
- coding/workspace tools
- search tools

Everything else should stay on the current Vercel path until the runtime proves stable.

### Action-Group Permissions

Before execution:
- check tool visibility
- check action group
- if blocked: structured authorization failure
- if non-read and allowed: produce `approval_required`
- if read and allowed: execute

This logic must be centralized, not reimplemented tool by tool.

Suggested central policy:

```ts
interface RuntimeToolPolicy {
  authorize(input: {
    toolId: string;
    actionGroup: 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute';
    allowedToolIds: string[];
    allowedActionsByTool: Record<string, string[]>;
    blockedToolIds: string[];
    channel: 'desktop' | 'lark';
  }): {
    allowed: boolean;
    requiresApproval: boolean;
    failureReason?: string;
  };
}
```

Mandatory rules:
- Lark blocks coding/workspace tools regardless of model intent
- desktop writes, deletes, sends, and executes still route through approval
- shadow mode never executes mutating actions

## HITL Model

### Goal

The same approval pipeline must work for:
- desktop
- Lark
- CRM writes
- Books writes
- Gmail sends
- Drive writes
- Calendar writes
- coding/workspace actions

### Correct Flow

1. Tool proposes exact action.
2. Backend stores exact normalized pending action.
3. Runtime stops at `waiting_for_approval`.
4. Desktop or Lark presents approval.
5. User approves/rejects.
6. Backend executes the exact stored action.
7. Runtime resumes with the stored execution result.

Never ask the model to regenerate the write payload after approval.

Required stored approval fields:
- exact tool id
- exact action group
- exact normalized payload
- exact conversation id
- exact run id
- exact adapter metadata needed to update the correct desktop or Lark surface

### Desktop Adapter

Desktop should use the composer island for approval mode.

### Lark Adapter

Lark should use one approval card/message updated in place.

No duplicate approval/status messages.

## Delivery Adapters

### Desktop Adapter Responsibilities

- persist tool cards
- render live traces
- switch composer into approval mode
- archive completed tool/action steps
- keep thread history coherent

### Lark Adapter Responsibilities

- send/update exactly one status message while running
- send one final answer
- render one approval card/message for HITL
- never expose coding/workspace tools

### Important Design Rule

Delivery adapters are presentation/delivery only.

They should not decide:
- tool permissions
- planning logic
- approval policy
- loop behavior

Suggested adapter contract:

```ts
interface RuntimeChannelAdapter {
  readonly channel: 'desktop' | 'lark';
  getBlockedToolIds(): string[];
  publishStatus(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Promise<{ messageId?: string }>;
  publishApproval(input: {
    runId: string;
    conversationId: string;
    approvalId: string;
    summary: string;
  }): Promise<{ messageId?: string }>;
  publishFinal(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Promise<{ messageId?: string }>;
}
```

## Loop Control And Anti-Jank Rules

This is one of the main reasons to rebuild.

Add explicit guards:

1. `maxSteps`
2. repeated same-tool-call guard
3. repeated same-validation-error guard
4. repeated same-plan guard
5. repeated same-file-read guard
6. approval re-request dedupe
7. duplicate delivery dedupe

Suggested stop reasons:
- `completed`
- `needs_approval`
- `blocked_by_permissions`
- `loop_guard_triggered`
- `tool_validation_failure`
- `tool_execution_failure`
- `delivery_failure`
- `manual_stop`

If the same command or same malformed tool call is attempted repeatedly, stop and surface a structured error.

Suggested guard keys:
- `tool:${toolId}:${stableInputHash}`
- `validation:${toolId}:${stableErrorHash}`
- `plan:${planHash}`
- `read_file:${workspacePath}`
- `delivery:${channel}:${dedupeKey}`
- `approval:${toolId}:${stablePayloadHash}`

## Persistence Strategy

Must be durable enough that:
- Lark is not in-memory only
- approval resumes survive backend restart
- scheduled workflows can use the same runtime later

Minimum persistence:
- conversation
- normalized messages
- runtime runs
- pending approvals
- key tool results

Optional:
- intermediate snapshots for replay/debug

Recommended storage split:
- Prisma / SQL for durable conversations, messages, runs, parity reports
- Redis for active run coordination, pending approval lookup, and short-lived resume cursors

## Migration Plan

### Phase 0: Architecture And Contracts

1. Create new runtime module namespace, for example:
   - `backend/src/company/orchestration/langgraph/`
2. Define state schema
3. Define persistence contracts
4. Define adapter interfaces
5. Define the LangGraph-native tool contract
6. Freeze the phase-1 tool set to:
   - lark
   - coding/workspace
   - search

Exit criteria:
- state schema committed
- persistence interface committed
- adapter interface committed
- tool contract committed
- feature-flag resolver committed

### Phase 1: Read-Only Shadow Runtime

1. Build graph core with search + read-only workspace/lark primitives first
2. No approvals, no writes
3. Run in shadow against desktop
4. Compare outputs/traces vs Vercel

Exit criteria:
- no visible user traffic served by LangGraph
- parity reports captured for desktop read-only prompts
- no side effects possible from the shadow runtime

### Phase 2: HITL And Writes

1. Add approval state
2. Add pending-action storage
3. Add desktop adapter support
4. Add coding/workspace writes and execute flow
5. Validate composer approval UX

Exit criteria:
- stored-payload execution after approval works end to end
- no model regeneration after approval
- duplicate approval request suppression works

### Phase 3: Lark Adapter

1. Add durable Lark conversation mapping
2. Add single-message status/update model
3. Add Lark approval card flow
4. Run shadow mode for Lark

Exit criteria:
- one mutable status message per run
- one approval card per pending action
- no duplicate final answer on retry or resume

### Phase 4: Expand Tool Surface

Only after the runtime is stable, port:

1. Zoho CRM
2. Zoho Books
3. Gmail
4. Drive
5. Calendar
6. Other specialist tools

### Phase 5: Controlled Cutover

1. Internal desktop users
2. Internal Lark users
3. Selected companies/departments
4. Broader rollout

## Detailed File/Module Plan

Suggested new modules:

- `backend/src/company/orchestration/langgraph/runtime.state.ts`
- `backend/src/company/orchestration/langgraph/runtime.graph.ts`
- `backend/src/company/orchestration/langgraph/runtime.context-builder.ts`
- `backend/src/company/orchestration/langgraph/runtime.persistence.ts`
- `backend/src/company/orchestration/langgraph/runtime.tool-executor.ts`
- `backend/src/company/orchestration/langgraph/runtime.tool-contract.ts`
- `backend/src/company/orchestration/langgraph/runtime.loop-guards.ts`
- `backend/src/company/orchestration/langgraph/adapters/desktop.adapter.ts`
- `backend/src/company/orchestration/langgraph/adapters/lark.adapter.ts`
- `backend/src/company/orchestration/langgraph/nodes/load-run-context.node.ts`
- `backend/src/company/orchestration/langgraph/nodes/model-decide.node.ts`
- `backend/src/company/orchestration/langgraph/nodes/execute-tool.node.ts`
- `backend/src/company/orchestration/langgraph/nodes/await-approval.node.ts`
- `backend/src/company/orchestration/langgraph/nodes/synthesize-response.node.ts`
- `backend/src/company/orchestration/langgraph/nodes/deliver-response.node.ts`

Likely persistence additions:

- Prisma models for:
  - `Conversation`
  - `ConversationMessage`
  - `RuntimeRun`
  - `PendingApprovalAction`
  - optional `RuntimeSnapshot`

Suggested repository layer:
- `conversation.repository.ts`
- `conversation-message.repository.ts`
- `runtime-run.repository.ts`
- `runtime-snapshot.repository.ts`
- `runtime-approval.repository.ts`
- `shadow-parity.repository.ts`

## Current-To-New Mapping

| Current area | Current file | New home |
| --- | --- | --- |
| Desktop prompt assembly and delivery coupling | [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts) | `langgraph/runtime.context-builder.ts` plus `langgraph/adapters/desktop.adapter.ts` |
| Lark prompt assembly and status/approval delivery | [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts) | `langgraph/runtime.context-builder.ts` plus `langgraph/adapters/lark.adapter.ts` |
| Department prompt and RBAC resolution | [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts) | reused by `RuntimeContextBuilder` |
| Vercel tool wrapper contract | [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts) | translated into `runtime.tool-contract.ts` and `runtime.tool-executor.ts` |
| In-memory conversation refs | [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/conversation/conversation-memory.store.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/conversation/conversation-memory.store.ts) | durable conversation/message repositories, optional cache layer |
| Pending approval durability | [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/hitl/hitl-action.repository.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/state/hitl/hitl-action.repository.ts) | reused or wrapped by `runtime-approval.repository.ts` |
| Checkpoint recovery reasoning | [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/checkpoint-recovery.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/checkpoint-recovery.ts) | ported into LangGraph stop/recovery policy |

## First Implementation Slice

Start with this vertical slice:

1. create conversation and run repositories
2. build `RuntimeContextBuilder`
3. implement read-only `search` tool contract
4. implement nodes:
   - `load_run_context`
   - `build_prompt_context`
   - `model_decide`
   - `synthesize_response`
   - `deliver_response`
   - `persist_and_finish`
5. run desktop shadow mode only

Only after that slice is stable:

1. add tool loop with `search`
2. add `coding/workspace` read actions
3. add approval stop/resume
4. add desktop write/execute actions
5. add Lark adapter

## Testing Plan

### Unit

- state transitions
- loop guards
- permission checks
- approval transitions
- context builder trimming rules

### Integration

- desktop read-only run
- desktop write requiring approval
- desktop resume after approval
- Lark read-only run
- Lark write requiring approval
- Lark resume after approval
- durable resume after backend restart

### Shadow Parity

For the same input, compare:
- selected tools
- number of steps
- whether approval was requested
- final answer
- latency

## Risks

1. Rebuilding too much at once
   - mitigate with shadow mode

2. Re-creating old split logic
   - mitigate by forcing all business logic into core runtime and keeping adapters thin

3. History bloat
   - mitigate with normalized durable messages and context trimming

4. Approval state drift
   - mitigate by executing stored payloads only

5. Lark duplication issues
   - mitigate with single-message adapter discipline

## Exact Recommendation

Yes, build it.

But build it as:
- a parallel runtime
- with feature flags
- with shadow mode
- with one state model
- with one context builder
- with durable history
- with approvals as graph state
- with a fresh LangGraph-native tool contract
- with only the core tools first: lark, coding/workspace, search

Do **not** do a one-shot replacement of Vercel.

## Next Engineer Starting Instructions

1. Read current desktop and Lark runtime files to understand present behavior.
2. Do not copy their orchestration structure directly.
3. First define the canonical state and persistence schema.
4. Then define the LangGraph-native tool contract.
5. Then define adapters.
6. Then implement only the phase-1 tool set:
   - lark
   - coding/workspace
   - search
7. Then build read-only graph flow.
8. Then add approvals/writes.
9. Only then wire feature flags and shadow runs.

If this order is violated, the rebuild will drift back into a mixed, janky runtime.
