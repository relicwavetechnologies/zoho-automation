import { z } from 'zod';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const booleanStr = z
  .string()
  .transform(v => v.toLowerCase() === 'true')
  .or(z.boolean());

const positiveInt = (def: number) =>
  z.coerce.number().int().positive().default(def);

const positiveNum = (def: number) =>
  z.coerce.number().positive().default(def);

// ─── Schema ───────────────────────────────────────────────────────────────────

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT:     z.coerce.number().int().min(1).max(65535).default(8000),

  // ── URLs ──────────────────────────────────────────────────────────────────
  APP_BASE_URL:     z.string().default('http://localhost:5173'),
  BACKEND_PUBLIC_URL: z.string().default('http://localhost:8000'),

  // ── Database + Redis ──────────────────────────────────────────────────────
  DATABASE_URL:     z.string().min(1),
  // Required fallback — used for all Redis connections in local dev (single instance).
  REDIS_URL:        z.string().min(1),
  // Optional dedicated connections. Each falls back to REDIS_URL when not set.
  //   REDIS_QUEUE_URL  → BullMQ ingestion queue only (blocking cmds, Lua scripts).
  //   REDIS_CACHE_URL  → hot-path app cache: permissions, OAuth tokens, agent defs.
  //   REDIS_MEMORY_URL → memory system cache + nonces + knowledge-share + Cloudinary.
  REDIS_QUEUE_URL:  z.string().default(''),
  REDIS_CACHE_URL:  z.string().default(''),
  REDIS_MEMORY_URL: z.string().default(''),

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_LEVEL:              z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_SUCCESS_SAMPLE_RATE: positiveNum(0.25),
  LOG_INCLUDE_STACK:      booleanStr.default('true'),

  // ── Orchestration model ───────────────────────────────────────────────────
  // Switch the entire engine by changing these two vars. No code changes needed.
  //   MODEL_PROVIDER=google  MODEL_ID=gemini-3.1-flash-lite
  //   MODEL_PROVIDER=openai  MODEL_ID=gpt-4o
  MODEL_PROVIDER: z.enum(['google', 'openai', 'deepseek']).default('google'),
  MODEL_ID:       z.string().default('gemini-3.1-flash-lite'),

  /** Image OCR + caption during file ingestion (defaults to GA flash-lite). */
  IMAGE_OCR_PROVIDER: z.enum(['gemini', 'openrouter']).default('gemini'),
  GEMINI_VISION_MODEL: z.string().default('gemini-3.1-flash-lite'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_VISION_MODEL: z.string().default('meta-llama/llama-4-scout'),
  OPENROUTER_PROVIDER_ORDER: z.string().default('Groq'),

  // ── OpenAI ────────────────────────────────────────────────────────────────
  OPENAI_API_KEY:        z.string().min(1),
  GATEWAY_BASE_URL:      z.string().default(''),
  GATEWAY_ADMIN_API_KEY: z.string().optional(),
  OPENAI_ROUTER_MODEL:   z.string().default('gpt-4o-mini'),
  OPENAI_TEMPERATURE:    positiveNum(0.1),

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  DEEPSEEK_API_KEY:  z.string().optional(),

  // ── LLM proxy (Guardrails) ────────────────────────────────────────────────
  // The proxy is ON by default — the route mounts and resolves the DeepSeek key
  // server-side (company → platform → env). With no key configured it simply
  // returns 503 "not configured" (never 404). Set LLM_PROXY_ENABLED=false only as
  // a kill switch. PI is repointed at /api/llm/v1 via the divo-llm extension.
  LLM_PROXY_ENABLED:  z.string().default('true').transform((v) => v === 'true' || v === '1'),
  DEEPSEEK_BASE_URL:  z.string().default('https://api.deepseek.com'),
  // Legacy trace-ingest kill switch for older desktop builds that cannot declare
  // per-batch usage ownership. Current builds merge their local timeline into the
  // proxy-correlated run and let the proxy own only authoritative token usage.
  PROXY_OWNS_TRACE:   z.string().default('false').transform((v) => v === 'true' || v === '1'),
  // Encrypts DeepSeek keys admins add via the Guardrails UI (AES-256-GCM, token.crypto
  // format). Falls back to ZOHO_TOKEN_ENCRYPTION_KEY so no new secret is required to ship.
  PROXY_KEY_ENCRYPTION_KEY: z.string().optional(),

  // ── Groq (intent classification + reranking) ──────────────────────────────
  GROQ_API_KEY:      z.string().optional(),
  GROQ_ROUTER_MODEL: z.string().default('llama-3.1-8b-instant'),

  // ── Gemini ────────────────────────────────────────────────────────────────
  GEMINI_API_KEY:                   z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY:     z.string().optional(),
  GEMINI_EMBEDDING_MODEL:           z.string().default('gemini-embedding-001'),
  GEMINI_MULTIMODAL_EMBEDDING_MODEL: z.string().default('gemini-embedding-2-preview'),

  // ── Embeddings ────────────────────────────────────────────────────────────
  EMBEDDING_PROVIDER:    z.enum(['openai', 'gemini', 'fallback']).default('gemini'),
  OPENAI_EMBEDDING_MODEL: z.enum([
    'text-embedding-3-small',
    'text-embedding-3-large',
    'text-embedding-ada-002',
  ]).default('text-embedding-3-small'),

  // ── Lark ──────────────────────────────────────────────────────────────────
  LARK_API_BASE_URL:   z.string().default('https://open.larksuite.com'),
  LARK_APP_ID:         z.string().min(1),
  LARK_APP_SECRET:     z.string().min(1),
  LARK_BOT_NAME:       z.string().default('Divo'),
  // Webhook security — both are optional individually; production enforces at least one
  LARK_ENCRYPT_KEY:            z.string().optional(),   // AES-256-CBC message decryption
  LARK_VERIFICATION_TOKEN:     z.string().optional(),   // legacy HMAC-SHA256 signature
  LARK_WEBHOOK_SIGNING_SECRET: z.string().optional(),   // newer signing secret
  LARK_WEBHOOK_MAX_SKEW_SECONDS: positiveInt(300),
  // Token refresh tuning (carried from old backend .env)
  LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS: positiveInt(180),
  LARK_TENANT_TOKEN_FETCH_MAX_RETRIES:      positiveInt(3),
  LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS:    positiveInt(250),
  // User OAuth — set LARK_OAUTH_REDIRECT_URI to <BACKEND_PUBLIC_URL>/api/lark/auth/callback
  LARK_OAUTH_REDIRECT_URI: z.string().optional(),
  // Group messages that never mention Divo. Text retention feeds the bounded
  // room transcript; attachment processing downloads, OCRs, and indexes files
  // nobody asked Divo to read, so it stays off unless a company opts in.
  LARK_UNTAGGED_GROUP_TEXT_RETENTION: z.enum(['retain', 'off']).default('retain'),
  LARK_UNTAGGED_GROUP_ATTACHMENTS:    z.enum(['ignore', 'process']).default('ignore'),

  // ── Qdrant vector store ───────────────────────────────────────────────────
  QDRANT_URL:                  z.string().default('http://127.0.0.1:6333'),
  QDRANT_API_KEY:              z.string().optional(),
  QDRANT_COLLECTION:           z.string().default('divo_vectors'),
  QDRANT_RETRIEVAL_COLLECTION: z.string().default('retrieval_v3'),
  QDRANT_TIMEOUT_MS:           positiveInt(10_000),

  // ── Web / context search ──────────────────────────────────────────────────
  SERPER_API_KEY:                z.string().optional(),
  // Encrypts company-owned Serper credentials. Falls back to the existing OAuth key.
  SERPER_CONNECTION_ENCRYPTION_KEY: z.string().optional(),
  SERPER_TIMEOUT_MS:             positiveInt(10_000),
  // Semrush is a normal server-side integration. Its API key never reaches
  // Desktop or Pi; the backend uses it only with fixed official endpoints.
  SEMRUSH_API_KEY: z.string().optional(),
  SEMRUSH_TIMEOUT_MS:             positiveInt(15_000),
  // OMS Site Data keys are company-owned and persisted encrypted. The
  // composition fallback preserves existing deployments while allowing an
  // independent key rotation for OMS.
  OMS_CONNECTION_ENCRYPTION_KEY: z.string().optional(),
  OMS_SITE_DATA_API_KEY:      z.string().optional(),
  OMS_SITE_DATA_TIMEOUT_MS:      positiveInt(15_000),
  CONTEXT_SEARCH_TIMEOUT_ENABLED: booleanStr.default('true'),
  CONTEXT_SEARCH_TIMEOUT_MS:     positiveInt(8_000),

  // ── Google OAuth ──────────────────────────────────────────────────────────
  GOOGLE_OAUTH_CLIENT_ID:     z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI:  z.string().optional(),
  /** Private backend-side Workspace MCP endpoint; never expose it to desktop/Pi. */
  GOOGLE_WORKSPACE_MCP_URL:   z.string().default('http://127.0.0.1:18000/mcp'),

  // ── Canva remote MCP OAuth ───────────────────────────────────────────────
  // Canva allows the redirect URI only after its MCP access review. The client
  // metadata URL is optional for DCR fallback but should be set for CIMD.
  CANVA_MCP_URL:                 z.string().default('https://mcp.canva.com/mcp'),
  CANVA_MCP_REDIRECT_URI:        z.string().optional(),
  CANVA_MCP_CLIENT_METADATA_URL: z.string().optional(),

  // ── Zoho OAuth ────────────────────────────────────────────────────────────
  ZOHO_CLIENT_ID:            z.string().optional(),
  ZOHO_CLIENT_SECRET:        z.string().optional(),
  ZOHO_REDIRECT_URI:         z.string().optional(),
  ZOHO_ACCOUNTS_BASE_URL:    z.string().default('https://accounts.zoho.com'),
  ZOHO_API_BASE_URL:         z.string().default('https://www.zohoapis.com'),
  ZOHO_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  ZOHO_PROVIDER_DEFAULT:     z.enum(['rest', 'mcp']).default('rest'),
  ZOHO_MCP_ENABLED:          booleanStr.default('false'),

  // ── Cloudinary (temp exports, file uploads) ───────────────────────────────
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY:    z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  /** How many inline records to show before spilling to a CSV link. */
  ZOHO_BOOKS_CSV_INLINE_THRESHOLD: positiveInt(10),
  /** Signed-URL TTL for exported CSVs in seconds (default 24 h). */
  ZOHO_BOOKS_CSV_LINK_TTL_SECONDS: positiveInt(86_400),
  /** How often to scan Cloudinary for expired temp exports. */
  CLOUDINARY_TEMP_EXPORT_CLEANUP_INTERVAL_SECONDS: positiveInt(21_600),

  // ── Run-trace retention (Track A) ─────────────────────────────────────────
  /** Detailed trace payloads (ExecutionEvent + StepResult) older than this are
   *  pruned. AiTokenUsage is never pruned (cost/spend history is long-lived). */
  TRACE_RETENTION_DAYS: positiveInt(7),
  /** How often the trace-retention prune runs, in hours. */
  TRACE_RETENTION_INTERVAL_HOURS: positiveInt(24),

  // ── Admin auth ────────────────────────────────────────────────────────────
  /** HS256 secret for signing admin JWTs. Required in production. */
  ADMIN_JWT_SECRET: z.string().min(1).default('dev-secret-change-me'),
  /** Optional static key for machine-to-machine access to /api/executions. */
  INTERNAL_API_KEY: z.string().optional(),

  // ── Document ingestion (file upload + RAG) ────────────────────────────────
  DOC_UPLOAD_MAX_MB:          positiveInt(24),
  DOC_EXTRACT_MAX_WORDS:      positiveInt(100_000),
  REDIS_INGESTION_QUEUE_NAME: z.string().default('ingestion'),
  INGESTION_WORKER_CONCURRENCY: positiveInt(2),
  INGESTION_JOB_RETRIES:      positiveInt(3),

  // ── Manager persona learning ─────────────────────────────────────────────
  REDIS_PERSONA_LEARNING_QUEUE_NAME: z.string().default('persona-learning'),
  PERSONA_LEARNING_WORKER_CONCURRENCY: positiveInt(1),
  PERSONA_LEARNING_MODEL_ID: z.string().default('deepseek-v4-flash'),

  // ── Explicit manager Teach ingestion ────────────────────────────────────
  REDIS_MANAGER_TEACH_QUEUE_NAME: z.string().default('manager-teach'),
  MANAGER_TEACH_WORKER_CONCURRENCY: positiveInt(1),
  /** Raw videos are streamed here; never buffer them in Express memory. */
  MANAGER_TEACH_UPLOAD_DIR: z.string().default('.data/manager-teach'),
  MANAGER_TEACH_MAX_VIDEO_MB: positiveInt(2_047),
  MANAGER_TEACH_RAW_RETENTION_HOURS: positiveInt(24),
  MANAGER_TEACH_MAX_FRAMES: positiveInt(40),
  MANAGER_TEACH_FRAME_WIDTH: positiveInt(1_600),
  MANAGER_TEACH_SCENE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.12),
  MANAGER_TEACH_MEDIA_TIMEOUT_SECONDS: positiveInt(1_800),
  MANAGER_TEACH_OCR_CONCURRENCY: positiveInt(2),
  MANAGER_TEACH_OCR_MODEL: z.string().default('qwen/qwen3-vl-32b-instruct'),
  MANAGER_TEACH_TRANSCRIPTION_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  MANAGER_TEACH_TRANSCRIPTION_CHUNK_SECONDS: positiveInt(300),
  MANAGER_TEACH_PERSONA_MODEL: z.string().default('deepseek-v4-pro'),
  MANAGER_TEACH_PERSONA_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  MANAGER_TEACH_EVIDENCE_MAX_MB: positiveInt(5),
  MANAGER_TEACH_PERSONA_MAX_INPUT_CHARS: z.coerce.number().int().min(20_000).default(800_000),

  // ── RAG retrieval tuning ──────────────────────────────────────────────────
  RAG_GRADE_THRESHOLD:   positiveNum(3),
  RAG_MAX_REWRITES:      positiveInt(1),
  RAG_MAX_REFINES:       positiveInt(1),
  RAG_FULL_READ_MAX_CHARS: positiveInt(18_000),

  // ── RAG feature flags (all default on) ───────────────────────────────────
  FILE_RAG_CHUNK_SEARCH_ENABLED:   booleanStr.default('true'),
  FILE_RAG_FULL_READ_ENABLED:      booleanStr.default('true'),
  FILE_RAG_GRADING_ENABLED:        booleanStr.default('true'),
  FILE_RAG_REWRITE_ENABLED:        booleanStr.default('true'),
  FILE_RAG_ANSWER_GRADING_ENABLED: booleanStr.default('true'),
  FILE_RAG_MULTIMODAL_ENABLED:     booleanStr.default('true'),
  FILE_RAG_KNOWLEDGE_SHARE_ENABLED: booleanStr.default('true'),

  // ── Member session auth ───────────────────────────────────────────────────
  MEMBER_JWT_SECRET: z.string().min(1).default('dev-member-secret-change-me'),

  // ── HITL local testing ────────────────────────────────────────────────────
  // Non-production only. Forces manager-owned actions through the approval card
  // path so the Lark approval loop can be smoke-tested with one user.
  DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: booleanStr.default('false'),

  // ── LangSmith tracing (optional) ──────────────────────────────────────────
  LANGSMITH_TRACING:  booleanStr.default('false'),
  LANGSMITH_API_KEY:  z.string().optional(),
  LANGSMITH_PROJECT:  z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().default('https://api.smith.langchain.com'),

  // ── Dynamic agent graph cutover ───────────────────────────────────────────
  DYNAMIC_GRAPH_ENABLED: booleanStr.default('false'),
  UNIFIED_AGENT_MODE:    booleanStr.default('false'),

  // Set to 0 to disable supervisor timeout (useful for local dev with slow models)
  SUPERVISOR_TIMEOUT_MS: z.coerce.number().int().min(0).default(300_000),

  // ── Scheduled workflow executor ──────────────────────────────────────────
  SCHEDULED_WORKFLOW_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(120_000),

  // ── Mem0 persistent memory layer ─────────────────────────────────────────
  MEM0_ENABLED:           booleanStr.default('false'),
  MEM0_EXTRACTION_MODEL:  z.string().default('gpt-4o-mini'),
  MEM0_QDRANT_COLLECTION: z.string().default('divo_memories'),
  MEM0_MAX_RESULTS:       positiveInt(10),
});

export type TypedEnv = z.infer<typeof EnvSchema>;

/**
 * Returns `specific` when it is a non-empty string, otherwise falls back to
 * `fallback`. Use this to resolve the three purposeful Redis URLs so that local
 * dev with a single `REDIS_URL` still works with zero friction.
 */
export const resolveRedisUrl = (specific: string, fallback: string): string =>
  specific.length > 0 ? specific : fallback;

export const loadAndValidateEnv = (raw: NodeJS.ProcessEnv): TypedEnv => {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
};
