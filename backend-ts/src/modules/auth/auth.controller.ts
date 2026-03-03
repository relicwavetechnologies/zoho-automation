import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';

import { config } from '../../config/env';
import { AuthRequest } from '../../middlewares/auth.middleware';
import { AppHttpError } from '../../middlewares/error.middleware';
import { prisma } from '../../utils/prisma';
import { createToken } from './auth.jwt';
import { capabilitiesForRole } from '../policy/policy.service';
import {
  AuthResponse,
  LoginDto,
  RegisterDto,
  SessionBootstrapResponse,
  SessionExchangeRequest,
  UserResponse,
} from './auth.types';
import {
  buildGoogleAuthUrl,
  consumeExchangeToken,
  createExchangeToken,
  createOAuthState,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  verifyOAuthState,
} from './auth.oauth';

function mapUser(user: {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  is_email_verified: boolean;
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    is_email_verified: user.is_email_verified,
  };
}

async function buildSessionBootstrap(userId: string): Promise<SessionBootstrapResponse> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppHttpError(401, 'User not found');
  }

  const membership = await prisma.membership.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'asc' },
    include: { organization: true },
  });

  if (!membership) {
    return {
      user: mapUser(user),
      organization: null,
      membership: null,
      capabilities: {
        tools_allowed: [],
        tools_blocked: [],
      },
    };
  }

  return {
    user: mapUser(user),
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
    },
    membership: {
      role_key: membership.role_key,
      status: membership.status,
    },
    capabilities: await capabilitiesForRole({
      organizationId: membership.organization_id,
      roleKey: membership.role_key,
    }),
  };
}

function parseNameParts(profile: {
  given_name?: string;
  family_name?: string;
  name?: string;
}) {
  if (profile.given_name || profile.family_name) {
    return {
      first_name: profile.given_name?.trim() || 'User',
      last_name: profile.family_name?.trim() || 'Unknown',
    };
  }

  const parts = (profile.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { first_name: 'User', last_name: 'Unknown' };
  }
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: 'Unknown' };
  }

  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' '),
  };
}

function validateRegister(dto: RegisterDto) {
  if (!dto.first_name?.trim()) throw new AppHttpError(400, 'First name is required');
  if (!dto.last_name?.trim()) throw new AppHttpError(400, 'Last name is required');
  if (!dto.email?.trim() || !dto.email.includes('@')) {
    throw new AppHttpError(400, 'Valid email is required');
  }
  if (!dto.password || dto.password.length < 8) {
    throw new AppHttpError(400, 'Password must be at least 8 characters');
  }
}

export async function register(req: Request, res: Response) {
  const dto = req.body as RegisterDto;
  validateRegister(dto);

  const email = dto.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppHttpError(409, 'Email already in use');
  }

  const password_hash = await bcrypt.hash(dto.password, 12);

  const user = await prisma.user.create({
    data: {
      first_name: dto.first_name.trim(),
      last_name: dto.last_name.trim(),
      email,
      password_hash,
      is_email_verified: false,
    },
  });

  const token = createToken(user.id);
  const payload: AuthResponse = { token, user: mapUser(user) };
  return res.status(201).json(payload);
}

export async function login(req: Request, res: Response) {
  const dto = req.body as LoginDto;

  if (!dto.email?.trim() || !dto.password) {
    throw new AppHttpError(400, 'Email and password are required');
  }

  const email = dto.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppHttpError(401, 'Invalid credentials');
  }

  const valid = await bcrypt.compare(dto.password, user.password_hash);
  if (!valid) {
    throw new AppHttpError(401, 'Invalid credentials');
  }

  const token = createToken(user.id);
  const payload: AuthResponse = { token, user: mapUser(user) };
  return res.status(200).json(payload);
}

export async function me(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppHttpError(401, 'User not found');
  }

  return res.status(200).json(mapUser(user));
}

export async function googleStart(_req: Request, res: Response) {
  const state = createOAuthState();
  const url = buildGoogleAuthUrl(state);
  return res.redirect(url);
}

export async function googleCallback(req: Request, res: Response) {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  if (!code || !state) {
    throw new AppHttpError(400, 'Missing OAuth code or state');
  }

  verifyOAuthState(state);

  const tokens = await exchangeCodeForTokens(code);
  const googleUser = await fetchGoogleUserInfo(tokens.access_token);

  const { first_name, last_name } = parseNameParts(googleUser);
  const email = googleUser.email.toLowerCase();

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      first_name,
      last_name,
      password_hash: `oauth:${googleUser.sub}`,
      google_sub: googleUser.sub,
      is_email_verified: googleUser.email_verified,
    },
    update: {
      first_name,
      last_name,
      google_sub: googleUser.sub,
      is_email_verified: googleUser.email_verified,
    },
  });

  const exchangeToken = createExchangeToken(user.id);
  const redirectUrl = new URL('/auth/callback', config.appBaseUrl);
  redirectUrl.searchParams.set('exchange_token', exchangeToken);

  return res.redirect(redirectUrl.toString());
}

export async function sessionExchange(req: Request, res: Response) {
  const body = req.body as SessionExchangeRequest;
  const exchangeToken = body?.exchange_token;

  if (!exchangeToken) {
    throw new AppHttpError(400, 'exchange_token is required');
  }

  const userId = consumeExchangeToken(exchangeToken);
  const token = createToken(userId);
  const bootstrap = await buildSessionBootstrap(userId);

  return res.status(200).json({ token, ...bootstrap });
}

export async function sessionBootstrap(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const bootstrap = await buildSessionBootstrap(userId);
  return res.status(200).json(bootstrap);
}
