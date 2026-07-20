import type { LarkApprovalClientPort } from '../../../../application/orchestration/tools/families/lark-approval.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type ApprovalRecord = Record<string, unknown>;

const DEFAULT_APPROVAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;

const normalizeInstance = (r: ApprovalRecord) => ({
  instanceCode: (r['instance_code'] ?? r['id'] ?? '') as string,
  approvalCode: r['approval_code'] as string | undefined,
  status: r['status'] as string | undefined,
  title: (r['title'] ?? r['reason'] ?? r['name'] ?? '') as string,
});

export class LarkApprovalClient implements LarkApprovalClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async listInstances(
    approvalCode: string,
    limit?: number,
    window?: { startTime?: string; endTime?: string },
  ): Promise<unknown[]> {
    type ListResponse = {
      instance_code_list?: string[];
      page_token?: string;
      has_more?: boolean;
    };

    const now = Date.now();
    const startTime = window?.startTime ?? String(now - DEFAULT_APPROVAL_LOOKBACK_MS);
    const endTime = window?.endTime ?? String(now);
    const target = Math.min(50, Math.max(1, limit ?? 20));
    const instanceCodes: string[] = [];
    let pageToken: string | undefined;

    do {
      const data = await this.http.request<ListResponse>(
        'GET',
        '/open-apis/approval/v4/instances',
        {
          query: {
            approval_code: approvalCode,
            start_time: startTime,
            end_time: endTime,
            page_size: Math.min(50, target - instanceCodes.length),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      instanceCodes.push(...(data.instance_code_list ?? []));
      pageToken = data.has_more && instanceCodes.length < target ? data.page_token : undefined;
    } while (pageToken && instanceCodes.length < target);

    const instances = await Promise.all(
      instanceCodes.slice(0, target).map(instanceCode => this.getInstance(approvalCode, instanceCode)),
    );
    return instances;
  }

  async getInstance(approvalCode: string, instanceCode: string): Promise<unknown> {
    type GetResponse = { instance: ApprovalRecord };
    const data = await this.http.request<GetResponse>(
      'GET',
      `/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`,
    );
    return normalizeInstance(data.instance);
  }

  async getDefinition(approvalCode: string): Promise<unknown> {
    type DefinitionResponse = { approval?: ApprovalRecord };
    const data = await this.http.request<DefinitionResponse>(
      'GET',
      `/open-apis/approval/v4/approvals/${encodeURIComponent(approvalCode)}`,
    );
    return data.approval ?? {};
  }

  async createInstance(approvalCode: string, formValues: Record<string, unknown>): Promise<{ instanceCode: string }> {
    type CreateResponse = { instance_code: string };
    const fieldTypes = await this.getApprovalFieldTypes(approvalCode);
    const form = Object.entries(formValues).map(([id, rawValue]) =>
      normalizeFormValue(id, rawValue, fieldTypes),
    );
    const data = await this.http.request<CreateResponse>(
      'POST',
      '/open-apis/approval/v4/instances',
      {
        body: {
          approval_code: approvalCode,
          form: JSON.stringify(form),
        },
      },
    );
    return { instanceCode: data.instance_code };
  }

  private async getApprovalFieldTypes(approvalCode: string): Promise<Map<string, string>> {
    const definition = await this.getDefinition(approvalCode) as ApprovalRecord;
    const form = asRecord(definition['form']);
    const rawContent = form?.['form_content'];
    if (typeof rawContent !== 'string') return new Map();

    try {
      const controls = JSON.parse(rawContent) as unknown;
      if (!Array.isArray(controls)) return new Map();
      return new Map(
        controls.flatMap(control => {
          const record = asRecord(control);
          const id = record?.['id'];
          const type = record?.['type'];
          return typeof id === 'string' && typeof type === 'string' ? [[id, type]] : [];
        }),
      );
    } catch {
      return new Map();
    }
  }
}

function normalizeFormValue(
  id: string,
  rawValue: unknown,
  fieldTypes: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const descriptor = asRecord(rawValue);
  const explicitType = descriptor?.['type'];
  const type = typeof explicitType === 'string' ? explicitType : fieldTypes.get(id);
  if (!type) {
    throw new Error(
      `Approval field "${id}" has no type. Retrieve the approval definition first or pass { type, value }.`,
    );
  }

  const value = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor['value']
    : rawValue;
  const normalized: Record<string, unknown> = { id, type, value };
  if (descriptor && typeof descriptor['required'] === 'boolean') {
    normalized['required'] = descriptor['required'];
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
