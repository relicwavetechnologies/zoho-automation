import { z } from 'zod';

export type EnvSeverity = 'error' | 'warning';

export type EnvValidationIssue = {
  key: string;
  code: string;
  message: string;
  severity: EnvSeverity;
};

export type ValidatedEnv = {
  PORT: number;
  NODE_ENV: 'development' | 'test' | 'production';
  APP_BASE_URL: string;
  BACKEND_PUBLIC_URL: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  LOG_SUCCESS_SAMPLE_RATE: number;
  LOG_INCLUDE_STACK: boolean;
  DATABASE_URL: string;
  JWT_SECRET: string;
  ADMIN_JWT_SECRET: string;
  ADMIN_SESSION_TTL_MINUTES: number;
  CORS_ALLOWED_ORIGINS: string;
  REDIS_URL: string;
  REDIS_QUEUE_URL: string;
  REDIS_STATE_URL: string;
  REDIS_CACHE_URL: string;
  ORCHESTRATION_WORKER_CONCURRENCY: number;
  ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS: number;
  ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS: number;
  ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS: number;
  ORCHESTRATION_QUEUE_LOCK_DURATION_MS: number;
  ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS: number;
  ORCHESTRATION_QUEUE_MAX_STALLED_COUNT: number;
  DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS: number;
  HITL_TIMEOUT_SECONDS: number;
  CHECKPOINT_TTL_SECONDS: number;
  RETRY_MAX_ATTEMPTS: number;
  RETRY_BASE_DELAY_MS: number;
  INGRESS_IDEMPOTENCY_TTL_SECONDS: number;
  LARK_API_BASE_URL: string;
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_BOT_TENANT_ACCESS_TOKEN: string;
  LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS: number;
  LARK_TENANT_TOKEN_FETCH_MAX_RETRIES: number;
  LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS: number;
  LARK_VERIFICATION_TOKEN: string;
  LARK_ENCRYPT_KEY: string;
  LARK_WEBHOOK_SIGNING_SECRET: string;
  LARK_WEBHOOK_MAX_SKEW_SECONDS: number;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  GOOGLE_OAUTH_REDIRECT_URI: string;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_REDIRECT_URI: string;
  ZOHO_ACCOUNTS_BASE_URL: string;
  ZOHO_API_BASE_URL: string;
  ZOHO_TOKEN_ENCRYPTION_KEY: string;
  ZOHO_PROVIDER_DEFAULT: 'rest' | 'mcp';
  ZOHO_MCP_ENABLED: boolean;
  ZOHO_MCP_ACTIONS_ENABLED: boolean;
  MCP_REQUEST_TIMEOUT_MS: number;
  MCP_MAX_RETRIES: number;
  MCP_RETRY_BASE_DELAY_MS: number;
  MCP_SECRET_ENCRYPTION_KEY: string;
  OUTREACH_API_URL: string;
  OUTREACH_API_TIMEOUT_MS: number;
  SERPER_API_KEY: string;
  SERPER_TIMEOUT_MS: number;
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  QDRANT_COLLECTION: string;
  QDRANT_RETRIEVAL_COLLECTION: string;
  QDRANT_TIMEOUT_MS: number;
  EMBEDDING_PROVIDER: 'gemini' | 'openai' | 'fallback';
  OPENAI_EMBEDDING_MODEL: string;
  GEMINI_EMBEDDING_MODEL: string;
  GEMINI_MULTIMODAL_EMBEDDING_MODEL: string;
  GEMINI_MEDIA_ANALYSIS_MODEL: string;
  GOOGLE_CLOUD_PROJECT_ID: string;
  GOOGLE_CLOUD_LOCATION: string;
  GOOGLE_RANKING_CONFIG: string;
  GOOGLE_RANKING_MODEL: string;
  GOOGLE_CLOUD_ACCESS_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  RAG_CHAT_RERANK_OPTIONAL: boolean;
  ORCHESTRATION_ENGINE: 'legacy' | 'vercel' | 'langgraph';
  GROQ_API_KEY: string;
  GROQ_ROUTER_MODEL: string;
  GEMINI_API_KEY: string;
  OPENAI_ROUTER_MODEL: string;
  OPENAI_SUPERVISOR_MODEL: string;
  OPENAI_PLANNER_MODEL: string;
  OPENAI_SYNTHESIS_MODEL: string;
  OPENAI_TEMPERATURE: number;
  LANGSMITH_TRACING: boolean;
  LANGSMITH_API_KEY: string;
  LANGSMITH_PROJECT: string;
  LANGSMITH_ENDPOINT: string;
  LARK_TENANT_BINDING_ENFORCED: boolean;
  DOC_UPLOAD_MAX_MB: number;
  DOC_EXTRACT_MAX_WORDS: number;
  DOC_GENERATION_MAX_WORDS: number;
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  CLOUDINARY_UPLOAD_PRESET: string;
  CLOUDINARY_FOLDER: string;
};

export type EnvValidationResult = {
  config: ValidatedEnv;
  warnings: EnvValidationIssue[];
};

export class EnvValidationError extends Error {
  readonly issues: EnvValidationIssue[];

