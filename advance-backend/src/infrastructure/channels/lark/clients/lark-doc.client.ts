import type { LarkDocClientPort } from '../../../../application/orchestration/tools/families/lark-doc.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type DocRecord = Record<string, unknown>;
type DocRef = { docToken: string; url?: string; docUrl?: string };

const BLOCK_TYPE_NUM: Record<string, number> = {
  text:     2,
  heading1: 3,
  heading2: 4,
  heading3: 5,
  bullet:   12,
  code:     14,
};

function textBlock(content: string, blockType = 'text'): Record<string, unknown> {
  const typeNum = BLOCK_TYPE_NUM[blockType] ?? 2;
  return {
    block_type: typeNum,
    text: { elements: [{ text_run: { content } }], style: {} },
  };
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function markdownWithTitle(title: string, markdown: string): string {
  const trimmed = markdown.replace(/^\s+/, '');
  if (/^#\s+\S/m.test(trimmed)) return trimmed;
  return `# ${title}\n\n${markdown.trimStart()}`;
}

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
    try {
      const meta = await this.getDocMeta(docToken);
      return { ...data.document, ...(meta.url ? { url: meta.url, docUrl: meta.docUrl ?? meta.url } : {}) };
    } catch {
      return data.document;
    }
  }

  async createDoc(title: string): Promise<DocRef> {
    type CreateResponse = { document: DocRecord };
    const data = await this.http.request<CreateResponse>(
      'POST',
      '/open-apis/docs_ai/v1/documents',
      { body: { content: `<title>${escapeXmlText(title)}</title>`, format: 'xml' } },
    );
    return this.docRefFromDocument(data.document);
  }

  async createMarkdownDoc(title: string, markdown: string): Promise<DocRef> {
    type CreateResponse = { document: DocRecord };
    const data = await this.http.request<CreateResponse>(
      'POST',
      '/open-apis/docs_ai/v1/documents',
      { body: { content: markdownWithTitle(title, markdown), format: 'markdown' } },
    );
    return this.docRefFromDocument(data.document);
  }

  async appendBlock(docToken: string, content: string, blockType?: string): Promise<void> {
    const docData = await this.http.request<{ document: DocRecord }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
    );
    const rootBlockId = docData.document['document_id'] as string;
    await this.http.request(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(rootBlockId)}/children`,
      { body: { children: [textBlock(content, blockType ?? 'text')] } },
    );
  }

  async appendMarkdown(docToken: string, markdown: string): Promise<void> {
    await this.http.request(
      'PUT',
      `/open-apis/docs_ai/v1/documents/${encodeURIComponent(docToken)}`,
      {
        body: {
          block_id: '-1',
          command: 'block_insert_after',
          content: markdown,
          format: 'markdown',
          revision_id: -1,
        },
      },
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

  private async getDocMeta(docToken: string): Promise<{ url?: string; docUrl?: string }> {
    type MetaResponse = { metas?: Array<Record<string, unknown>> };
    const data = await this.http.request<MetaResponse>(
      'POST',
      '/open-apis/drive/v1/metas/batch_query',
      {
        body: {
          request_docs: [{ doc_token: docToken, doc_type: 'docx' }],
          with_url: true,
        },
      },
    );
    const url = data.metas?.find(meta => meta['doc_token'] === docToken || meta['doc_type'] === 'docx')?.['url'];
    return typeof url === 'string' && url.length > 0 ? { url, docUrl: url } : {};
  }

  private async withDocMeta(docToken: string): Promise<DocRef> {
    try {
      const meta = await this.getDocMeta(docToken);
      return { docToken, ...(meta.url ? { url: meta.url, docUrl: meta.docUrl ?? meta.url } : {}) };
    } catch {
      return { docToken };
    }
  }

  private async docRefFromDocument(document: DocRecord): Promise<DocRef> {
    const docToken = (document['document_id'] ?? document['doc_token'] ?? '') as string;
    const url = document['url'];
    if (typeof url === 'string' && url.length > 0) {
      return { docToken, url, docUrl: url };
    }
    return this.withDocMeta(docToken);
  }
}
