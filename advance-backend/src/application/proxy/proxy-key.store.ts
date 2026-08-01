/**
 * ProxyKeyStore — server-side resolution of an upstream provider key.
 *
 * The desktop/PI never holds a provider key; it authenticates with its member
 * token and the backend attaches the resolved key when forwarding. Keys are
 * stored AES-256-GCM encrypted (token.crypto format) in ProxyProviderKey.
 *
 * Resolution precedence for a request from company X:
 *   1. company-scoped active key for X
 *   2. platform-wide active key
 *   3. none → caller returns 503 "not configured" (proxy stays mounted)
 *
 * A key an admin saved is the only key. There used to be an env fallback under
 * those two, which meant a company that had configured nothing still billed
 * against whatever the process happened to be started with, and "no key" was a
 * state the proxy could not report. Both providers now say so plainly instead.
 *
 * Every path is scoped by provider. The row is already keyed on
 * (provider, scopeKey), so a company can hold a DeepSeek key and an OpenAI key
 * at once and neither can be mistaken for the other — which matters because
 * forwarding the wrong one is an authentication failure the user sees as Divo
 * being broken.
 *
 * The full key is only ever returned by resolve() (used internally by the proxy
 * forward). Every admin-facing path returns keyLast4 / a mask, never the secret.
 */

import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { ModelProvider } from '../observability/pricing';
import { encryptToken, decryptToken, TokenCryptoError } from '../../infrastructure/shared/token.crypto';

export type KeyScope = 'platform' | 'company';
export type KeySource = 'company' | 'platform';

/** The providers an admin can hold a key for. */
export const KEY_PROVIDERS = ['deepseek', 'openai'] as const satisfies readonly ModelProvider[];

const PLATFORM_SCOPE_KEY = 'platform';

const scopeKeyFor = (scope: KeyScope, companyId: string): string =>
  scope === 'platform' ? PLATFORM_SCOPE_KEY : companyId;

const last4 = (key: string): string => key.trim().slice(-4);
/** `sk-…·1a2b` — safe to show anywhere. Never derives from the plaintext beyond last-4. */
export const maskFromLast4 = (l4: string): string => `sk-…·${l4}`;

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

export interface ProxyKeyStatus {
  configured: boolean;          // an active key exists AND it can actually be decrypted
  source: KeySource | null;
  scope: KeyScope | null;       // where the stored key (if any) lives
  keyLast4: string | null;
  keyMasked: string | null;
  status: 'active' | 'disabled' | null;
  keyError: 'unreadable' | null; // a key row exists but fails to decrypt (secret rotated/corrupt)
  lastUsedAt: string | null;
}

export interface ProxyKeyStoreDeps {
  prisma: PrismaClient;
  logger: Logger;
  encryptionKey?: string | undefined;   // PROXY_KEY_ENCRYPTION_KEY ?? ZOHO_TOKEN_ENCRYPTION_KEY
}

export class ProxyKeyStore {
  private readonly prisma: PrismaClient;
  private readonly log: Logger;
  private readonly encryptionKey?: string | undefined;

  constructor(deps: ProxyKeyStoreDeps) {
    this.prisma = deps.prisma;
    this.log = deps.logger.child({ service: 'proxy-key-store' });
    this.encryptionKey = deps.encryptionKey?.trim() || undefined;
  }

  /** Whether an admin can persist keys (encryption secret present). */
  canEncrypt(): boolean {
    return Boolean(this.encryptionKey);
  }

  private assertEncryptable(): string {
    if (!this.encryptionKey) {
      throw new TokenCryptoError('Key encryption is not configured (set PROXY_KEY_ENCRYPTION_KEY or ZOHO_TOKEN_ENCRYPTION_KEY)');
    }
    return this.encryptionKey;
  }

  /** Resolve the plaintext key to forward for a company request (company → platform → env). */
  async resolve(provider: ModelProvider, companyId: string): Promise<ResolvedKey | null> {
    if (this.encryptionKey) {
      const rows = await this.prisma.proxyProviderKey.findMany({
        where: { provider, status: 'active', scopeKey: { in: [companyId, PLATFORM_SCOPE_KEY] } },
      });
      // The company key outranks the platform key; whichever is present is THE
      // intended credential for this tier.
      const chosen = rows.find((r) => r.scopeKey === companyId) ?? rows.find((r) => r.scopeKey === PLATFORM_SCOPE_KEY);
      if (chosen) {
        // Fail CLOSED on decrypt failure. If the chosen key can't be decrypted
        // (secret rotated without re-encrypt, or ciphertext corrupt) we must NOT
        // fall through to a lower-precedence key — that would silently swap which
        // credential runs, moving billing/enforcement. Surface it as 503 instead
        // so the operator fixes the secret.
        try {
          const key = decryptToken(chosen.encryptedKey, this.encryptionKey);
          return { key, source: chosen.scope === 'platform' ? 'platform' : 'company' };
        } catch (e) {
          this.log.error('resolve.decrypt_failed', { provider, scopeKey: chosen.scopeKey, error: String(e) });
          return null;
        }
      }
    }
    return null;
  }

