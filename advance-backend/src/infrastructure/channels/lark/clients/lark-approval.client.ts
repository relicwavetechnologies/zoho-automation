import type { LarkApprovalClientPort } from '../../../../application/orchestration/tools/families/lark-approval.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type ApprovalRecord = Record<string, unknown>;

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

  async listInstances(approvalCode: string, limit?: number): Promise<unknown[]> {
    type ListResponse = { items?: ApprovalRecord[]; instance_code_list?: string[] };
    const data = await this.http.request<ListResponse>(
      'GET',
      '/open-apis/approval/v4/instances',
      { query: { approval_code: approvalCode, page_size: limit ?? 20 } },
    );
    return (data.items ?? []).map(normalizeInstance);
  }

  async getInstance(approvalCode: string, instanceCode: string): Promise<unknown> {
    type GetResponse = { instance: ApprovalRecord };
    const data = await this.http.request<GetResponse>(
      'GET',
      `/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`,
    );
    return normalizeInstance(data.instance);
  }

  async createInstance(approvalCode: string, formValues: Record<string, unknown>): Promise<{ instanceCode: string }> {
    type CreateResponse = { instance_code: string };
    const data = await this.http.request<CreateResponse>(
      'POST',
      '/open-apis/approval/v4/instances',
      {
        body: {
          approval_code: approvalCode,
          form: JSON.stringify(Object.entries(formValues).map(([id, value]) => ({ id, value }))),
        },
      },
    );
    return { instanceCode: data.instance_code };
  }
}
