import { BaseService } from '../../core/service';

import { AdminControlsRepository, adminControlsRepository } from './admin-controls.repository';
import { ADMIN_CONTROL_KEYS, ApplyControlDto } from './dto/apply-control.dto';

const DEFAULT_CONTROL_VALUES: Record<string, boolean> = {
  'zoho.integration.enabled': true,
  'runtime.historical_sync.enabled': true,
  'runtime.delta_sync.enabled': true,
  'zoho.user_scoped_read.strict_enabled': true,
};

export class AdminControlsService extends BaseService {
  constructor(private readonly repository: AdminControlsRepository = adminControlsRepository) {
    super();
  }

  async listControls(companyId?: string) {
    const rows = await this.repository.listControlStates(companyId);
    const map = new Map(rows.map((row) => [`${row.controlKey}:${row.companyId ?? 'global'}`, row]));

    return ADMIN_CONTROL_KEYS.map((key) => {
      const row = map.get(`${key}:${companyId ?? 'global'}`);
      const value = row ? row.value === 'true' : DEFAULT_CONTROL_VALUES[key];

      return {
        controlKey: key,
        value,
        companyId: companyId ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
        updatedBy: row?.updatedBy ?? 'system-default',
      };
    });
  }

  async applyControl(payload: ApplyControlDto, appliedBy: string) {
    const row = await this.repository.upsertControlState({
      controlKey: payload.controlKey,
      companyId: payload.companyId,
      value: String(payload.requestedValue),
      updatedBy: appliedBy,
    });

    return {
      controlKey: row.controlKey,
      requestedValue: row.value === 'true',
      appliedBy: row.updatedBy,
      appliedAt: row.updatedAt.toISOString(),
      status: 'applied',
      companyId: row.companyId,
    };
  }
}

export const adminControlsService = new AdminControlsService();
