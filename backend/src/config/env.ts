import dotenv from 'dotenv';

dotenv.config();

const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
};

export const PORT = parseInt(getEnv('PORT', '8000'), 10);
export const NODE_ENV = getEnv('NODE_ENV', 'development');
export const DATABASE_URL = getEnv('DATABASE_URL', '');
export const JWT_SECRET = getEnv('JWT_SECRET', 'changeme');
export const ADMIN_JWT_SECRET = getEnv('ADMIN_JWT_SECRET', JWT_SECRET);
export const ADMIN_SESSION_TTL_MINUTES = parseInt(getEnv('ADMIN_SESSION_TTL_MINUTES', '480'), 10);
export const CORS_ALLOWED_ORIGINS = getEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:5173');
export const REDIS_URL = getEnv('REDIS_URL', 'redis://127.0.0.1:6379');
export const ORCHESTRATION_WORKER_CONCURRENCY = parseInt(getEnv('ORCHESTRATION_WORKER_CONCURRENCY', '2'), 10);
export const HITL_TIMEOUT_SECONDS = parseInt(getEnv('HITL_TIMEOUT_SECONDS', '300'), 10);
export const CHECKPOINT_TTL_SECONDS = parseInt(getEnv('CHECKPOINT_TTL_SECONDS', '86400'), 10);
export const RETRY_MAX_ATTEMPTS = parseInt(getEnv('RETRY_MAX_ATTEMPTS', '2'), 10);
export const RETRY_BASE_DELAY_MS = parseInt(getEnv('RETRY_BASE_DELAY_MS', '250'), 10);
export const INGRESS_IDEMPOTENCY_TTL_SECONDS = parseInt(getEnv('INGRESS_IDEMPOTENCY_TTL_SECONDS', '86400'), 10);
export const LARK_API_BASE_URL = getEnv('LARK_API_BASE_URL', 'https://open.larksuite.com');
export const LARK_APP_ID = getEnv('LARK_APP_ID', '');
export const LARK_APP_SECRET = getEnv('LARK_APP_SECRET', '');
export const LARK_BOT_TENANT_ACCESS_TOKEN = getEnv('LARK_BOT_TENANT_ACCESS_TOKEN', '');
export const LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS = parseInt(
  getEnv('LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS', '180'),
  10,
);
export const LARK_TENANT_TOKEN_FETCH_MAX_RETRIES = parseInt(
  getEnv('LARK_TENANT_TOKEN_FETCH_MAX_RETRIES', '3'),
  10,
);
export const LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS = parseInt(
  getEnv('LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS', '250'),
  10,
);