  constructor(issues: EnvValidationIssue[]) {
    super('Environment validation failed');
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

const rawEnvSchema = z.object({}).passthrough();

const readString = (value: unknown, defaultValue = ''): string => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return String(value).trim();
};

const parseInteger = (input: {
  key: string;
  value: string;
  defaultValue: number;
  min?: number;
  max?: number;
  issues: EnvValidationIssue[];
}): number => {
  const { key, value, defaultValue, min, max, issues } = input;
  const raw = value.length > 0 ? value : String(defaultValue);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed)) {
    issues.push({
      key,
      code: 'invalid_integer',
      message: `${key} must be an integer`,
      severity: 'error',
    });
    return defaultValue;
  }

  if (min !== undefined && parsed < min) {
    issues.push({
      key,
      code: 'out_of_range',
      message: `${key} must be >= ${min}`,
      severity: 'error',
    });
  }

  if (max !== undefined && parsed > max) {
    issues.push({
      key,
      code: 'out_of_range',
      message: `${key} must be <= ${max}`,
      severity: 'error',
    });
  }

  return parsed;
};

const parseNumber = (input: {
  key: string;
  value: string;
  defaultValue: number;
  min?: number;
  max?: number;
  issues: EnvValidationIssue[];
}): number => {
  const { key, value, defaultValue, min, max, issues } = input;
  const raw = value.length > 0 ? value : String(defaultValue);
  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    issues.push({
      key,
      code: 'invalid_number',
      message: `${key} must be a finite number`,
      severity: 'error',
    });
    return defaultValue;
  }

  if (min !== undefined && parsed < min) {
    issues.push({
      key,
      code: 'out_of_range',
      message: `${key} must be >= ${min}`,
      severity: 'error',
    });
  }

  if (max !== undefined && parsed > max) {
    issues.push({
      key,
      code: 'out_of_range',
      message: `${key} must be <= ${max}`,
      severity: 'error',
    });
  }

  return parsed;
};

const parseBoolean = (input: {
  key: string;
  value: string;
  defaultValue: boolean;
  issues: EnvValidationIssue[];
}): boolean => {
  const { key, value, defaultValue, issues } = input;
  const raw = value.length > 0 ? value : String(defaultValue);
  const normalized = raw.toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  issues.push({
    key,
    code: 'invalid_boolean',
    message: `${key} must be true or false`,
    severity: 'error',
  });

  return defaultValue;
};

const parseOrigins = (value: string, issues: EnvValidationIssue[]): string => {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    issues.push({
      key: 'CORS_ALLOWED_ORIGINS',
      code: 'missing_value',
      message: 'CORS_ALLOWED_ORIGINS must include at least one origin',
      severity: 'error',
    });
    return value;
  }

  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push({
          key: 'CORS_ALLOWED_ORIGINS',
          code: 'invalid_origin_protocol',
          message: `Origin must be http/https: ${origin}`,
          severity: 'error',
        });
      }
    } catch {
      issues.push({
        key: 'CORS_ALLOWED_ORIGINS',
        code: 'invalid_origin',
        message: `Invalid origin: ${origin}`,
        severity: 'error',
      });
    }
  }

  return origins.join(',');
};

const parseNodeEnv = (value: string, issues: EnvValidationIssue[]): ValidatedEnv['NODE_ENV'] => {
  if (value === 'development' || value === 'test' || value === 'production') {
    return value;
  }

  issues.push({
    key: 'NODE_ENV',
    code: 'invalid_enum',
    message: 'NODE_ENV must be one of development|test|production',
    severity: 'error',
  });

  return 'development';
};

const parseLogLevel = (value: string, issues: EnvValidationIssue[]): ValidatedEnv['LOG_LEVEL'] => {
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'fatal'
  ) {
    return value;
  }

  issues.push({
    key: 'LOG_LEVEL',
    code: 'invalid_enum',
    message: 'LOG_LEVEL must be one of debug|info|warn|error|fatal',
    severity: 'error',
  });

  return 'info';
};

const parseOrchestrationEngine = (
  value: string,
  issues: EnvValidationIssue[],
): ValidatedEnv['ORCHESTRATION_ENGINE'] => {
  if (value === 'legacy' || value === 'vercel' || value === 'langgraph') {
    return value;
  }

  issues.push({
    key: 'ORCHESTRATION_ENGINE',
    code: 'invalid_enum',
    message: 'ORCHESTRATION_ENGINE must be legacy, vercel, or langgraph',
    severity: 'error',
  });

  return 'langgraph';
};

const parseEmbeddingProvider = (
  value: string,
  issues: EnvValidationIssue[],
): ValidatedEnv['EMBEDDING_PROVIDER'] => {
  if (value === 'gemini' || value === 'openai' || value === 'fallback') {
    return value;
  }

  issues.push({
    key: 'EMBEDDING_PROVIDER',
    code: 'invalid_enum',
    message: 'EMBEDDING_PROVIDER must be gemini, openai, or fallback',
    severity: 'error',
  });

  return 'gemini';
};

