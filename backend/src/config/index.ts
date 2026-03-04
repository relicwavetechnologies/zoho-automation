import {
  ADMIN_JWT_SECRET,
  ADMIN_SESSION_TTL_MINUTES,
  DATABASE_URL,
  JWT_SECRET,
  NODE_ENV,
  PORT,
} from './env';

const config = {
  PORT,
  NODE_ENV,
  DATABASE_URL,
  JWT_SECRET,
  ADMIN_JWT_SECRET,
  ADMIN_SESSION_TTL_MINUTES,
} as const;

export default config;

