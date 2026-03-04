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
