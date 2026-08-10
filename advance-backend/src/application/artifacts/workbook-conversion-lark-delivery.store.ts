import type { CachePort } from '../../shared/cache';
import type {
  WorkbookConversionLarkDeliveryJob,
  WorkbookConversionLarkDeliveryState,
  WorkbookConversionLarkDeliveryStore,
} from './workbook-conversion-lark-delivery';

const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SEND_LEASE_TTL_SECONDS = 60;

export class RedisWorkbookConversionLarkDeliveryStore
  implements WorkbookConversionLarkDeliveryStore {
  constructor(private readonly cache: CachePort) {}

  async register(job: WorkbookConversionLarkDeliveryJob): Promise<void> {
    const key = stateKey(job.jobKey);
    const created = await this.cache.setNx(key, { job } satisfies WorkbookConversionLarkDeliveryState, STATE_TTL_SECONDS);
    if (!created.ok) throw created.error;
    if (created.value) return;
    const existing = await this.read(job.jobKey);
    if (!existing || JSON.stringify(existing.job) !== JSON.stringify(job)) {
      throw new Error('Workbook conversion delivery is already bound to different request details.');
    }
  }

  async reserveProgressMessage(jobKey: string): Promise<
    | { readonly status: 'claimed'; readonly job: WorkbookConversionLarkDeliveryJob }
    | { readonly status: 'sending' }
    | { readonly status: 'ready'; readonly state: WorkbookConversionLarkDeliveryState }
  > {
    const state = await this.read(jobKey);
    if (!state) throw new Error('Workbook conversion delivery was not registered.');
    if (state.progressMessageId) return { status: 'ready', state };
    const lease = await this.cache.setNx(sendLeaseKey(jobKey), true, SEND_LEASE_TTL_SECONDS);
    if (!lease.ok) throw lease.error;
    return lease.value ? { status: 'claimed', job: state.job } : { status: 'sending' };
  }

  async completeProgressMessage(input: {
    readonly jobKey: string;
    readonly progressMessageId: string;
  }): Promise<WorkbookConversionLarkDeliveryState> {
    const current = await this.read(input.jobKey);
    if (!current) throw new Error('Workbook conversion delivery was not registered.');
    if (current.progressMessageId && current.progressMessageId !== input.progressMessageId) {
      throw new Error('Workbook conversion delivery is already bound to another progress message.');
    }
    const completed = { ...current, progressMessageId: input.progressMessageId };
    const stored = await this.cache.set(stateKey(input.jobKey), completed, STATE_TTL_SECONDS);
    if (!stored.ok) throw stored.error;
    const released = await this.cache.del(sendLeaseKey(input.jobKey));
    if (!released.ok) throw released.error;
    return completed;
  }

  private async read(jobKey: string): Promise<WorkbookConversionLarkDeliveryState | null> {
    const result = await this.cache.get<WorkbookConversionLarkDeliveryState>(stateKey(jobKey));
    if (!result.ok) throw result.error;
    return result.value;
  }
}

function stateKey(jobKey: string): string {
  // Stable compatibility namespace; changing it would duplicate Lark delivery
  // for conversions already running during the exporter removal release.
  return `data-export:workbook-conversion:lark:${jobKey}`;
}

function sendLeaseKey(jobKey: string): string {
  return `${stateKey(jobKey)}:sending`;
}
