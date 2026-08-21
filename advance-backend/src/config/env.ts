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

export const EnvSchema = z.object({
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
  //   REDIS_MEMORY_URL → short-lived security/workflow keys. The legacy name is
  //   retained for deployment compatibility; durable knowledge never lives here.
  REDIS_QUEUE_URL:  z.string().default(''),
  REDIS_CACHE_URL:  z.string().default(''),
  REDIS_MEMORY_URL: z.string().default(''),

  // ── Menhood company reporting database ─────────────────────────────────
  // One backend-managed, read-only company source. It never appears in the
  // Airtable connection picker and its credential never leaves the backend.
  MENHOOD_ENABLED:     booleanStr.default('false'),
  MENHOOD_DB_HOST:     z.string().default(''),
  MENHOOD_DB_PORT:     z.coerce.number().int().min(1).max(65_535).default(25_432),
  MENHOOD_DB_NAME:     z.string().default(''),
  MENHOOD_DB_USER:     z.string().default(''),
  MENHOOD_DB_PASSWORD: z.string().default(''),
  MENHOOD_COMPANY_ID:  z.string().default(''),
  MENHOOD_DB_SSL_MODE: z.literal('require').default('require'),
  MENHOOD_DB_SSL_CA_BASE64: z.string().default(''),
  MENHOOD_DB_SSL_SERVER_NAME: z.string().regex(/^[A-Za-z0-9.-]*$/).default(''),

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
  // URL the host-side controller uses to validate a runtime lease against this
  // exact backend instance. Configure an internal service URL when the public
  // OAuth origin terminates at a different instance or deployment.
  PI_LARK_BACKEND_URL: z.string().url().optional(),
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
  // Must be the exact HTTPS Message Card request URL configured in the Lark
  // Developer Console. Interactive cards fail closed when this is absent.
  LARK_CARD_CALLBACK_URL: z.string().url().refine(
    value => {
      const path = new URL(value).pathname;
      return path === '/webhooks/lark/events' || path === '/webhooks/lark/card';
    },
    'LARK_CARD_CALLBACK_URL must end with /webhooks/lark/events or /webhooks/lark/card',
  ).optional(),
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

  // ── Web / context search ──────────────────────────────────────────────────
  // ── Artifact publishing ───────────────────────────────────────────────────
  VERCEL_TOKEN:        z.string().optional(),
  VERCEL_PROJECT_NAME: z.string().optional(),
  VERCEL_TEAM_ID:      z.string().optional(),
  SERPER_API_KEY:                z.string().optional(),
  // Encrypts company-owned Serper credentials. Falls back to the existing OAuth key.
  SERPER_CONNECTION_ENCRYPTION_KEY: z.string().optional(),
  SERPER_TIMEOUT_MS:             positiveInt(10_000),
  // Semrush credentials never reach Desktop or Pi. Only validated
  // www.semrush.com recipes are supported. The key is the credential; the
  // cookie is read by no wired operation and is kept only for the excluded
  // /analytics/backlinks/webapi2 route, which the account has disabled.
  SEMRUSH_WEB_API_KEY: z.string().optional(),
  SEMRUSH_WEB_COOKIE: z.string().optional(),
  // Semrush keys exhaust in ordinary use. Where this is set it is the source of
  // truth for the live key and the environment key is only a fallback, because
  // a hardcoded key goes stale silently while the webhook does not.
  SEMRUSH_API_KEY_WEBHOOK_URL: z.string().url().optional(),
  SEMRUSH_TIMEOUT_MS:             positiveInt(15_000),
  // OMS Site Data keys are company-owned and persisted encrypted. The
  // composition fallback preserves existing deployments while allowing an
  // independent key rotation for OMS.
  OMS_CONNECTION_ENCRYPTION_KEY: z.string().optional(),
  OMS_SITE_DATA_API_KEY:      z.string().optional(),
  // Vendor Fetch is a separate OMS webhook/key from Site Data Read.
  OMS_VENDOR_FETCH_API_KEY:   z.string().optional(),
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

  // ── Shopify Admin GraphQL + ShopifyQL ────────────────────────────────────
  // Stores are normally connected with per-store Dev Dashboard client
  // credentials. Legacy authorization-code OAuth remains available when a
  // redirect URI is configured. Credentials and shop tokens remain backend-only.
  SHOPIFY_CLIENT_ID:        z.string().optional(),
  SHOPIFY_CLIENT_SECRET:    z.string().optional(),
  SHOPIFY_REDIRECT_URI:     z.string().url().optional(),
  SHOPIFY_SCOPES:           z.string().default('read_reports'),
  SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED: booleanStr.default('false'),
  SHOPIFY_API_VERSION:      z.string().regex(/^20\d{2}-(01|04|07|10)$/).default('2026-07'),
  SHOPIFY_TIMEOUT_MS:       positiveInt(20_000),
  SHOPIFY_MAX_RETRIES:      z.coerce.number().int().min(0).max(5).default(2),
  SHOPIFY_OAUTH_MAX_SKEW_SECONDS: positiveInt(300),

  // Provider-neutral key for newly written integration credentials. Existing
  // v1 rows continue to decrypt with ZOHO_TOKEN_ENCRYPTION_KEY during rollout.
  INTEGRATION_TOKEN_ENCRYPTION_KEY: z.string().optional(),

  // ── Zoho OAuth ────────────────────────────────────────────────────────────
  ZOHO_CLIENT_ID:            z.string().optional(),
  ZOHO_CLIENT_SECRET:        z.string().optional(),
  ZOHO_REDIRECT_URI:         z.string().optional(),
  ZOHO_ACCOUNTS_BASE_URL:    z.string().default('https://accounts.zoho.com'),
  ZOHO_API_BASE_URL:         z.string().default('https://www.zohoapis.com'),
  // Web base for Zoho Books record links. Set this to the org's custom finance
  // domain when it has one; the default is the generic Zoho Books app.
  ZOHO_BOOKS_APP_BASE_URL:   z.string().default('https://books.zoho.com'),
  // Reads a draft invoice cold before the member is shown it.
  ZOHO_INVOICE_REVIEW_MODEL_ID: z.string().default('deepseek-chat'),
  // Fallback selling state, in Zoho's own spelling — 'RJ', not '08' — because it
  // is compared against an invoice's `place_of_supply`, which Zoho writes that
  // way. A code in the other alphabet matches nothing and would call every
  // intra-state sale inter-state.
  //
  // Normally unset: the state is taken from the Zoho organisation being written
  // to, which is the only value that can be right when one connection reaches
  // organisations in several states. Absent and unresolvable means the
  // IGST-versus-CGST direction is reported as unchecked, never guessed.
  ZOHO_BOOKS_HOME_GST_STATE_CODE: z.string().optional(),
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

  // ── Governed knowledge files ─────────────────────────────────────────────
  KNOWLEDGE_FILE_MAX_MB: positiveInt(24),
  KNOWLEDGE_FILE_STAGING_TTL_HOURS: positiveInt(24),
  KNOWLEDGE_FILE_CLEANUP_INTERVAL_SECONDS: positiveInt(3_600),
  KNOWLEDGE_FILE_DELETION_LEASE_SECONDS: positiveInt(300),
  KNOWLEDGE_FILE_MALWARE_SCAN_MODE: z.enum(['required', 'disabled']).default('required'),
  CLAMAV_HOST: z.string().min(1).default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3_310),
  CLAMAV_SCAN_TIMEOUT_SECONDS: positiveInt(45),
  KNOWLEDGE_DOCUMENT_PARSE_TIMEOUT_SECONDS: positiveInt(300),
  KNOWLEDGE_DOCUMENT_INDEX_CONCURRENCY: positiveInt(2),
  KNOWLEDGE_DOCUMENT_MAX_PAGES: positiveInt(500),
  KNOWLEDGE_DOCUMENT_MAX_OCR_PAGES: positiveInt(100),
  KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_ENTRIES: positiveInt(10_000),
  KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_UNCOMPRESSED_BYTES: positiveInt(100_000_000),
  KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_COMPRESSION_RATIO: positiveInt(200),
  KNOWLEDGE_DOCUMENT_CHUNK_TARGET_CHARS: positiveInt(2_800),
  KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARS: positiveInt(3_600),
  KNOWLEDGE_DOCUMENT_CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).default(320),
  KNOWLEDGE_DOCUMENT_MAX_CHUNKS: positiveInt(2_000),
  KNOWLEDGE_DOCUMENT_MAX_EXTRACTED_CHARS: positiveInt(4_000_000),

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
  /** Where conversation video is held while it is being read. */
  CONVERSATION_VIDEO_DIR: z.string().default('.data/conversation-video'),
  /** Matches the Teach ceiling; a screen recording is the same object either way. */
  CONVERSATION_VIDEO_MAX_MB: positiveInt(2_047),
  /**
   * How long the on-disk artefacts live: the extracted stills and the stored
   * reading. The recording itself goes sooner — the moment it has been read.
   *
   * Not the lifetime of what Divo remembers. The excerpt folded into the ask is
   * part of the conversation turn and lives as long as the thread, because the
   * answer above it stops making sense otherwise. Said plainly here, because a
   * retention review will read this line and believe it.
   */
  CONVERSATION_VIDEO_RETENTION_HOURS: positiveInt(24),
  /** Videos read at once, across everybody. Teach's worker concurrency, by hand. */
  CONVERSATION_VIDEO_READ_CONCURRENCY: positiveInt(2),
  /** Unread video one company may be holding at once, across all its members. */
  CONVERSATION_VIDEO_COMPANY_BUDGET_MB: positiveInt(8_192),
  /** Readings one company may start per hour. Bounds spend, which bytes do not. */
  CONVERSATION_VIDEO_READS_PER_HOUR: positiveInt(60),
  /** Unread video the whole deployment may hold. Bounds the sum of all tenants. */
  CONVERSATION_VIDEO_TOTAL_BUDGET_MB: positiveInt(32_768),
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

  // ── Member session auth ───────────────────────────────────────────────────
  MEMBER_JWT_SECRET: z.string().min(1).default('dev-member-secret-change-me'),

  // ── HITL approval policy ──────────────────────────────────────────────────
  // Canonical deployment setting. When true, manager-owned actions also require
  // a separate approval actor (four-eyes control), including in production.
  DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS: booleanStr.default('false'),
  // Legacy local-test setting. It is intentionally ignored by production
  // composition; keep it only so older non-production deployments continue to
  // exercise the approval-card path during migration.
  DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: booleanStr.default('false'),
  /*
   * Whether a resolved approver is sent a Lark card, or only left a request in
   * their approval inbox.
   *
   * For testing an approval flow without messaging a real colleague every
   * attempt. It suppresses the *delivery*, never the decision: the row is still
   * written, still authorised to exactly one person, and still answerable —
   * which is what makes this safe to have at all. Ignored in production, where
   * an approval nobody is told about is an approval nobody answers.
   */
  DIVO_APPROVAL_CARDS_ENABLED: booleanStr.default('true'),

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
  // How many mailboxes and deliveries Mail Ops works at once. Set either to 1
  // to restore the strictly serial worker, which is the escape hatch if
  // concurrency provokes a Gmail quota that one-at-a-time did not.
  DIVO_MAIL_OPS_MAILBOX_LANES:  z.coerce.number().int().min(1).max(16).default(4),
  DIVO_MAIL_OPS_DELIVERY_LANES: z.coerce.number().int().min(1).max(16).default(4),
  /*
   * Hold company admins to the same external-forward approval as everybody else.
   *
   * Off by default: a rule forwarding mail out of the company is approved by
   * somebody above the person asking, and for an admin there is nobody the
   * question is meaningfully addressed to — Divo used to card their department
   * manager, or another admin, or refuse the rule outright when it found
   * neither. Turn this on to restore that.
   *
   * Named for what it asks rather than for the flag it sets, because
   * "disable the exemption" is how an operator ends up setting the opposite of
   * what they meant.
   */
  DIVO_MAIL_OPS_ADMIN_NEEDS_EXTERNAL_APPROVAL: booleanStr.default('false'),

  // ── Hindsight semantic recall projection ────────────────────────────────
  // Versioned Postgres knowledge remains authoritative. Hindsight is private
  // backend infrastructure; Desktop/Pi never receive its URL, key, or bank ID.
  HINDSIGHT_ENABLED:              booleanStr.default('false'),
  HINDSIGHT_URL:                  z.string().url().default('http://127.0.0.1:8888'),
  HINDSIGHT_API_KEY:              z.string().optional(),
  HINDSIGHT_MAX_RESULTS:          positiveInt(12),
  HINDSIGHT_RECALL_MAX_TOKENS:    positiveInt(1_200),
  HINDSIGHT_RECALL_BUDGET:        z.enum(['low', 'mid', 'high']).default('mid'),
  HINDSIGHT_REQUEST_TIMEOUT_MS:   positiveInt(10_000),
  HINDSIGHT_RECALL_CONCURRENCY:   z.coerce.number().int().min(1).max(32).default(4),
  // Durable knowledge outbox. Every live write projects synchronously first;
  // this worker heals crashes and transient Hindsight/registry outages.
  KNOWLEDGE_PROJECTION_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
  KNOWLEDGE_PROJECTION_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  KNOWLEDGE_PROJECTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  KNOWLEDGE_PROJECTION_PROCESSING_LEASE_SECONDS: positiveInt(300),
  KNOWLEDGE_HEALTH_PENDING_AGE_WARNING_SECONDS: positiveInt(300),

  // Structured personal learning. Semantic classification is model-owned;
  // these values are auditable promotion policy, not text-matching rules.
  KNOWLEDGE_LEARNING_ENABLED: booleanStr.default('true'),
  REDIS_KNOWLEDGE_LEARNING_QUEUE_NAME: z.string().default('knowledge-learning'),
  KNOWLEDGE_LEARNING_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(1),
  KNOWLEDGE_LEARNING_MODEL_ID: z.string().default('deepseek-v4-flash'),
  KNOWLEDGE_LEARNING_IMMEDIATE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  KNOWLEDGE_LEARNING_REPEATED_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  KNOWLEDGE_LEARNING_REPEATED_EVIDENCE_COUNT: z.coerce.number().int().min(2).max(10).default(3),
}).superRefine((env, ctx) => {
  if (!env.MENHOOD_ENABLED) return;
  const required = [
    'MENHOOD_DB_HOST',
    'MENHOOD_DB_NAME',
    'MENHOOD_DB_USER',
    'MENHOOD_DB_PASSWORD',
    'MENHOOD_COMPANY_ID',
    'MENHOOD_DB_SSL_CA_BASE64',
    'MENHOOD_DB_SSL_SERVER_NAME',
  ] as const;
  for (const field of required) {
    if (!env[field].trim()) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required when Menhood is enabled` });
    }
  }
  if (env.MENHOOD_COMPANY_ID && !z.string().uuid().safeParse(env.MENHOOD_COMPANY_ID).success) {
    ctx.addIssue({ code: 'custom', path: ['MENHOOD_COMPANY_ID'], message: 'MENHOOD_COMPANY_ID must be a UUID' });
  }
  if (env.MENHOOD_DB_SSL_CA_BASE64) {
    const certificate = Buffer.from(env.MENHOOD_DB_SSL_CA_BASE64, 'base64').toString('utf8');
    if (!certificate.includes('-----BEGIN CERTIFICATE-----') || !certificate.includes('-----END CERTIFICATE-----')) {
      ctx.addIssue({
        code: 'custom',
        path: ['MENHOOD_DB_SSL_CA_BASE64'],
        message: 'MENHOOD_DB_SSL_CA_BASE64 must contain a base64-encoded PEM certificate',
      });
    }
  }
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
  const productionIssues = validateProductionEnv(result.data);
  if (productionIssues.length > 0) {
    console.error('Unsafe production environment:');
    console.error(productionIssues);
    process.exit(1);
  }
  return result.data;
};

/** Central fail-closed deployment invariants; runtime code must not weaken these. */
export const validateProductionEnv = (env: TypedEnv): string[] => {
  if (env.NODE_ENV !== 'production') return [];
  const issues: string[] = [];
  if (env.KNOWLEDGE_FILE_MALWARE_SCAN_MODE !== 'required') {
    issues.push('KNOWLEDGE_FILE_MALWARE_SCAN_MODE must be required in production.');
  }
  if (env.ADMIN_JWT_SECRET === 'dev-secret-change-me' || env.ADMIN_JWT_SECRET.length < 32) {
    issues.push('ADMIN_JWT_SECRET must be a production secret of at least 32 characters.');
  }
  if (env.MEMBER_JWT_SECRET === 'dev-member-secret-change-me' || env.MEMBER_JWT_SECRET.length < 32) {
    issues.push('MEMBER_JWT_SECRET must be a production secret of at least 32 characters.');
  }
  if (env.ADMIN_JWT_SECRET === env.MEMBER_JWT_SECRET) {
    issues.push('ADMIN_JWT_SECRET and MEMBER_JWT_SECRET must be different.');
  }
  if (!env.LARK_ENCRYPT_KEY && !env.LARK_VERIFICATION_TOKEN && !env.LARK_WEBHOOK_SIGNING_SECRET) {
    issues.push('At least one Lark webhook verification secret is required in production.');
  }
  const controllerHost = new URL(env.PI_LARK_CONTROLLER_URL).hostname.toLowerCase();
  if (controllerHost === 'localhost' || controllerHost === '127.0.0.1' || controllerHost === '::1') {
    issues.push('PI_LARK_CONTROLLER_URL must name the private isolated controller service in production.');
  }
  if (!env.HINDSIGHT_ENABLED || !env.HINDSIGHT_API_KEY) {
    issues.push('Hindsight and its private API key are required for production semantic knowledge recall.');
  }
  const cloudinary = [env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET];
  if (!cloudinary.every(Boolean)) {
    issues.push('Private governed-file storage requires all Cloudinary credentials in production.');
  }
  if (!env.OPENROUTER_API_KEY) {
    issues.push('OPENROUTER_API_KEY is required to index approved images and scanned PDFs in production.');
  }
  if (env.SHOPIFY_REDIRECT_URI) {
    if (!env.SHOPIFY_CLIENT_ID) {
      issues.push('SHOPIFY_CLIENT_ID is required when legacy Shopify OAuth is configured.');
    }
    if (!env.SHOPIFY_CLIENT_SECRET) {
      issues.push('SHOPIFY_CLIENT_SECRET is required when legacy Shopify OAuth is configured.');
    }
    const redirect = new URL(env.SHOPIFY_REDIRECT_URI);
    const hostname = redirect.hostname.toLowerCase();
    if (redirect.protocol !== 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      issues.push('SHOPIFY_REDIRECT_URI must use HTTPS on a non-loopback host in production.');
    }
  }
  const shopifyScopes = new Set((env.SHOPIFY_SCOPES ?? '').split(',').map(scope => scope.trim()).filter(Boolean));
  const supportedShopifyScopes = new Set([
    'read_reports',
    'read_orders',
    'read_customers',
    'read_all_orders',
  ]);
  for (const scope of shopifyScopes) {
    if (!supportedShopifyScopes.has(scope)) {
      issues.push(`SHOPIFY_SCOPES contains unsupported scope ${scope}.`);
    }
  }
  if (!shopifyScopes.has('read_reports')) {
    issues.push('SHOPIFY_SCOPES must include read_reports for Shopify analytics.');
  }
  if (env.SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED) {
    for (const required of ['read_orders', 'read_customers']) {
      if (!shopifyScopes.has(required)) {
        issues.push(`SHOPIFY_SCOPES must include ${required} when protected Shopify record tools are enabled.`);
      }
    }
  } else if (shopifyScopes.has('read_orders') || shopifyScopes.has('read_customers') || shopifyScopes.has('read_all_orders')) {
    issues.push('SHOPIFY_SCOPES must not request read_orders, read_all_orders, or read_customers while protected Shopify record tools are disabled in production.');
  }
  if (!env.INTEGRATION_TOKEN_ENCRYPTION_KEY || env.INTEGRATION_TOKEN_ENCRYPTION_KEY.length < 32) {
    issues.push('INTEGRATION_TOKEN_ENCRYPTION_KEY must be at least 32 characters in production.');
  }
  return issues;
};
