# V0 DTO and State Sync Contract

Use these contracts as source-of-truth for V0 implementation. If code differs, update this document and task context together.

## Contract Goals
1. Prevent ambiguous payload shapes across channel/orchestrator/agents.
2. Prevent state drift and race conditions during queued execution.
3. Keep V0 shapes stable enough for V1 extension.

## Core DTOs

### 1) NormalizedIncomingMessageDTO
```ts
type NormalizedIncomingMessageDTO = {
  channel: 'lark';
  companyId?: string;
  userId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  messageId: string;
  timestamp: string; // ISO-8601
  text: string;
  rawEvent: unknown;
};
```

### 2) OrchestrationTaskDTO
```ts
type OrchestrationTaskDTO = {
  taskId: string;
  messageId: string;
  userId: string;
  chatId: string;
  status: 'pending' | 'running' | 'hitl' | 'done' | 'failed' | 'cancelled';
  complexityLevel?: 1 | 2 | 3 | 4 | 5;
  orchestratorModel?: string;
  plan: string[];
  executionMode?: 'sequential' | 'parallel' | 'mixed';
};
```

### 3) AgentInvokeInputDTO
```ts
type AgentInvokeInputDTO = {
  taskId: string;
  agentKey: string;
  objective: string;
  constraints?: string[];
  contextPacket: Record<string, unknown>;
  correlationId: string;
};
```

### 4) AgentResultDTO
```ts
type AgentResultDTO = {
  taskId: string;
  agentKey: string;
  status: 'success' | 'failed' | 'needs_context' | 'hitl_paused' | 'timed_out_partial';
  message: string;
  result?: Record<string, unknown>;
  error?: ErrorDTO;
  metrics?: {
    latencyMs?: number;
    tokensUsed?: number;
    apiCalls?: number;
  };
};
```

### 5) ErrorDTO
```ts
type ErrorDTO = {
  type: 'API_ERROR' | 'MODEL_ERROR' | 'TOOL_ERROR' | 'SECURITY_ERROR' | 'UNKNOWN_ERROR';
  classifiedReason: string;
  rawMessage?: string;
  retriable: boolean;
};
```

### 6) HITLActionDTO
```ts
type HITLActionDTO = {
  taskId: string;
  actionId: string;
  actionType: 'write' | 'update' | 'delete' | 'execute';
  summary: string;
  requestedAt: string; // ISO-8601
  expiresAt: string;   // ISO-8601
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
};
```

### 7) CheckpointDTO
```ts
type CheckpointDTO = {
  taskId: string;
  version: number;
  node: string;
  state: Record<string, unknown>;
  updatedAt: string; // ISO-8601
};
```

### 8) ZohoConnectionDTO
```ts
type ZohoConnectionDTO = {
  companyId: string;
  status: 'PENDING' | 'CONNECTED' | 'FAILED' | 'DISCONNECTED';
  connectedAt?: string; // ISO-8601
  lastSyncAt?: string;  // ISO-8601
  scopes?: string[];
};
```

### 9) IngestionJobDTO
```ts
type IngestionJobDTO = {
  jobId: string;
  companyId: string;
  source: 'zoho';
  mode: 'historical_full' | 'delta';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progressPercent: number;
  checkpoint?: string;
  startedAt?: string;   // ISO-8601
  completedAt?: string; // ISO-8601
};
```

### 10) VectorUpsertDTO
```ts
type VectorUpsertDTO = {
  companyId: string;
  sourceType: 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';
  sourceId: string;
  chunkIndex: number;
  contentHash: string;
  payload: Record<string, unknown>;
};
```

### 11) MemberDTO (Admin Dashboard)
```ts
type MemberDTO = {
  userId: string;
  companyId: string;
  roleId: string;
  email?: string;
  name?: string;
  createdAt: string; // ISO-8601
};
```

### 12) InviteDTO (Admin Dashboard)
```ts
type InviteDTO = {
  inviteId: string;
  companyId: string;
  email: string;
  roleId: 'MEMBER' | 'COMPANY_ADMIN';
  status: 'pending' | 'accepted' | 'cancelled';
  invitedBy: string;
  expiresAt: string; // ISO-8601
  acceptedAt?: string; // ISO-8601
  createdAt: string; // ISO-8601
};
```

### 13) CompanyOnboardingStatusDTO (Admin Dashboard)
```ts
type CompanyOnboardingStatusDTO = {
  companyId: string;
  connection: {
    status: 'PENDING' | 'CONNECTED' | 'FAILED' | 'DISCONNECTED';
    connectedAt: string;
    scopes: string[];
    lastSyncAt?: string;
  } | null;
  historicalSync: {
    jobId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    progressPercent: number;
    checkpoint?: string;
    queuedAt: string;
    startedAt?: string;
    finishedAt?: string;
  } | null;
};
```

## Required Sync Rules (Anti-Drift)

1. `messageId` is the idempotency key at ingress.
2. Queue job key must include `taskId` and `messageId` correlation.
3. Every checkpoint write increments `version` by 1.
4. Resume always loads highest `version` checkpoint.
5. HITL state changes must be atomic (`pending -> confirmed/cancelled/expired`).
6. Agent results are append-only in history log; latest snapshot can be derived view.
7. Never mutate normalized inbound DTO after queue enqueue.
8. Zoho onboarding connect must enqueue ingestion job asynchronously.
9. Historical ingestion is resumable from checkpoint.
10. Delta ingestion is idempotent by source event key.
11. Invite issuance/cancellation and onboarding connect/disconnect must be server-authorized and audit logged.
12. Dashboard onboarding progress must be rendered from backend status APIs; client-side progress synthesis is not allowed.

## Recommended Redis Key Pattern (V0)

- `company:idempotent:{messageId}`
- `company:task:{taskId}:status`
- `company:session:{chatId}:{taskId}:checkpoint`
- `company:hitl:{taskId}`

## Minimal Transition Rules

- `pending -> running`
- `running -> hitl` (only for gated actions)
- `hitl -> running` (confirmed)
- `hitl -> cancelled` (cancel/timeout)
- `running -> done`
- `running -> failed`

No other transitions are allowed without updating this contract.
