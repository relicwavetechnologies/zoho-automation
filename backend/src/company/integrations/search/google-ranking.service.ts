import { createSign } from 'crypto';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import type { RerankCandidate, RerankResult } from '../vector/retrieval-contract';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_RANKING_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

type AccessTokenState = {
  token: string;
  expiresAt: number;
};

const base64Url = (value: string): string =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const signJwt = (input: {
  clientEmail: string;
  privateKey: string;
  scope: string;
  audience: string;
}): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iss: input.clientEmail,
      sub: input.clientEmail,
      scope: input.scope,
      aud: input.audience,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer
    .sign(input.privateKey, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${header}.${payload}.${signature}`;
};

class GoogleCloudAccessTokenProvider {
  private cachedToken: AccessTokenState | null = null;

  private normalisedPrivateKey(): string {
    return config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
  }

  isConfigured(): boolean {
    return Boolean(
      config.GOOGLE_CLOUD_ACCESS_TOKEN.trim() ||
      (config.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim() && this.normalisedPrivateKey()),
    );
  }

  async getToken(): Promise<string | null> {
    if (config.GOOGLE_CLOUD_ACCESS_TOKEN.trim()) {
      return config.GOOGLE_CLOUD_ACCESS_TOKEN.trim();
    }

    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.token;
    }

    if (!config.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim() || !this.normalisedPrivateKey()) {
      return null;
    }

    const assertion = signJwt({
      clientEmail: config.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim(),
      privateKey: this.normalisedPrivateKey(),
      scope: GOOGLE_RANKING_SCOPE,
      audience: GOOGLE_OAUTH_TOKEN_URL,
    });

    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Google OAuth token exchange failed: HTTP ${response.status}${body ? ` - ${body}` : ''}`,
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!payload.access_token) {
      throw new Error('Google OAuth token exchange returned no access_token');
    }

    this.cachedToken = {
      token: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
    return this.cachedToken.token;
  }
}

type RankingApiResponse = {
  records?: Array<{
    id?: string;
    score?: number;
  }>;
};

const truncateForRanking = (value: string, tokenBudget = 900): string => {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const maxWords = Math.max(1, Math.floor(tokenBudget / 1.3));
  return words.length <= maxWords ? value.trim() : words.slice(0, maxWords).join(' ');
};

export class GoogleRankingService {
  private readonly tokenProvider = new GoogleCloudAccessTokenProvider();

  isConfigured(): boolean {
    return Boolean(
      config.GOOGLE_CLOUD_PROJECT_ID.trim() &&
      config.GOOGLE_RANKING_CONFIG.trim() &&
      this.tokenProvider.isConfigured(),
    );
  }

  private fallback(records: RerankCandidate[], topN: number): RerankResult[] {
    return records
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, topN)
      .map((record, index) => ({
        ...record,
        rerankScore: record.score ?? records.length - index,
      }));
  }

  async rerank(
    query: string,
    records: RerankCandidate[],
    topN: number,
    options: { required?: boolean } = {},
  ): Promise<RerankResult[]> {
    const normalizedQuery = query.trim();
    const normalizedRecords = records
      .filter((record) => record.content.trim().length > 0)
      .map((record) => ({
        ...record,
        content: truncateForRanking(record.content),
      }));
    if (!normalizedQuery || normalizedRecords.length === 0) {
      return [];
    }

    if (!this.isConfigured()) {
      if (options.required && config.NODE_ENV === 'production') {
        throw new Error('Google ranking is required in production but is not configured');
      }
      return this.fallback(normalizedRecords, topN);
    }

    try {
      const token = await this.tokenProvider.getToken();
      if (!token) {
        throw new Error('No Google Cloud access token available for ranking');
      }

      const response = await fetch(
        `https://discoveryengine.googleapis.com/v1/projects/${encodeURIComponent(config.GOOGLE_CLOUD_PROJECT_ID)}/locations/${encodeURIComponent(config.GOOGLE_CLOUD_LOCATION)}/rankingConfigs/${encodeURIComponent(config.GOOGLE_RANKING_CONFIG)}:rank`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Goog-User-Project': config.GOOGLE_CLOUD_PROJECT_ID,
          },
          body: JSON.stringify({
            model: config.GOOGLE_RANKING_MODEL,
            query: normalizedQuery,
            topN,
            records: normalizedRecords.map((record) => ({
              id: record.id,
              title: record.title,
              content: record.content,
            })),
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Google ranking request failed: HTTP ${response.status}${body ? ` - ${body}` : ''}`,
        );
      }

      const payload = (await response.json()) as RankingApiResponse;
      const byId = new Map(normalizedRecords.map((record) => [record.id, record]));
      const ranked = (payload.records ?? [])
        .map((entry) => {
          if (!entry.id) return null;
          const record = byId.get(entry.id);
          if (!record) return null;
          return {
            ...record,
            rerankScore: typeof entry.score === 'number' ? entry.score : (record.score ?? 0),
          };
        })
        .filter((record): record is RerankResult => Boolean(record));

      if (ranked.length > 0) {
        return ranked;
      }

      throw new Error('Google ranking returned no ranked records');
    } catch (error) {
      logger.warn('google.ranking.failed', {
        model: config.GOOGLE_RANKING_MODEL,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
      if (options.required && config.NODE_ENV === 'production') {
        throw error;
      }
      return this.fallback(normalizedRecords, topN);
    }
  }
}

export const googleRankingService = new GoogleRankingService();
