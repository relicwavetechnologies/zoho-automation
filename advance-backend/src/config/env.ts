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
  // Last-resort fallback only. OAuth callbacks are built from the backend URL
  // the Desktop signed in against (its request Host), vetted by the allowlist
  // below — do NOT pin a deployment URL here.
  BACKEND_PUBLIC_URL: z.string().default('http://localhost:8000'),
  // Comma-separated full origins this deployment may build OAuth callbacks for,
  // e.g. "https://app-dev.example.io,https://app.example.io". Loopback hosts are
  // always allowed; BACKEND_PUBLIC_URL is implicitly included.
  BACKEND_PUBLIC_URL_ALLOWLIST: z.string().default(''),

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

  /**
   * The single vision model. Screenshots, scans and Manager Teach frames all
   * use it, so a change here changes every place Divo reads an image — which
   * is the point: there is no second, quieter, weaker path to drift into.
   */
  VISION_OCR_MODEL: z.string().default('qwen/qwen3-vl-32b-instruct'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_PROVIDER_ORDER: z.string().default('Groq'),

  // ── OpenAI ────────────────────────────────────────────────────────────────
  OPENAI_API_KEY:        z.string().min(1),
  ELEVEN_LABS_API_KEY:   z.string().min(1).optional(),
  OPENAI_TEMPERATURE:    positiveNum(0.1),

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  // Backend-side background inference only — the group-room rollover summary and
  // persona learning, which call the SDK directly. It is NOT the proxy's key: a
  // run's model credential comes from what an admin saved in Guardrails, and
  // nowhere else.
  DEEPSEEK_API_KEY:  z.string().optional(),

  // ── LLM proxy (Guardrails) ────────────────────────────────────────────────
  // The proxy is ON by default — the route mounts and resolves the requested
  // model provider's key server-side. With no key configured it simply
  // returns 503 "not configured" (never 404). Set LLM_PROXY_ENABLED=false only as
  // a kill switch. PI is repointed at /api/llm/v1 via the divo-llm extension.
  LLM_PROXY_ENABLED:  z.string().default('true').transform((v) => v === 'true' || v === '1'),
  DEEPSEEK_BASE_URL:  z.string().default('https://api.deepseek.com'),
  // Luna is served from OpenAI's own OpenAI-compatible endpoint, so the proxy
  // routes to it by the model's provider and forwards an OpenAI key instead.
  OPENAI_BASE_URL:    z.string().default('https://api.openai.com'),
  // Neither provider has an env fallback for the proxy. The key an admin saved
  // in Guardrails is the only key a run uses, so a company that has added none
  // gets a 503 naming that rather than quietly spending on whatever the process
  // was started with. For OpenAI that matters twice over: OPENAI_API_KEY is
  // required and already the platform credential for memory and transcription,
  // so using it here would report every company as configured.
  // Legacy trace-ingest kill switch for older desktop builds that cannot declare
  // per-batch usage ownership. Current builds merge their local timeline into the
  // proxy-correlated run and let the proxy own only authoritative token usage.
  PROXY_OWNS_TRACE:   z.string().default('false').transform((v) => v === 'true' || v === '1'),
  // Encrypts provider keys admins add via the Guardrails UI (AES-256-GCM, token.crypto
  // format). Falls back to ZOHO_TOKEN_ENCRYPTION_KEY so no new secret is required to ship.
  PROXY_KEY_ENCRYPTION_KEY: z.string().optional(),

  // ── Pi-only Lark runtime ─────────────────────────────────────────────────
  // The controller remains private to the backend host. Only the Lark webhook
  // is exposed through the public backend URL during local ngrok validation.
  PI_LARK_CONTROLLER_URL: z.string().url().default('http://127.0.0.1:4317'),
  PI_LARK_RUNTIME_INSTANCE_ID: z.string().min(1).default('pi-local-1'),
  PI_RUNTIME_LEASE_TTL_SECONDS: positiveInt(3_600),
  PI_LARK_RUN_TIMEOUT_MS: positiveInt(1_800_000),

  // ── Gemini ────────────────────────────────────────────────────────────────
  GEMINI_API_KEY:                   z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY:     z.string().optional(),

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
  // Group text always feeds the bounded room transcript. Attachment processing
  // downloads, OCRs, and indexes files nobody asked Divo to read, so it stays
  // off unless a company opts in.
  LARK_UNTAGGED_GROUP_ATTACHMENTS: z.enum(['ignore', 'process']).default('ignore'),

  // Merge a rapid burst from one sender into a single turn. Kept as a switch
  // rather than a constant because it changes how many replies a user gets,
  // and the fastest safe rollback for that is a restart, not a deploy.
  LARK_MESSAGE_BATCHING: z.enum(['on', 'off']).default('on'),

  // Index Lark documents in the background so later questions can retrieve
  // parts the inline excerpt left out.
  //
  // Off by default. Reading a document for the current turn is self-contained
  // and already works; indexing adds a CDN upload, an embedding call, and a
  // vector write, and a failure in any of them lands as a red card in the
  // user's chat for a question Divo has usually just answered correctly.
  // Turning this on is a deliberate choice made once that pipeline is trusted.
  //
  // With it off, Divo answers from the inline excerpt alone and says so when
  // the excerpt does not cover the whole file, rather than promising a
  // retrieval that will never be possible.

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
  SEMRUSH_API_KEY_WEBHOOK_URL: z.string().url().optional(),
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
  GOOGLE_PUBSUB_TOPIC:        z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/).optional(),
  GOOGLE_PUBSUB_SUBSCRIPTION: z.string().regex(/^projects\/[^/]+\/subscriptions\/[^/]+$/).optional(),
  GOOGLE_PUBSUB_PUSH_AUDIENCE: z.string().url().optional(),
  GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT: z.string().email().optional(),
  /** Private backend-side Workspace MCP endpoint; never expose it to desktop/Pi. */
  GOOGLE_WORKSPACE_MCP_URL:   z.string().default('http://127.0.0.1:18000/mcp'),

  // ── Canva remote MCP OAuth ───────────────────────────────────────────────
  // Canva allows the redirect URI only after its MCP access review. The client
  // metadata URL is optional for DCR fallback but should be set for CIMD.
  CANVA_MCP_URL:                 z.string().default('https://mcp.canva.com/mcp'),
  CANVA_MCP_REDIRECT_URI:        z.string().optional(),
  CANVA_MCP_CLIENT_METADATA_URL: z.string().optional(),

  // ── Airtable remote MCP OAuth ────────────────────────────────────────────
  // Airtable hosts its own MCP and registers OAuth clients dynamically, so no
  // developer-console app is required and there is no client secret (clients
  // are public and authenticate with PKCE). Set AIRTABLE_CLIENT_ID only to
  // adopt a pre-registered, branded Airtable integration instead of DCR.
  AIRTABLE_MCP_URL:          z.string().default('https://mcp.airtable.com/mcp'),
  AIRTABLE_MCP_REDIRECT_URI: z.string().optional(),
  AIRTABLE_CLIENT_ID:        z.string().optional(),

  // ── AITable Fusion API ────────────────────────────────────────────────────
  // AITable has no OAuth: every connection carries a personal API key its owner
  // minted in the AITable User Center, so there is no client ID, secret, or
  // redirect here and no company-wide key — credentials live per connection.
  // The host is configurable because the same Fusion API serves aitable.ai,
  // api.apitable.com, and self-hosted APITable.
  AITABLE_BASE_URL:          z.string().default('https://aitable.ai'),

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
  // Group-room transcript compaction. DeepSeek like every other model Divo
  // runs, and a flash tier because this is high-volume background work whose
  // output is a summary, not a user-facing answer.
  GROUP_SUMMARY_MODEL_ID: z.string().default('deepseek-v4-flash'),

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

  // Set to 0 to disable supervisor timeout (useful for local dev with slow models).
  // Active timeouts are clamped so an older 5-minute deployment value cannot
  // silently reintroduce the lifecycle limit.
  SUPERVISOR_TIMEOUT_MS: z.coerce.number().int().min(0).default(600_000)
    .transform(value => value === 0 ? 0 : Math.max(value, 600_000)),

  // ── Scheduled workflow executor ──────────────────────────────────────────
  // Disable only autonomous DB-scanning work while cloning an environment.
  // Interactive Lark, OAuth, tools, and queue-backed work remain available.
  DIVO_AUTONOMOUS_WORKERS_ENABLED: booleanStr.default('true'),
  SCHEDULED_WORKFLOW_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(120_000),

  // ── Mem0 persistent memory layer ─────────────────────────────────────────
  MEM0_ENABLED:           booleanStr.default('false'),
  MEM0_EXTRACTION_MODEL:  z.string().default('gpt-4o-mini'),
  MEM0_QDRANT_COLLECTION: z.string().default('divo_memories'),
  MEM0_MAX_RESULTS:       positiveInt(10),
});

export type TypedEnv = z.infer<typeof EnvSchema>;

type GmailPubSubConfig = {
  topic: string;
  subscription: string;
  pushAudience: string;
  pushServiceAccount: string;
};

export const getGmailPubSubConfig = (
  env: Pick<
    TypedEnv,
    | 'GOOGLE_PUBSUB_TOPIC'
    | 'GOOGLE_PUBSUB_SUBSCRIPTION'
    | 'GOOGLE_PUBSUB_PUSH_AUDIENCE'
    | 'GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT'
  >,
): GmailPubSubConfig | null => {
  if (
    !env.GOOGLE_PUBSUB_TOPIC
    || !env.GOOGLE_PUBSUB_SUBSCRIPTION
    || !env.GOOGLE_PUBSUB_PUSH_AUDIENCE
    || !env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT
  ) return null;
  return {
    topic: env.GOOGLE_PUBSUB_TOPIC,
    subscription: env.GOOGLE_PUBSUB_SUBSCRIPTION,
    pushAudience: env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
    pushServiceAccount: env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT,
  };
};

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
