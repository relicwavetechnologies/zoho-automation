import type { Logger } from '../../shared/logger';
import { SemrushClient } from '../../infrastructure/semrush/semrush.client';
import {
  operationApiVersion,
  type SemrushFetchedData,
  type SemrushToolArgs,
  SemrushServiceError,
} from './semrush.types';

/**
 * Normal server-configured Semrush integration. Credentials remain in the
 * backend environment and every call stays on a fixed official endpoint.
 */
export class SemrushService {
  constructor(
    private readonly client: SemrushClient,
    private readonly apiKey: string | undefined,
    private readonly logger: Logger,
  ) {}

  async preflight(args: SemrushToolArgs): Promise<Record<string, unknown>> {
    this.assertReady(args);
    return {
      configured: true,
      operation: args.operation,
      apiVersion: 'v3',
      limits: { maxRowsPerRequest: 1_000 },
    };
  }

  async execute(args: SemrushToolArgs): Promise<SemrushFetchedData> {
    this.assertReady(args);
    const data = await this.client.fetch({ apiKey: this.apiKey!, args });
    this.logger.info('semrush.request.complete', {
      operation: args.operation,
      status: data.status,
      rowCount: data.rows.length,
    });
    return data;
  }

  private assertReady(args: SemrushToolArgs): void {
    if (!this.apiKey?.trim()) throw new SemrushServiceError('not_configured', 'Semrush is not configured on this backend.');
    const apiVersion = operationApiVersion[args.operation];
    if (!apiVersion) throw new SemrushServiceError('capability_unavailable', `${args.operation} has no verified official Semrush API contract yet.`);
  }
}
