import type { LarkDocClientPort } from '../../../../application/orchestration/tools/families/lark-doc.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type DocRecord = Record<string, unknown>;

const BLOCK_TYPE_NUM: Record<string, number> = {
  text:     2,
  heading1: 3,
  heading2: 4,
  heading3: 5,
  bullet:   12,
  code:     14,
};

export class LarkDocClient implements LarkDocClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async getDoc(docToken: string): Promise<unknown> {
    type GetResponse = { document: DocRecord };
    const data = await this.http.request<GetResponse>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
    );
    return data.document;
  }

  async createDoc(title: string): Promise<{ docToken: string }> {
    type CreateResponse = { document: DocRecord };
    const data = await this.http.request<CreateResponse>(
      'POST',
      '/open-apis/docx/v1/documents',
      { body: { title } },
    );
    return { docToken: (data.document['document_id'] ?? '') as string };
  }

  async appendBlock(docToken: string, content: string, blockType?: string): Promise<void> {
    const typeNum = BLOCK_TYPE_NUM[blockType ?? 'text'] ?? 2;
    const docData = await this.http.request<{ document: DocRecord }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
    );
    const rootBlockId = docData.document['document_id'] as string;
    await this.http.request(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(rootBlockId)}/children`,
      { body: { children: [{ block_type: typeNum, text: { elements: [{ text_run: { content } }], style: {} } }] } },
    );
  }

  async listBlocks(docToken: string): Promise<unknown[]> {
    type BlocksResponse = { items?: DocRecord[] };
    const data = await this.http.request<BlocksResponse>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks`,
    );
    return data.items ?? [];
  }

  async updateBlock(docToken: string, blockId: string, content: string, blockType?: string): Promise<void> {
    const typeNum = BLOCK_TYPE_NUM[blockType ?? 'text'] ?? 2;
    await this.http.request(
      'PATCH',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(blockId)}`,
      {
        body: {
          block_type: typeNum,
          update_text_elements: { elements: [{ text_run: { content } }] },
          document_revision_id: -1,
        },
      },
    );
  }

  async deleteBlock(docToken: string, blockId: string): Promise<void> {
    await this.http.request(
      'DELETE',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(blockId)}/children/batch_delete`,
      { body: { document_revision_id: -1 } },
    );
  }

  async insertTable(
    docToken: string,
    params: { afterBlockId?: string; rows: number; cols: number; headers?: string[] },
  ): Promise<void> {
    const docData = await this.http.request<{ document: DocRecord }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
    );
    const parentBlockId = params.afterBlockId ?? (docData.document['document_id'] as string);
    await this.http.request(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(parentBlockId)}/children`,
      {
        body: {
          children: [{
            block_type: 31,
            table: {
              property: { row_size: params.rows, column_size: params.cols },
              cells: params.rows * params.cols,
            },
          }],
          document_revision_id: -1,
        },
      },
    );
  }

  async shareDoc(docToken: string, visibility: string): Promise<{ shareUrl?: string }> {
    const externalEntity = visibility === 'anyone' ? 'open' : 'close';
    const securityEntity =
      visibility === 'anyone' ? 'anyone_readable' :
      visibility === 'tenant' ? 'tenant_readable' :
      'specified_external_accessible';
    await this.http.request(
      'PUT',
      `/open-apis/drive/v1/permissions/${encodeURIComponent(docToken)}/public?type=docx`,
      { body: { external_access_entity: externalEntity, security_entity: securityEntity } },
    );
    return {};
  }
}
