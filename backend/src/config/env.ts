import dotenv from 'dotenv';

import { EnvValidationError, EnvValidationIssue, validateEnvironmentContract } from './env.contract';

dotenv.config();

const emitValidationLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
): void => {
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
export const ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS = validated.config.ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS;
export const ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS = validated.config.ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS;
export const ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS = validated.config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS;
export const ORCHESTRATION_QUEUE_LOCK_DURATION_MS = validated.config.ORCHESTRATION_QUEUE_LOCK_DURATION_MS;
export const ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS = validated.config.ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS;
export const ORCHESTRATION_QUEUE_MAX_STALLED_COUNT = validated.config.ORCHESTRATION_QUEUE_MAX_STALLED_COUNT;
export const HITL_TIMEOUT_SECONDS = validated.config.HITL_TIMEOUT_SECONDS;
export const CHECKPOINT_TTL_SECONDS = validated.config.CHECKPOINT_TTL_SECONDS;
export const RETRY_MAX_ATTEMPTS = validated.config.RETRY_MAX_ATTEMPTS;
export const RETRY_BASE_DELAY_MS = validated.config.RETRY_BASE_DELAY_MS;
export const INGRESS_IDEMPOTENCY_TTL_SECONDS = validated.config.INGRESS_IDEMPOTENCY_TTL_SECONDS;
export const LARK_API_BASE_URL = validated.config.LARK_API_BASE_URL;
export const LARK_APP_ID = validated.config.LARK_APP_ID;
export const LARK_APP_SECRET = validated.config.LARK_APP_SECRET;
export const LARK_BOT_TENANT_ACCESS_TOKEN = validated.config.LARK_BOT_TENANT_ACCESS_TOKEN;
export const LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS = validated.config.LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS;
export const LARK_TENANT_TOKEN_FETCH_MAX_RETRIES = validated.config.LARK_TENANT_TOKEN_FETCH_MAX_RETRIES;
export const LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS = validated.config.LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS;
export const LARK_VERIFICATION_TOKEN = validated.config.LARK_VERIFICATION_TOKEN;
export const LARK_ENCRYPT_KEY = validated.config.LARK_ENCRYPT_KEY;
export const LARK_WEBHOOK_SIGNING_SECRET = validated.config.LARK_WEBHOOK_SIGNING_SECRET;
export const LARK_WEBHOOK_MAX_SKEW_SECONDS = validated.config.LARK_WEBHOOK_MAX_SKEW_SECONDS;
export const ZOHO_CLIENT_ID = validated.config.ZOHO_CLIENT_ID;
export const ZOHO_CLIENT_SECRET = validated.config.ZOHO_CLIENT_SECRET;
export const ZOHO_REDIRECT_URI = validated.config.ZOHO_REDIRECT_URI;
export const ZOHO_ACCOUNTS_BASE_URL = validated.config.ZOHO_ACCOUNTS_BASE_URL;
export const ZOHO_API_BASE_URL = validated.config.ZOHO_API_BASE_URL;
export const ZOHO_TOKEN_ENCRYPTION_KEY = validated.config.ZOHO_TOKEN_ENCRYPTION_KEY;
export const QDRANT_URL = validated.config.QDRANT_URL;
export const QDRANT_API_KEY = validated.config.QDRANT_API_KEY;
export const QDRANT_COLLECTION = validated.config.QDRANT_COLLECTION;
export const QDRANT_TIMEOUT_MS = validated.config.QDRANT_TIMEOUT_MS;
export const EMBEDDING_PROVIDER = validated.config.EMBEDDING_PROVIDER;
export const OPENAI_EMBEDDING_MODEL = validated.config.OPENAI_EMBEDDING_MODEL;
export const ORCHESTRATION_ENGINE = validated.config.ORCHESTRATION_ENGINE;
export const ORCHESTRATION_LEGACY_ROLLBACK_ENABLED = validated.config.ORCHESTRATION_LEGACY_ROLLBACK_ENABLED;
export const OPENAI_ROUTER_MODEL = validated.config.OPENAI_ROUTER_MODEL;
export const OPENAI_PLANNER_MODEL = validated.config.OPENAI_PLANNER_MODEL;
export const OPENAI_SYNTHESIS_MODEL = validated.config.OPENAI_SYNTHESIS_MODEL;
export const OPENAI_TEMPERATURE = validated.config.OPENAI_TEMPERATURE;
export const LANGSMITH_TRACING = validated.config.LANGSMITH_TRACING;
export const LANGSMITH_API_KEY = validated.config.LANGSMITH_API_KEY;
export const LANGSMITH_PROJECT = validated.config.LANGSMITH_PROJECT;
