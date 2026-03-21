import dotenv from 'dotenv';

import {
  EnvValidationError,
  EnvValidationIssue,
  validateEnvironmentContract,
} from './env.contract';

dotenv.config();

const IS_DEV_BOOT = process.env['NODE_ENV'] !== 'production';

const emitValidationLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
): void => {
  if (IS_DEV_BOOT) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const badge =
      level === 'error'
        ? '\x1b[31mERR\x1b[0m'
        : level === 'warn'
          ? '\x1b[33mWRN\x1b[0m'
          : '\x1b[32mINF\x1b[0m';
    const metaPart = meta
      ? '  \x1b[2m' +
        Object.entries(meta)
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join('  ') +
        '\x1b[0m'
      : '';
    const line = `\x1b[2m${hh}:${mm}:${ss}\x1b[0m ${badge} \x1b[1m${message}\x1b[0m${metaPart}`;
    if (level === 'error') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
    return;
  }

  // Production: structured JSON
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    pid: process.pid,
    ...(meta ? { meta } : {}),
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
    return;
  }

  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(line);
};

const formatIssues = (issues: EnvValidationIssue[]) =>
  issues.map((issue) => ({
    key: issue.key,
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
  }));

let validated;

try {
  validated = validateEnvironmentContract(process.env);
  emitValidationLog('info', 'config.validation.ok', {
    nodeEnv: validated.config.NODE_ENV,
  });

  if (validated.warnings.length > 0) {
    emitValidationLog('warn', 'config.validation.warning', {
      count: validated.warnings.length,
      issues: formatIssues(validated.warnings),
    });
  }
} catch (error) {
  if (error instanceof EnvValidationError) {
    emitValidationLog('error', 'config.validation.failed', {
      count: error.issues.length,
      issues: formatIssues(error.issues),
    });
  } else {
    emitValidationLog('error', 'config.validation.failed', {
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }
  throw error;
}

export const ENV_VALIDATION_WARNINGS = validated.warnings;

export const PORT = validated.config.PORT;
export const NODE_ENV = validated.config.NODE_ENV;
export const APP_BASE_URL = validated.config.APP_BASE_URL;
export const BACKEND_PUBLIC_URL = validated.config.BACKEND_PUBLIC_URL;
export const LOG_LEVEL = validated.config.LOG_LEVEL;
export const LOG_SUCCESS_SAMPLE_RATE = validated.config.LOG_SUCCESS_SAMPLE_RATE;
export const LOG_INCLUDE_STACK = validated.config.LOG_INCLUDE_STACK;
export const DATABASE_URL = validated.config.DATABASE_URL;
export const JWT_SECRET = validated.config.JWT_SECRET;
export const ADMIN_JWT_SECRET = validated.config.ADMIN_JWT_SECRET;
export const ADMIN_SESSION_TTL_MINUTES = validated.config.ADMIN_SESSION_TTL_MINUTES;
export const CORS_ALLOWED_ORIGINS = validated.config.CORS_ALLOWED_ORIGINS;
export const REDIS_URL = validated.config.REDIS_URL;
export const ORCHESTRATION_WORKER_CONCURRENCY = validated.config.ORCHESTRATION_WORKER_CONCURRENCY;
export const ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS =
  validated.config.ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS;
export const ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS =
  validated.config.ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS;
export const ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS =
  validated.config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS;
export const ORCHESTRATION_QUEUE_LOCK_DURATION_MS =
  validated.config.ORCHESTRATION_QUEUE_LOCK_DURATION_MS;
export const ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS =
  validated.config.ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS;
export const ORCHESTRATION_QUEUE_MAX_STALLED_COUNT =
  validated.config.ORCHESTRATION_QUEUE_MAX_STALLED_COUNT;
export const HITL_TIMEOUT_SECONDS = validated.config.HITL_TIMEOUT_SECONDS;
export const CHECKPOINT_TTL_SECONDS = validated.config.CHECKPOINT_TTL_SECONDS;
export const RETRY_MAX_ATTEMPTS = validated.config.RETRY_MAX_ATTEMPTS;
export const RETRY_BASE_DELAY_MS = validated.config.RETRY_BASE_DELAY_MS;
export const INGRESS_IDEMPOTENCY_TTL_SECONDS = validated.config.INGRESS_IDEMPOTENCY_TTL_SECONDS;
export const LARK_API_BASE_URL = validated.config.LARK_API_BASE_URL;
export const LARK_APP_ID = validated.config.LARK_APP_ID;
export const LARK_APP_SECRET = validated.config.LARK_APP_SECRET;
export const LARK_BOT_TENANT_ACCESS_TOKEN = validated.config.LARK_BOT_TENANT_ACCESS_TOKEN;
export const LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS =
  validated.config.LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS;
export const LARK_TENANT_TOKEN_FETCH_MAX_RETRIES =
  validated.config.LARK_TENANT_TOKEN_FETCH_MAX_RETRIES;
export const LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS =
  validated.config.LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS;
export const LARK_VERIFICATION_TOKEN = validated.config.LARK_VERIFICATION_TOKEN;
export const LARK_ENCRYPT_KEY = validated.config.LARK_ENCRYPT_KEY;
export const LARK_WEBHOOK_SIGNING_SECRET = validated.config.LARK_WEBHOOK_SIGNING_SECRET;
export const LARK_WEBHOOK_MAX_SKEW_SECONDS = validated.config.LARK_WEBHOOK_MAX_SKEW_SECONDS;
export const GOOGLE_OAUTH_CLIENT_ID = validated.config.GOOGLE_OAUTH_CLIENT_ID;
export const GOOGLE_OAUTH_CLIENT_SECRET = validated.config.GOOGLE_OAUTH_CLIENT_SECRET;
export const GOOGLE_OAUTH_REDIRECT_URI = validated.config.GOOGLE_OAUTH_REDIRECT_URI;
export const ZOHO_CLIENT_ID = validated.config.ZOHO_CLIENT_ID;
export const ZOHO_CLIENT_SECRET = validated.config.ZOHO_CLIENT_SECRET;
export const ZOHO_REDIRECT_URI = validated.config.ZOHO_REDIRECT_URI;
export const ZOHO_ACCOUNTS_BASE_URL = validated.config.ZOHO_ACCOUNTS_BASE_URL;
export const ZOHO_API_BASE_URL = validated.config.ZOHO_API_BASE_URL;
export const ZOHO_TOKEN_ENCRYPTION_KEY = validated.config.ZOHO_TOKEN_ENCRYPTION_KEY;
export const ZOHO_PROVIDER_DEFAULT = validated.config.ZOHO_PROVIDER_DEFAULT;
export const ZOHO_MCP_ENABLED = validated.config.ZOHO_MCP_ENABLED;
export const ZOHO_MCP_ACTIONS_ENABLED = validated.config.ZOHO_MCP_ACTIONS_ENABLED;
export const MCP_REQUEST_TIMEOUT_MS = validated.config.MCP_REQUEST_TIMEOUT_MS;
export const MCP_MAX_RETRIES = validated.config.MCP_MAX_RETRIES;
export const MCP_RETRY_BASE_DELAY_MS = validated.config.MCP_RETRY_BASE_DELAY_MS;
export const MCP_SECRET_ENCRYPTION_KEY = validated.config.MCP_SECRET_ENCRYPTION_KEY;
export const OUTREACH_API_URL = validated.config.OUTREACH_API_URL;
export const OUTREACH_API_TIMEOUT_MS = validated.config.OUTREACH_API_TIMEOUT_MS;
export const SERPER_API_KEY = validated.config.SERPER_API_KEY;
export const SERPER_TIMEOUT_MS = validated.config.SERPER_TIMEOUT_MS;
export const QDRANT_URL = validated.config.QDRANT_URL;
export const QDRANT_API_KEY = validated.config.QDRANT_API_KEY;
export const QDRANT_COLLECTION = validated.config.QDRANT_COLLECTION;
export const QDRANT_RETRIEVAL_COLLECTION = validated.config.QDRANT_RETRIEVAL_COLLECTION;
export const QDRANT_TIMEOUT_MS = validated.config.QDRANT_TIMEOUT_MS;
export const EMBEDDING_PROVIDER = validated.config.EMBEDDING_PROVIDER;
export const OPENAI_EMBEDDING_MODEL = validated.config.OPENAI_EMBEDDING_MODEL;
export const GEMINI_EMBEDDING_MODEL = validated.config.GEMINI_EMBEDDING_MODEL;
export const GEMINI_MULTIMODAL_EMBEDDING_MODEL = validated.config.GEMINI_MULTIMODAL_EMBEDDING_MODEL;
export const GEMINI_MEDIA_ANALYSIS_MODEL = validated.config.GEMINI_MEDIA_ANALYSIS_MODEL;
export const GOOGLE_CLOUD_PROJECT_ID = validated.config.GOOGLE_CLOUD_PROJECT_ID;
export const GOOGLE_CLOUD_LOCATION = validated.config.GOOGLE_CLOUD_LOCATION;
export const GOOGLE_RANKING_CONFIG = validated.config.GOOGLE_RANKING_CONFIG;
export const GOOGLE_RANKING_MODEL = validated.config.GOOGLE_RANKING_MODEL;
export const GOOGLE_CLOUD_ACCESS_TOKEN = validated.config.GOOGLE_CLOUD_ACCESS_TOKEN;
export const GOOGLE_SERVICE_ACCOUNT_EMAIL = validated.config.GOOGLE_SERVICE_ACCOUNT_EMAIL;
export const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
  validated.config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
export const RAG_CHAT_RERANK_OPTIONAL = validated.config.RAG_CHAT_RERANK_OPTIONAL;
export const ORCHESTRATION_ENGINE = validated.config.ORCHESTRATION_ENGINE;
export const GROQ_API_KEY = validated.config.GROQ_API_KEY;
export const GROQ_ROUTER_MODEL = validated.config.GROQ_ROUTER_MODEL;
export const GEMINI_API_KEY = validated.config.GEMINI_API_KEY;
export const OPENAI_ROUTER_MODEL = validated.config.OPENAI_ROUTER_MODEL;
export const OPENAI_SUPERVISOR_MODEL = validated.config.OPENAI_SUPERVISOR_MODEL;
export const OPENAI_PLANNER_MODEL = validated.config.OPENAI_PLANNER_MODEL;
export const OPENAI_SYNTHESIS_MODEL = validated.config.OPENAI_SYNTHESIS_MODEL;
export const OPENAI_TEMPERATURE = validated.config.OPENAI_TEMPERATURE;
export const LANGSMITH_TRACING = validated.config.LANGSMITH_TRACING;
export const LANGSMITH_API_KEY = validated.config.LANGSMITH_API_KEY;
export const LANGSMITH_PROJECT = validated.config.LANGSMITH_PROJECT;
export const LANGSMITH_ENDPOINT = validated.config.LANGSMITH_ENDPOINT;
export const LARK_TENANT_BINDING_ENFORCED = validated.config.LARK_TENANT_BINDING_ENFORCED;
export const DOC_UPLOAD_MAX_MB = validated.config.DOC_UPLOAD_MAX_MB;
export const DOC_EXTRACT_MAX_WORDS = validated.config.DOC_EXTRACT_MAX_WORDS;
export const DOC_GENERATION_MAX_WORDS = validated.config.DOC_GENERATION_MAX_WORDS;
export const CLOUDINARY_CLOUD_NAME = validated.config.CLOUDINARY_CLOUD_NAME;
export const CLOUDINARY_API_KEY = validated.config.CLOUDINARY_API_KEY;
export const CLOUDINARY_API_SECRET = validated.config.CLOUDINARY_API_SECRET;
export const CLOUDINARY_UPLOAD_PRESET = validated.config.CLOUDINARY_UPLOAD_PRESET;
export const CLOUDINARY_FOLDER = validated.config.CLOUDINARY_FOLDER;