const parseZohoProviderDefault = (
  value: string,
  issues: EnvValidationIssue[],
): ValidatedEnv['ZOHO_PROVIDER_DEFAULT'] => {
  if (value === 'rest' || value === 'mcp') {
    return value;
  }

  issues.push({
    key: 'ZOHO_PROVIDER_DEFAULT',
    code: 'invalid_enum',
    message: 'ZOHO_PROVIDER_DEFAULT must be rest or mcp',
    severity: 'error',
  });

  return 'rest';
};

const requireNonEmpty = (key: string, value: string, issues: EnvValidationIssue[]): string => {
  if (value.length === 0) {
    issues.push({
      key,
      code: 'missing_value',
      message: `${key} is required`,
      severity: 'error',
    });
  }
  return value;
};

export const validateEnvironmentContract = (raw: NodeJS.ProcessEnv): EnvValidationResult => {
  const parsedRaw = rawEnvSchema.parse(raw);
  const issues: EnvValidationIssue[] = [];
  const warnings: EnvValidationIssue[] = [];

  const nodeEnv = parseNodeEnv(readString(parsedRaw.NODE_ENV, 'development'), issues);

  const port = parseInteger({
    key: 'PORT',
    value: readString(parsedRaw.PORT, '8000'),
    defaultValue: 8000,
    min: 1,
    max: 65535,
    issues,
  });

  const logSuccessSampleRate = parseNumber({
    key: 'LOG_SUCCESS_SAMPLE_RATE',
    value: readString(parsedRaw.LOG_SUCCESS_SAMPLE_RATE, '0.25'),
    defaultValue: 0.25,
    min: 0,
    max: 1,
    issues,
  });

  const openAiTemperature = parseNumber({
    key: 'OPENAI_TEMPERATURE',
    value: readString(parsedRaw.OPENAI_TEMPERATURE, '0.1'),
    defaultValue: 0.1,
    min: 0,
    max: 1,
    issues,
  });

  const docUploadMaxMb = parseInteger({
    key: 'DOC_UPLOAD_MAX_MB',
    value: readString(parsedRaw.DOC_UPLOAD_MAX_MB, '10'),
    defaultValue: 10,
    min: 1,
    max: 100,
    issues,
  });

  const docExtractMaxWords = parseInteger({
    key: 'DOC_EXTRACT_MAX_WORDS',
    value: readString(parsedRaw.DOC_EXTRACT_MAX_WORDS, '50000'),
    defaultValue: 50000,
    min: 1000,
    max: 200000,
    issues,
  });

  const docGenerationMaxWords = parseInteger({
    key: 'DOC_GENERATION_MAX_WORDS',
    value: readString(parsedRaw.DOC_GENERATION_MAX_WORDS, '1200'),
    defaultValue: 1200,
    min: 100,
    max: 10000,
    issues,
  });

  const larkWebhookMaxSkewSeconds = parseInteger({
    key: 'LARK_WEBHOOK_MAX_SKEW_SECONDS',
    value: readString(parsedRaw.LARK_WEBHOOK_MAX_SKEW_SECONDS, '300'),
    defaultValue: 300,
    min: 30,
    issues,
  });

  const redisUrl = readString(parsedRaw.REDIS_URL, 'redis://127.0.0.1:6379');

  const config: ValidatedEnv = {
    PORT: port,
    NODE_ENV: nodeEnv,
    APP_BASE_URL: readString(parsedRaw.APP_BASE_URL, 'http://localhost:5173'),
    BACKEND_PUBLIC_URL: readString(parsedRaw.BACKEND_PUBLIC_URL, 'http://localhost:8000'),
    LOG_LEVEL: parseLogLevel(readString(parsedRaw.LOG_LEVEL, 'info'), issues),
    LOG_SUCCESS_SAMPLE_RATE: logSuccessSampleRate,
    LOG_INCLUDE_STACK: parseBoolean({
      key: 'LOG_INCLUDE_STACK',
      value: readString(parsedRaw.LOG_INCLUDE_STACK, 'true'),
      defaultValue: true,
      issues,
    }),
    DATABASE_URL: requireNonEmpty('DATABASE_URL', readString(parsedRaw.DATABASE_URL), issues),
    JWT_SECRET: requireNonEmpty('JWT_SECRET', readString(parsedRaw.JWT_SECRET, 'changeme'), issues),
    ADMIN_JWT_SECRET: readString(
      parsedRaw.ADMIN_JWT_SECRET,
      readString(parsedRaw.JWT_SECRET, 'changeme'),
    ),
    ADMIN_SESSION_TTL_MINUTES: parseInteger({
      key: 'ADMIN_SESSION_TTL_MINUTES',
      value: readString(parsedRaw.ADMIN_SESSION_TTL_MINUTES, '480'),
      defaultValue: 480,
      min: 1,
      issues,
    }),
    CORS_ALLOWED_ORIGINS: parseOrigins(
      readString(parsedRaw.CORS_ALLOWED_ORIGINS, 'http://localhost:5173'),
      issues,
    ),
    REDIS_URL: redisUrl,
    REDIS_QUEUE_URL: readString(parsedRaw.REDIS_QUEUE_URL, redisUrl),
    REDIS_STATE_URL: readString(parsedRaw.REDIS_STATE_URL, redisUrl),
    REDIS_CACHE_URL: readString(parsedRaw.REDIS_CACHE_URL, redisUrl),
    ORCHESTRATION_WORKER_CONCURRENCY: parseInteger({
      key: 'ORCHESTRATION_WORKER_CONCURRENCY',
      value: readString(parsedRaw.ORCHESTRATION_WORKER_CONCURRENCY, '2'),
      defaultValue: 2,
      min: 1,
      issues,
    }),
    ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS: parseInteger({
      key: 'ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS',
      value: readString(parsedRaw.ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS, '3'),
      defaultValue: 3,
      min: 1,
      issues,
    }),
    ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS: parseInteger({
      key: 'ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS',
      value: readString(parsedRaw.ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS, '200'),
      defaultValue: 200,
      min: 0,
      issues,
    }),
    ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS: parseInteger({
      key: 'ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS',
      value: readString(parsedRaw.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS, '120000'),
      defaultValue: 120000,
      min: 1000,
      issues,
    }),
    ORCHESTRATION_QUEUE_LOCK_DURATION_MS: parseInteger({
      key: 'ORCHESTRATION_QUEUE_LOCK_DURATION_MS',
      value: readString(parsedRaw.ORCHESTRATION_QUEUE_LOCK_DURATION_MS, '60000'),
      defaultValue: 60000,
      min: 5000,
      issues,
    }),
    ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS: parseInteger({
      key: 'ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS',
      value: readString(parsedRaw.ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS, '30000'),
      defaultValue: 30000,
      min: 1000,
      issues,
    }),
    ORCHESTRATION_QUEUE_MAX_STALLED_COUNT: parseInteger({
      key: 'ORCHESTRATION_QUEUE_MAX_STALLED_COUNT',
      value: readString(parsedRaw.ORCHESTRATION_QUEUE_MAX_STALLED_COUNT, '1'),
      defaultValue: 1,
      min: 0,
      issues,
    }),
    DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS: parseInteger({
      key: 'DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS',
      value: readString(parsedRaw.DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS, '900000'),
      defaultValue: 900000,
      min: 60000,
      issues,
    }),
    HITL_TIMEOUT_SECONDS: parseInteger({
      key: 'HITL_TIMEOUT_SECONDS',
      value: readString(parsedRaw.HITL_TIMEOUT_SECONDS, '300'),
      defaultValue: 300,
      min: 1,
      issues,
    }),
    CHECKPOINT_TTL_SECONDS: parseInteger({
      key: 'CHECKPOINT_TTL_SECONDS',
      value: readString(parsedRaw.CHECKPOINT_TTL_SECONDS, '7200'),
      defaultValue: 7200,
      min: 1,
      issues,
    }),
    RETRY_MAX_ATTEMPTS: parseInteger({
      key: 'RETRY_MAX_ATTEMPTS',
      value: readString(parsedRaw.RETRY_MAX_ATTEMPTS, '2'),
      defaultValue: 2,
      min: 1,
      issues,
    }),
    RETRY_BASE_DELAY_MS: parseInteger({
      key: 'RETRY_BASE_DELAY_MS',
      value: readString(parsedRaw.RETRY_BASE_DELAY_MS, '250'),
      defaultValue: 250,
      min: 0,
      issues,
    }),
    INGRESS_IDEMPOTENCY_TTL_SECONDS: parseInteger({
      key: 'INGRESS_IDEMPOTENCY_TTL_SECONDS',
      value: readString(parsedRaw.INGRESS_IDEMPOTENCY_TTL_SECONDS, '21600'),
      defaultValue: 21600,
      min: 1,
      issues,
    }),
    LARK_API_BASE_URL: readString(parsedRaw.LARK_API_BASE_URL, 'https://open.larksuite.com'),
    LARK_APP_ID: readString(parsedRaw.LARK_APP_ID),
    LARK_APP_SECRET: readString(parsedRaw.LARK_APP_SECRET),
    LARK_BOT_TENANT_ACCESS_TOKEN: readString(parsedRaw.LARK_BOT_TENANT_ACCESS_TOKEN),
    LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS: parseInteger({
      key: 'LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS',
      value: readString(parsedRaw.LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS, '180'),
      defaultValue: 180,
      min: 0,
      issues,
    }),
    LARK_TENANT_TOKEN_FETCH_MAX_RETRIES: parseInteger({
      key: 'LARK_TENANT_TOKEN_FETCH_MAX_RETRIES',
      value: readString(parsedRaw.LARK_TENANT_TOKEN_FETCH_MAX_RETRIES, '3'),
      defaultValue: 3,
      min: 1,
      issues,
    }),
    LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS: parseInteger({
      key: 'LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS',
      value: readString(parsedRaw.LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS, '250'),
      defaultValue: 250,
      min: 0,
      issues,
    }),
    LARK_VERIFICATION_TOKEN: readString(parsedRaw.LARK_VERIFICATION_TOKEN),
    LARK_ENCRYPT_KEY: readString(parsedRaw.LARK_ENCRYPT_KEY),
    LARK_WEBHOOK_SIGNING_SECRET: readString(parsedRaw.LARK_WEBHOOK_SIGNING_SECRET),
    LARK_WEBHOOK_MAX_SKEW_SECONDS: larkWebhookMaxSkewSeconds,
    GOOGLE_OAUTH_CLIENT_ID: readString(parsedRaw.GOOGLE_OAUTH_CLIENT_ID),
    GOOGLE_OAUTH_CLIENT_SECRET: readString(parsedRaw.GOOGLE_OAUTH_CLIENT_SECRET),
    GOOGLE_OAUTH_REDIRECT_URI: readString(parsedRaw.GOOGLE_OAUTH_REDIRECT_URI),
    ZOHO_CLIENT_ID: readString(parsedRaw.ZOHO_CLIENT_ID),
    ZOHO_CLIENT_SECRET: readString(parsedRaw.ZOHO_CLIENT_SECRET),
    ZOHO_REDIRECT_URI: readString(parsedRaw.ZOHO_REDIRECT_URI),
    ZOHO_ACCOUNTS_BASE_URL: readString(
      parsedRaw.ZOHO_ACCOUNTS_BASE_URL,
      'https://accounts.zoho.com',
    ),
    ZOHO_API_BASE_URL: readString(parsedRaw.ZOHO_API_BASE_URL, 'https://www.zohoapis.com'),
    ZOHO_TOKEN_ENCRYPTION_KEY: readString(parsedRaw.ZOHO_TOKEN_ENCRYPTION_KEY),
    ZOHO_PROVIDER_DEFAULT: parseZohoProviderDefault(
      readString(parsedRaw.ZOHO_PROVIDER_DEFAULT, 'rest'),
      issues,
    ),
    ZOHO_MCP_ENABLED: parseBoolean({
      key: 'ZOHO_MCP_ENABLED',
      value: readString(parsedRaw.ZOHO_MCP_ENABLED, 'false'),
      defaultValue: false,
      issues,
    }),
    ZOHO_MCP_ACTIONS_ENABLED: parseBoolean({
      key: 'ZOHO_MCP_ACTIONS_ENABLED',
      value: readString(parsedRaw.ZOHO_MCP_ACTIONS_ENABLED, 'false'),
      defaultValue: false,
      issues,
    }),
    MCP_REQUEST_TIMEOUT_MS: parseInteger({
      key: 'MCP_REQUEST_TIMEOUT_MS',
      value: readString(parsedRaw.MCP_REQUEST_TIMEOUT_MS, '10000'),
      defaultValue: 10000,
      min: 1000,
      issues,
    }),
    MCP_MAX_RETRIES: parseInteger({
      key: 'MCP_MAX_RETRIES',
      value: readString(parsedRaw.MCP_MAX_RETRIES, '3'),
      defaultValue: 3,
      min: 1,
      issues,
    }),
    MCP_RETRY_BASE_DELAY_MS: parseInteger({
      key: 'MCP_RETRY_BASE_DELAY_MS',
      value: readString(parsedRaw.MCP_RETRY_BASE_DELAY_MS, '250'),
      defaultValue: 250,
      min: 0,
      issues,
    }),
    MCP_SECRET_ENCRYPTION_KEY: readString(parsedRaw.MCP_SECRET_ENCRYPTION_KEY),
    OUTREACH_API_URL: readString(
      parsedRaw.OUTREACH_API_URL,
      'https://agents.outreachdeal.com/webhook/dummy-data',
    ),
    OUTREACH_API_TIMEOUT_MS: parseInteger({
      key: 'OUTREACH_API_TIMEOUT_MS',
      value: readString(parsedRaw.OUTREACH_API_TIMEOUT_MS, '10000'),
      defaultValue: 10000,
      min: 1000,
      issues,
    }),
    SERPER_API_KEY: readString(parsedRaw.SERPER_API_KEY, readString(parsedRaw.SEPER_API_KEY)),
    SERPER_TIMEOUT_MS: parseInteger({
      key: 'SERPER_TIMEOUT_MS',
      value: readString(parsedRaw.SERPER_TIMEOUT_MS, '10000'),
      defaultValue: 10000,
      min: 1000,
      issues,
    }),
    QDRANT_URL: readString(parsedRaw.QDRANT_URL, 'http://127.0.0.1:6333'),
    QDRANT_API_KEY: readString(parsedRaw.QDRANT_API_KEY),
    QDRANT_COLLECTION: readString(parsedRaw.QDRANT_COLLECTION, 'zoho_automation_docs'),
    QDRANT_RETRIEVAL_COLLECTION: readString(parsedRaw.QDRANT_RETRIEVAL_COLLECTION, 'retrieval_v3'),
    QDRANT_TIMEOUT_MS: parseInteger({
      key: 'QDRANT_TIMEOUT_MS',
      value: readString(parsedRaw.QDRANT_TIMEOUT_MS, '5000'),
      defaultValue: 5000,
      min: 1000,
      issues,
    }),
    EMBEDDING_PROVIDER: parseEmbeddingProvider(
      readString(parsedRaw.EMBEDDING_PROVIDER, 'gemini'),
      issues,
    ),
    OPENAI_EMBEDDING_MODEL: readString(parsedRaw.OPENAI_EMBEDDING_MODEL, 'text-embedding-3-small'),
    GEMINI_EMBEDDING_MODEL: readString(parsedRaw.GEMINI_EMBEDDING_MODEL, 'gemini-embedding-001'),
    GEMINI_MULTIMODAL_EMBEDDING_MODEL: readString(
      parsedRaw.GEMINI_MULTIMODAL_EMBEDDING_MODEL,
      'gemini-embedding-2-preview',
    ),
    GEMINI_MEDIA_ANALYSIS_MODEL: readString(
      parsedRaw.GEMINI_MEDIA_ANALYSIS_MODEL,
      'gemini-2.5-flash',
    ),
    GOOGLE_CLOUD_PROJECT_ID: readString(parsedRaw.GOOGLE_CLOUD_PROJECT_ID),
    GOOGLE_CLOUD_LOCATION: readString(parsedRaw.GOOGLE_CLOUD_LOCATION, 'global'),
    GOOGLE_RANKING_CONFIG: readString(parsedRaw.GOOGLE_RANKING_CONFIG, 'default_ranking_config'),
    GOOGLE_RANKING_MODEL: readString(
      parsedRaw.GOOGLE_RANKING_MODEL,
      'semantic-ranker-default@latest',
    ),
    GOOGLE_CLOUD_ACCESS_TOKEN: readString(parsedRaw.GOOGLE_CLOUD_ACCESS_TOKEN),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: readString(parsedRaw.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: readString(parsedRaw.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    RAG_CHAT_RERANK_OPTIONAL: parseBoolean({
      key: 'RAG_CHAT_RERANK_OPTIONAL',
      value: readString(parsedRaw.RAG_CHAT_RERANK_OPTIONAL, 'true'),
      defaultValue: true,
      issues,
    }),
    ORCHESTRATION_ENGINE: parseOrchestrationEngine(
      readString(parsedRaw.ORCHESTRATION_ENGINE, 'langgraph'),
      issues,
    ),
    GROQ_API_KEY: readString(parsedRaw.GROQ_API_KEY),
    GROQ_ROUTER_MODEL: readString(parsedRaw.GROQ_ROUTER_MODEL, 'llama-3.1-8b-instant'),
    GEMINI_API_KEY: readString(parsedRaw.GEMINI_API_KEY, readString(parsedRaw.GOOGLE_API_KEY)),
    OPENAI_ROUTER_MODEL: readString(parsedRaw.OPENAI_ROUTER_MODEL, 'gpt-4o-mini'),
    OPENAI_SUPERVISOR_MODEL: readString(parsedRaw.OPENAI_SUPERVISOR_MODEL, 'gpt-4o'),
    OPENAI_PLANNER_MODEL: readString(parsedRaw.OPENAI_PLANNER_MODEL, 'gpt-4o-mini'),
    OPENAI_SYNTHESIS_MODEL: readString(parsedRaw.OPENAI_SYNTHESIS_MODEL, 'gpt-4o-mini'),
    OPENAI_TEMPERATURE: openAiTemperature,
    LANGSMITH_TRACING: parseBoolean({
      key: 'LANGSMITH_TRACING',
      value: readString(parsedRaw.LANGSMITH_TRACING, 'false'),
      defaultValue: false,
      issues,
    }),
    LANGSMITH_API_KEY: readString(parsedRaw.LANGSMITH_API_KEY),
    LANGSMITH_PROJECT: readString(parsedRaw.LANGSMITH_PROJECT),
    LANGSMITH_ENDPOINT: readString(parsedRaw.LANGSMITH_ENDPOINT, 'https://api.smith.langchain.com'),
    LARK_TENANT_BINDING_ENFORCED: parseBoolean({
      key: 'LARK_TENANT_BINDING_ENFORCED',
      value: readString(parsedRaw.LARK_TENANT_BINDING_ENFORCED, 'false'),
      defaultValue: false,
      issues,
    }),
    DOC_UPLOAD_MAX_MB: docUploadMaxMb,
    DOC_EXTRACT_MAX_WORDS: docExtractMaxWords,
    DOC_GENERATION_MAX_WORDS: docGenerationMaxWords,
    CLOUDINARY_CLOUD_NAME: readString(parsedRaw.CLOUDINARY_CLOUD_NAME),
    CLOUDINARY_API_KEY: readString(parsedRaw.CLOUDINARY_API_KEY),
    CLOUDINARY_API_SECRET: readString(parsedRaw.CLOUDINARY_API_SECRET),
    CLOUDINARY_UPLOAD_PRESET: readString(parsedRaw.CLOUDINARY_UPLOAD_PRESET, 'zoho_automation'),
    CLOUDINARY_FOLDER: readString(parsedRaw.CLOUDINARY_FOLDER, 'zoho_automation_files'),
  };

  for (const [key, value] of [
    ['REDIS_URL', config.REDIS_URL],
    ['REDIS_QUEUE_URL', config.REDIS_QUEUE_URL],
    ['REDIS_STATE_URL', config.REDIS_STATE_URL],
    ['REDIS_CACHE_URL', config.REDIS_CACHE_URL],
  ] as const) {
    if (!value.startsWith('redis://') && !value.startsWith('rediss://')) {
      issues.push({
        key,
        code: 'invalid_protocol',
        message: `${key} must start with redis:// or rediss://`,
        severity: 'error',
      });
    }
  }

  const hasLarkAppId = config.LARK_APP_ID.length > 0;
  const hasLarkAppSecret = config.LARK_APP_SECRET.length > 0;
  const hasLarkVerificationToken = config.LARK_VERIFICATION_TOKEN.length > 0;
  const hasLarkSigningSecret = config.LARK_WEBHOOK_SIGNING_SECRET.length > 0;
  const hasStaticTenantToken = config.LARK_BOT_TENANT_ACCESS_TOKEN.length > 0;
  const hasAppBaseUrl = config.APP_BASE_URL.length > 0;
  const hasGoogleClientId = config.GOOGLE_OAUTH_CLIENT_ID.length > 0;
  const hasGoogleClientSecret = config.GOOGLE_OAUTH_CLIENT_SECRET.length > 0;
  const hasGoogleRedirectUri = config.GOOGLE_OAUTH_REDIRECT_URI.length > 0;
  const hasAnyGoogleOAuthConfig =
    hasGoogleClientId || hasGoogleClientSecret || hasGoogleRedirectUri;

  if ((hasLarkAppId && !hasLarkAppSecret) || (!hasLarkAppId && hasLarkAppSecret)) {
    issues.push({
      key: 'LARK_APP_ID,LARK_APP_SECRET',
      code: 'paired_required',
      message: 'LARK_APP_ID and LARK_APP_SECRET must be set together',
      severity: 'error',
    });
  }

  if ((hasLarkAppId || hasLarkAppSecret) && !hasAppBaseUrl) {
    warnings.push({
      key: 'APP_BASE_URL',
      code: 'missing_value',
      message: 'APP_BASE_URL should be set when Lark OAuth is configured',
      severity: 'warning',
    });
  }

  if (hasAnyGoogleOAuthConfig) {
    if (!hasGoogleClientId || !hasGoogleClientSecret || !hasGoogleRedirectUri) {
      warnings.push({
        key: 'GOOGLE_OAUTH_CLIENT_ID,GOOGLE_OAUTH_CLIENT_SECRET,GOOGLE_OAUTH_REDIRECT_URI',
        code: 'paired_required',
        message:
          'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI should be set together',
        severity: 'warning',
      });
    }
  }

  const hasZohoClientId = config.ZOHO_CLIENT_ID.length > 0;
  const hasZohoClientSecret = config.ZOHO_CLIENT_SECRET.length > 0;
  const hasZohoRedirectUri = config.ZOHO_REDIRECT_URI.length > 0;
  const hasZohoTokenKey = config.ZOHO_TOKEN_ENCRYPTION_KEY.length > 0;
  const hasAnyZohoAuthConfig =
    hasZohoClientId || hasZohoClientSecret || hasZohoRedirectUri || hasZohoTokenKey;

  if (hasAnyZohoAuthConfig) {
    if (!hasZohoClientId || !hasZohoClientSecret || !hasZohoRedirectUri) {
      warnings.push({
        key: 'ZOHO_CLIENT_ID,ZOHO_CLIENT_SECRET,ZOHO_REDIRECT_URI',
        code: 'paired_required',
        message: 'ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REDIRECT_URI should be set together',
        severity: 'warning',
      });
    }

    if (!hasZohoTokenKey) {
      warnings.push({
        key: 'ZOHO_TOKEN_ENCRYPTION_KEY',
        code: 'missing_value',
        message: 'ZOHO_TOKEN_ENCRYPTION_KEY should be set when Zoho OAuth is configured',
        severity: 'warning',
      });
    }
  }

  try {
    const parsedOutreach = new URL(config.OUTREACH_API_URL);
    if (parsedOutreach.protocol !== 'http:' && parsedOutreach.protocol !== 'https:') {
      issues.push({
        key: 'OUTREACH_API_URL',
        code: 'invalid_protocol',
        message: 'OUTREACH_API_URL must be http:// or https://',
        severity: 'error',
      });
    }
  } catch {
    issues.push({
      key: 'OUTREACH_API_URL',
      code: 'invalid_url',
      message: 'OUTREACH_API_URL must be a valid URL',
      severity: 'error',
    });
  }

  if (
    readString(parsedRaw.SEPER_API_KEY).length > 0 &&
    readString(parsedRaw.SERPER_API_KEY).length === 0
  ) {
    warnings.push({
      key: 'SEPER_API_KEY,SERPER_API_KEY',
      code: 'deprecated_alias',
      message: 'SEPER_API_KEY is deprecated; rename it to SERPER_API_KEY when possible',
      severity: 'warning',
    });
  }

  try {
    const parsedQdrant = new URL(config.QDRANT_URL);
    if (parsedQdrant.protocol !== 'http:' && parsedQdrant.protocol !== 'https:') {
      issues.push({
        key: 'QDRANT_URL',
        code: 'invalid_protocol',
        message: 'QDRANT_URL must be http:// or https://',
        severity: 'error',
      });
    }
  } catch {
    issues.push({
      key: 'QDRANT_URL',
      code: 'invalid_url',
      message: 'QDRANT_URL must be a valid URL',
      severity: 'error',
    });
  }

  if (config.NODE_ENV === 'production' && !hasLarkVerificationToken && !hasLarkSigningSecret) {
    issues.push({
      key: 'LARK_VERIFICATION_TOKEN,LARK_WEBHOOK_SIGNING_SECRET',
      code: 'missing_verification_config',
      message: 'In production, set LARK_VERIFICATION_TOKEN or LARK_WEBHOOK_SIGNING_SECRET',
      severity: 'error',
    });
  }

  const hasOpenAiApiKey = readString(parsedRaw.OPENAI_API_KEY).length > 0;
  const hasGroqApiKey = config.GROQ_API_KEY.length > 0;

  if (hasOpenAiApiKey || hasGroqApiKey) {
    if (config.OPENAI_ROUTER_MODEL.length === 0 && config.GROQ_ROUTER_MODEL.length === 0) {
      issues.push({
        key: 'OPENAI_ROUTER_MODEL',
        code: 'missing_value',
        message: 'A router model is required when an API Key is set',
        severity: 'error',
      });
    }

    if (config.OPENAI_PLANNER_MODEL.length === 0) {
      issues.push({
        key: 'OPENAI_PLANNER_MODEL',
        code: 'missing_value',
        message: 'OPENAI_PLANNER_MODEL is required when OPENAI_API_KEY is set',
        severity: 'error',
      });
    }

    if (config.OPENAI_SYNTHESIS_MODEL.length === 0) {
      issues.push({
        key: 'OPENAI_SYNTHESIS_MODEL',
        code: 'missing_value',
        message: 'OPENAI_SYNTHESIS_MODEL is required when OPENAI_API_KEY is set',
        severity: 'error',
      });
    }
  }

  if (config.EMBEDDING_PROVIDER === 'openai' && !hasOpenAiApiKey) {
    warnings.push({
      key: 'EMBEDDING_PROVIDER,OPENAI_API_KEY',
      code: 'embedding_provider_fallback',
      message:
        'EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is missing; embeddings will fall back deterministically',
      severity: 'warning',
    });
  }

  if (config.EMBEDDING_PROVIDER === 'gemini' && !config.GEMINI_API_KEY) {
    warnings.push({
      key: 'EMBEDDING_PROVIDER,GEMINI_API_KEY',
      code: 'embedding_provider_fallback',
      message:
        'EMBEDDING_PROVIDER=gemini but GEMINI_API_KEY is missing; embeddings will fall back deterministically',
      severity: 'warning',
    });
  }

  if (config.LANGSMITH_TRACING && (!config.LANGSMITH_API_KEY || !config.LANGSMITH_PROJECT)) {
    warnings.push({
      key: 'LANGSMITH_TRACING,LANGSMITH_API_KEY,LANGSMITH_PROJECT',
      code: 'tracing_disabled',
      message:
        'LANGSMITH_TRACING is enabled but LANGSMITH_API_KEY/LANGSMITH_PROJECT are incomplete; tracing sink will be disabled',
      severity: 'warning',
    });
  }

  if (config.ZOHO_PROVIDER_DEFAULT === 'mcp' && !config.ZOHO_MCP_ENABLED) {
    warnings.push({
      key: 'ZOHO_PROVIDER_DEFAULT,ZOHO_MCP_ENABLED',
      code: 'provider_default_disabled',
      message:
        'ZOHO_PROVIDER_DEFAULT is mcp but ZOHO_MCP_ENABLED is false; runtime will fall back to rest',
      severity: 'warning',
    });
  }

  if (!config.MCP_SECRET_ENCRYPTION_KEY && !config.ZOHO_TOKEN_ENCRYPTION_KEY) {
    warnings.push({
      key: 'MCP_SECRET_ENCRYPTION_KEY,ZOHO_TOKEN_ENCRYPTION_KEY',
      code: 'missing_value',
      message:
        'Set MCP_SECRET_ENCRYPTION_KEY (or ZOHO_TOKEN_ENCRYPTION_KEY fallback) for encrypted MCP credential storage',
      severity: 'warning',
    });
  }

  if (
    config.NODE_ENV !== 'production' &&
    !hasLarkAppId &&
    !hasLarkAppSecret &&
    !hasStaticTenantToken
  ) {
    warnings.push({
      key: 'LARK_APP_ID,LARK_APP_SECRET,LARK_BOT_TENANT_ACCESS_TOKEN',
      code: 'lark_outbound_not_configured',
      message: 'Lark outbound credentials are not configured; outbound send may fail',
      severity: 'warning',
    });
  }

  if (config.NODE_ENV !== 'production' && config.JWT_SECRET === 'changeme') {
    warnings.push({
      key: 'JWT_SECRET',
      code: 'insecure_default',
      message: 'JWT_SECRET is using default value "changeme" in non-production',
      severity: 'warning',
    });
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return {
    config,
    warnings,
  };
};
