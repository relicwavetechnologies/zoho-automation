import { InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type {
  PublishRequest,
  PublishedDocument,
  PublishedDocumentPort,
} from '../../application/publishing/published-document.port';

const VERCEL_DEPLOYMENTS_URL = 'https://api.vercel.com/v13/deployments';

export type VercelPublisherFailureCode =
  | 'not_configured'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'transport'
  | 'invalid_response';

export class VercelPublisherError extends Error {
  readonly code: VercelPublisherFailureCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: VercelPublisherFailureCode,
    message: string,
    retryable: boolean,
    status?: number,
  ) {
    super(message);
    this.name = 'VercelPublisherError';
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
  }
}

export interface VercelPublisherOptions {
  readonly token?: string;
  readonly projectName?: string;
  readonly teamId?: string;
  readonly fetchImpl?: typeof fetch;
}

type VercelDeploymentResponse = {
  readonly id?: unknown;
  readonly url?: unknown;
};

export class VercelPublisher implements PublishedDocumentPort {
  private readonly token: string;
  private readonly projectName: string;
  private readonly teamId: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VercelPublisherOptions) {
    this.token = options.token?.trim() ?? '';
    this.projectName = options.projectName?.trim() ?? '';
    const teamId = options.teamId?.trim();
    this.teamId = teamId || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publish(request: PublishRequest): Promise<Result<PublishedDocument, InfraError>> {
    if (!this.token) {
      return this.failure(new VercelPublisherError(
        'not_configured',
        'VERCEL_TOKEN is not configured.',
        false,
      ));
    }
    if (!this.projectName) {
      return this.failure(new VercelPublisherError(
        'not_configured',
        'VERCEL_PROJECT_NAME is not configured.',
        false,
      ));
    }

    const endpoint = new URL(VERCEL_DEPLOYMENTS_URL);
    if (this.teamId) endpoint.searchParams.set('teamId', this.teamId);

    let response: Response;
    let raw: string;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: request.slug,
          project: this.projectName,
          files: [{ file: 'index.html', data: request.html }],
          projectSettings: { framework: null },
          target: 'production',
        }),
      });
      raw = await response.text();
    } catch {
      return this.failure(new VercelPublisherError(
        'transport',
        'Vercel deployment request failed.',
        true,
      ));
    }

    if (!response.ok) {
      const retryable = response.status >= 500;
      return this.failure(new VercelPublisherError(
        retryable ? 'upstream_5xx' : 'upstream_4xx',
        providerMessage(raw) || `Vercel returned HTTP ${response.status}.`,
        retryable,
        response.status,
      ));
    }

    let payload: VercelDeploymentResponse;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      payload = parsed as VercelDeploymentResponse;
    } catch {
      return this.failure(new VercelPublisherError(
        'invalid_response',
        'Vercel returned an invalid deployment response.',
        true,
        response.status,
      ));
    }

    if (typeof payload.id !== 'string' || !payload.id.trim()) {
      return this.failure(new VercelPublisherError(
        'invalid_response',
        'Vercel returned a deployment without an id.',
        true,
        response.status,
      ));
    }
    const url = httpsUrl(payload.url);
    if (!url) {
      return this.failure(new VercelPublisherError(
        'invalid_response',
        'Vercel returned a deployment without an HTTPS URL.',
        true,
        response.status,
      ));
    }

    return ok({ url, deploymentId: payload.id });
  }

  private failure(error: VercelPublisherError): Result<never, InfraError> {
    return err(new InfraError({
      layer: 'http',
      op: 'vercel.deployments.create',
      cause: error,
      message: error.message,
    }));
  }
}

function providerMessage(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as { readonly message?: unknown; readonly error?: unknown };
      if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
      if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
        const nested = record.error as { readonly message?: unknown };
        if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim();
      }
    }
  } catch {
    // A plain-text provider response is still a useful cause.
  }
  return text.slice(0, 1_000);
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.startsWith('http://') || value.startsWith('https://')
    ? value
    : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.toString() : null;
  } catch {
    return null;
  }
}