  /** Admin-facing status for a scope — never exposes the secret. */
  async status(provider: ModelProvider, companyId: string): Promise<ProxyKeyStatus> {
    const empty: ProxyKeyStatus = { configured: false, source: null, scope: null, keyLast4: null, keyMasked: null, status: null, keyError: null, lastUsedAt: null };

    const rows = this.encryptionKey
      ? await this.prisma.proxyProviderKey.findMany({ where: { provider, scopeKey: { in: [companyId, PLATFORM_SCOPE_KEY] } } })
      : [];
    const company = rows.find((r) => r.scopeKey === companyId);
    const platform = rows.find((r) => r.scopeKey === PLATFORM_SCOPE_KEY);
    // Show the row that would actually be used (active company > active platform),
    // else any present row so the admin sees a disabled key exists.
    const active = rows.find((r) => r.scopeKey === companyId && r.status === 'active')
      ?? rows.find((r) => r.scopeKey === PLATFORM_SCOPE_KEY && r.status === 'active');
    const shown = active ?? company ?? platform;

    if (shown) {
      // Don't report green on metadata alone — verify the stored key actually
      // decrypts, so a rotated/corrupt secret surfaces instead of a false "active".
      let keyError: 'unreadable' | null = null;
      if (this.encryptionKey) {
        try { decryptToken(shown.encryptedKey, this.encryptionKey); } catch { keyError = 'unreadable'; }
      } else {
        keyError = 'unreadable';
      }
      return {
        configured: shown.status === 'active' && keyError === null,
        source: shown.scope === 'platform' ? 'platform' : 'company',
        scope: shown.scope as KeyScope,
        keyLast4: shown.keyLast4,
        keyMasked: maskFromLast4(shown.keyLast4),
        status: shown.status as 'active' | 'disabled',
        keyError,
        lastUsedAt: shown.lastUsedAt?.toISOString() ?? null,
      };
    }
    return empty;
  }

  /** Upsert (save or rotate) a key for a scope. */
  async save(input: { provider: ModelProvider; scope: KeyScope; companyId: string; plaintextKey: string; createdBy?: string | undefined }): Promise<ProxyKeyStatus> {
    const encryptionKey = this.assertEncryptable();
    const plaintext = input.plaintextKey.trim();
    if (!plaintext) throw new TokenCryptoError('Cannot save an empty key');

    const scopeKey = scopeKeyFor(input.scope, input.companyId);
    const encryptedKey = encryptToken(plaintext, encryptionKey).cipherText;
    const data = {
      provider: input.provider,
      scope: input.scope,
      companyId: input.scope === 'platform' ? null : input.companyId,
      scopeKey,
      encryptedKey,
      keyLast4: last4(plaintext),
      status: 'active' as const,
      createdBy: input.createdBy ?? null,
    };
    await this.prisma.proxyProviderKey.upsert({
      where: { provider_scopeKey: { provider: input.provider, scopeKey } },
      create: data,
      update: { encryptedKey: data.encryptedKey, keyLast4: data.keyLast4, status: 'active', scope: data.scope, companyId: data.companyId, createdBy: data.createdBy },
    });
    this.log.info('key.saved', { provider: input.provider, scope: input.scope, scopeKey, last4: data.keyLast4 });
    return this.status(input.provider, input.companyId);
  }

  /** Remove a stored key for a scope. */
  async remove(input: { provider: ModelProvider; scope: KeyScope; companyId: string }): Promise<ProxyKeyStatus> {
    const scopeKey = scopeKeyFor(input.scope, input.companyId);
    await this.prisma.proxyProviderKey.deleteMany({ where: { provider: input.provider, scopeKey } });
    this.log.info('key.removed', { provider: input.provider, scope: input.scope, scopeKey });
    return this.status(input.provider, input.companyId);
  }

  /** Best-effort last-used stamp (never throws into the request path). */
  async touch(provider: ModelProvider, source: KeySource, companyId: string): Promise<void> {
    const scopeKey = source === 'platform' ? PLATFORM_SCOPE_KEY : companyId;
    try {
      await this.prisma.proxyProviderKey.updateMany({ where: { provider, scopeKey }, data: { lastUsedAt: new Date() } });
    } catch (e) {
      this.log.warn('key.touch_failed', { provider, scopeKey, error: String(e) });
    }
  }
}
