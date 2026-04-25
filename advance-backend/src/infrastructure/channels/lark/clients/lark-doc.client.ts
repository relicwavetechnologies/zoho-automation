import type { LarkDocClientPort } from '../../../../application/orchestration/tools/families/lark-doc.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type DocRecord = Record<string, unknown>;

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
    const type = blockType ?? 'text';
    const blockBody: Record<string, unknown> = {
      block_type: type === 'text' ? 2 : type === 'heading1' ? 3 : 2,
      text: {
        elements: [{ text_run: { content } }],
        style: {},
      },
    };
    type BlocksResponse = { children?: unknown[] };
    // Get root block id first
    const docData = await this.http.request<{ document: DocRecord }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
    );
    const rootBlockId = docData.document['document_id'] as string;

    await this.http.request<BlocksResponse>(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(rootBlockId)}/children`,
      { body: { children: [blockBody] } },
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
}
