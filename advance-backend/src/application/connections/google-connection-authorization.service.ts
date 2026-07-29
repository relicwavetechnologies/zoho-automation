import {
  GOOGLE_WORKSPACE_OAUTH_SCOPES,
  hasGoogleScopeGroups,
} from '../../domain/google/google-workspace-scope';
import type { GoogleOAuthService } from '../../infrastructure/google/google-oauth.service';
import type { IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import type {
  AuthorizationCallbackClaim,
  ConnectionAuthorizationRepository,
  CreateConnectionAuthorizationIntentInput,
} from '../../infrastructure/persistence/connection-authorization.repository';
import type { Logger } from '../../shared/logger';

export interface IssuedGoogleAuthorization {
  outcome: 'issued';
  intentId: string;
  authorizeUrl: string;
  expiresAt: Date;
  correlationId: string;
}

export interface ExistingGoogleAuthorization {
  outcome: 'already_pending';
  intentId: string;
  expiresAt: Date;
  correlationId: string;
}

export type GoogleAuthorizationCompletion =
  | { outcome: 'connected'; intentId: string; connectionId: string; accountName: string }
  | { outcome: 'denied' }
  | { outcome: 'invalid' }
  | { outcome: 'expired' }
  | { outcome: 'already_consumed' };

type IntentRepo = Pick<
  ConnectionAuthorizationRepository,
  | 'create'
  | 'claimCallback'
  | 'stageExchangeTokens'
  | 'loadRecoverableExchange'
  | 'listStaleExchangeIds'
  | 'markAuthorizationFailed'
>;

type GoogleOAuth = Pick<
  GoogleOAuthService,
  'getAuthorizeUrl' | 'exchangeAuthorizationCode' | 'fetchUserInfo'
>;

type ConnectionRepo = Pick<
  IntegrationConnectionRepository,
  'upsertGoogleConnection'
>;

const REQUIRED_SCOPE_GROUPS = GOOGLE_WORKSPACE_OAUTH_SCOPES.map(scope => [scope] as const);

export class GoogleConnectionAuthorizationService {
  private readonly log: Logger;

  constructor(private readonly deps: {
    intentRepo: IntentRepo;
    googleOAuth: GoogleOAuth;
    connectionRepo: ConnectionRepo;
    callbackUrl: string;
    logger: Logger;
  }) {
    this.log = deps.logger.child({ service: 'google-connection-authorization' });
  }

  async issue(
    input: CreateConnectionAuthorizationIntentInput,
  ): Promise<IssuedGoogleAuthorization | ExistingGoogleAuthorization> {
    const created = await this.deps.intentRepo.create(input);
    if (!created.ok) throw created.error;
    if (created.value.outcome === 'already_pending') return created.value;

    return {
      outcome: 'issued',
      intentId: created.value.intentId,
      authorizeUrl: this.deps.googleOAuth.getAuthorizeUrl({
        state: created.value.state,
        redirectUri: this.deps.callbackUrl,
      }),
      expiresAt: created.value.expiresAt,
      correlationId: created.value.correlationId,
    };
  }

  async complete(input: {
    state: string;
    code?: string;
    providerError?: string;
  }): Promise<GoogleAuthorizationCompletion> {
    const code = input.code?.trim();
    const claim = await this.deps.intentRepo.claimCallback(
      input.state,
      new Date(),
      code,
    );
    if (!claim.ok) throw claim.error;
    if (claim.value.outcome !== 'claimed') {
      return callbackTerminalOutcome(claim.value);
    }

    const intent = claim.value.intent;
    if (input.providerError) {
      await this.fail(intent.intentId, 'authorization_denied');
      return { outcome: 'denied' };
    }
    if (!code) {
      await this.fail(intent.intentId, 'authorization_code_missing');
      return { outcome: 'invalid' };
    }

    try {
      return await this.finishExchange(intent, code);
    } catch (error) {
      await this.fail(intent.intentId, classifyAuthorizationFailure(error));
      throw error;
    }
  }

  async reconcileStaleExchanges(
    staleBefore: Date,
  ): Promise<Array<Extract<GoogleAuthorizationCompletion, { outcome: 'connected' }>>> {
    const listed = await this.deps.intentRepo.listStaleExchangeIds(staleBefore);
    if (!listed.ok) throw listed.error;
    const completed: Array<
      Extract<GoogleAuthorizationCompletion, { outcome: 'connected' }>
    > = [];
    for (const intentId of listed.value) {
      const loaded = await this.deps.intentRepo.loadRecoverableExchange(intentId);
      if (!loaded.ok) throw loaded.error;
      if (!loaded.value) continue;
      try {
        const result = await this.finishExchange(
          loaded.value.intent,
          loaded.value.authorizationCode,
          loaded.value.tokens,
        );
        completed.push(result);
      } catch (error) {
        await this.fail(intentId, classifyAuthorizationFailure(error));
        this.log.error('google.authorization.exchange_recovery_failed', {
          intentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return completed;
  }

  private async finishExchange(
    intent: Extract<AuthorizationCallbackClaim, { outcome: 'claimed' }>['intent'],
    authorizationCode: string,
    stagedTokens?: Record<string, unknown>,
  ): Promise<Extract<GoogleAuthorizationCompletion, { outcome: 'connected' }>> {
    const tokens = stagedTokens
      ? parseStagedTokens(stagedTokens)
      : await this.deps.googleOAuth.exchangeAuthorizationCode(
          authorizationCode,
          this.deps.callbackUrl,
        );
    if (!stagedTokens) {
      const staged = await this.deps.intentRepo.stageExchangeTokens(
        intent.intentId,
        tokens,
      );
      if (!staged.ok) throw staged.error;
      if (!staged.value) {
        throw new Error('Google authorization exchange was no longer claimable.');
      }
    }
    const grantedScopes = tokens.scope
      ?.split(' ')
      .map(scope => scope.trim())
      .filter(Boolean) ?? [];
    if (!hasGoogleScopeGroups(grantedScopes, REQUIRED_SCOPE_GROUPS)) {
      throw new Error('Google did not grant the complete Workspace scope set.');
    }
    if (!tokens.refreshToken) {
      throw new Error('Google returned no offline refresh credential.');
    }

    const userInfo = await this.deps.googleOAuth.fetchUserInfo(tokens.accessToken);
    const expiresAt = new Date(
      Date.now() + (tokens.expiresIn ?? 3_600) * 1_000,
    );
    const saved = await this.deps.connectionRepo.upsertGoogleConnection({
        companyId: intent.companyId,
        ownerType: 'user',
        ownerUserId: intent.userId,
        createdBy: intent.userId,
        googleUserId: userInfo.sub,
        scope: tokens.scope ?? '',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType ?? 'Bearer',
        accessTokenExpiresAt: expiresAt,
        initialAccess: 'admin',
        authorizationIntentId: intent.intentId,
        ...(userInfo.email ? { googleEmail: userInfo.email } : {}),
        ...(userInfo.name ? { googleName: userInfo.name } : {}),
    });
    if (!saved.ok) throw saved.error;
    if (
      saved.value.companyId !== intent.companyId
      || saved.value.ownerType !== 'user'
      || saved.value.ownerUserId !== intent.userId
      || saved.value.provider !== 'google_workspace'
      || !saved.value.refreshToken
    ) {
      throw new Error('Stored Google connection does not match the authorization intent.');
    }

    this.log.info('google.authorization.connected', {
      intentId: intent.intentId,
      connectionId: saved.value.id,
      companyId: intent.companyId,
      userId: intent.userId,
      correlationId: intent.correlationId,
    });
    return {
      outcome: 'connected',
      intentId: intent.intentId,
      connectionId: saved.value.id,
      accountName: saved.value.accountEmail
        ?? saved.value.accountName
        ?? 'Google Workspace',
    };
  }

  private async fail(intentId: string, failureCode: string): Promise<void> {
    const failed = await this.deps.intentRepo.markAuthorizationFailed(
      intentId,
      failureCode,
    );
    if (!failed.ok) {
      this.log.error('google.authorization.failure_persist_failed', {
        intentId,
        failureCode,
        error: failed.error.message,
      });
    }
  }
}

function parseStagedTokens(value: Record<string, unknown>): {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  scope?: string;
} {
  const accessToken = typeof value['accessToken'] === 'string'
    ? value['accessToken']
    : '';
  if (!accessToken) throw new Error('Staged Google exchange has no access token.');
  return {
    accessToken,
    ...(typeof value['refreshToken'] === 'string'
      ? { refreshToken: value['refreshToken'] }
      : {}),
    ...(typeof value['tokenType'] === 'string'
      ? { tokenType: value['tokenType'] }
      : {}),
    ...(typeof value['expiresIn'] === 'number'
      ? { expiresIn: value['expiresIn'] }
      : {}),
    ...(typeof value['scope'] === 'string' ? { scope: value['scope'] } : {}),
  };
}

function callbackTerminalOutcome(
  claim: Exclude<AuthorizationCallbackClaim, { outcome: 'claimed' }>,
): GoogleAuthorizationCompletion {
  switch (claim.outcome) {
    case 'invalid':
    case 'expired':
    case 'already_consumed':
      return { outcome: claim.outcome };
  }
}

function classifyAuthorizationFailure(error: unknown): string {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error);
  if (text.includes('scope')) return 'scope_incomplete';
  if (text.includes('refresh')) return 'refresh_credential_missing';
  if (text.includes('userinfo')) return 'google_identity_unavailable';
  return 'authorization_completion_failed';
}
