import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string): string | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  openaiApiKey: required('OPENAI_API_KEY'),
  googleClientId: required('GOOGLE_CLIENT_ID'),
  googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: required('GOOGLE_REDIRECT_URI'),
  appBaseUrl: required('APP_BASE_URL'),
  port: parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '8000', 10),
  smtp: {
    host: optional('SMTP_HOST'),
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: String(process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    user: optional('SMTP_USER'),
    pass: optional('SMTP_PASS'),
    from: optional('SMTP_FROM') ?? 'no-reply@localhost',
  },
};
