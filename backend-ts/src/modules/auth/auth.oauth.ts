import crypto from 'crypto';

import jwt from 'jsonwebtoken';

import { config } from '../../config/env';
import { AppHttpError } from '../../middlewares/error.middleware';

interface OAuthStatePayload {
  nonce: string;
  redirect_to?: string;
  iat: number;
  exp: number;
}

interface GoogleTokenResponse {
  access_token: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
}

const exchangeTokens = new Map<
  string,
  { userId: string; expiresAt: number }
>();

function cleanupExpiredExchangeTokens() {
  const now = Date.now();
  for (const [token, value] of exchangeTokens.entries()) {
    if (value.expiresAt <= now) {
      exchangeTokens.delete(token);
    }
  }
}

setInterval(cleanupExpiredExchangeTokens, 60_000).unref();

export function createOAuthState(redirectTo?: string): string {
  const safeRedirect =
    redirectTo && redirectTo.startsWith('/') && !redirectTo.startsWith('//')
      ? redirectTo
      : undefined;

  const payload: OAuthStatePayload = {
    nonce: crypto.randomBytes(16).toString('hex'),
    ...(safeRedirect ? { redirect_to: safeRedirect } : {}),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  };

  return jwt.sign(payload, config.jwtSecret);
}

export function verifyOAuthState(state: string): OAuthStatePayload {
  try {
    return jwt.verify(state, config.jwtSecret) as OAuthStatePayload;
  } catch {
    throw new AppHttpError(400, 'Invalid OAuth state');
  }
}

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleRedirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new AppHttpError(400, 'Failed to exchange Google OAuth code');
  }

  return (await response.json()) as GoogleTokenResponse;
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new AppHttpError(400, 'Failed to fetch Google user info');
  }

  return (await response.json()) as GoogleUserInfo;
}

export function createExchangeToken(userId: string): string {
  cleanupExpiredExchangeTokens();
  const token = crypto.randomBytes(32).toString('hex');
  exchangeTokens.set(token, {
    userId,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  return token;
}

export function consumeExchangeToken(token: string): string {
  cleanupExpiredExchangeTokens();
  const payload = exchangeTokens.get(token);
  if (!payload) {
    throw new AppHttpError(400, 'Invalid or expired exchange token');
  }

  exchangeTokens.delete(token);
  return payload.userId;
}
