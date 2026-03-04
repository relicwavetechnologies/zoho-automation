import { DATABASE_URL, NODE_ENV, PORT, JWT_SECRET } from './env';

const config = {
  PORT,
  NODE_ENV,
  DATABASE_URL,
  JWT_SECRET,
} as const;

export default config;


