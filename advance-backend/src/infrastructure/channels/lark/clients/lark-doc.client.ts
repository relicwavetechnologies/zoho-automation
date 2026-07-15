import type { LarkDocClientPort } from '../../../../application/orchestration/tools/families/lark-doc.tool';
import { LarkApiError, LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type DocRecord = Record<string, unknown>;

const BLOCK_TYPE_NUM = {
  text:     2,
  heading1: 3,
  heading2: 4,
  heading3: 5,
  bullet:   12,
  code:     14,
} as const;

type SupportedBlockType = keyof typeof BLOCK_TYPE_NUM;

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

  async createDoc(title: string): Promise<{ docToken: string; url?: string }> {
    type CreateResponse = { document?: DocRecord };
    const data = await this.http.request<CreateResponse>(
      'POST',
      '/open-apis/docx/v1/documents',
      { body: { title } },
    );
    const docToken = typeof data.document?.['document_id'] === 'string'
      ? data.document['document_id']
      : '';
    if (!docToken) {
      throw new LarkApiError(
        'Lark create document response did not include document_id',
        200,
      );
    }

    // The Docx create API does not return a URL. Resolve the provider-owned
    // canonical link through Drive metadata, without turning a successful
    // create into a failure if that follow-up read is unavailable.
    try {
      type MetadataResponse = { metas?: DocRecord[] };
      const metadata = await this.http.request<MetadataResponse>(
        'POST',
        '/open-apis/drive/v1/metas/batch_query',
        {
          body: {
            request_docs: [{ doc_token: docToken, doc_type: 'docx' }],
            with_url: true,
          },
        },
      );
      const url = metadata.metas
        ?.map(meta => meta['url'])
        .find((candidate): candidate is string => isAbsoluteHttpUrl(candidate));
      return url ? { docToken, url } : { docToken };
    } catch {
      return { docToken };
    }
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
      { body: { children: [buildRichTextBlock(content, blockType)] } },
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

  async updateBlock(docToken: string, blockId: string, content: string): Promise<void> {
    await this.http.request(
      'PATCH',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(blockId)}`,
      {
        query: { document_revision_id: -1 },
        body: {
          update_text_elements: { elements: [{ text_run: { content } }] },
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
    type CreateTableResponse = {
      children?: Array<{ table?: { cells?: string[] } }>;
    };
    const created = await this.http.request<CreateTableResponse>(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(parentBlockId)}/children`,
      {
        query: { document_revision_id: -1 },
        body: {
          children: [{
            block_type: 31,
            table: {
              property: {
                row_size: params.rows,
                column_size: params.cols,
                ...(params.headers?.length ? { header_row: true } : {}),
              },
            },
          }],
        },
      },
    );

    const headers = params.headers?.slice(0, params.cols) ?? [];
    if (headers.length === 0) return;

    const cells = created.children?.[0]?.table?.cells ?? [];
    if (cells.length < headers.length) {
      throw new LarkApiError(
        'Lark created the table but did not return enough cell IDs to populate its headers',
        200,
      );
    }
    for (const [index, header] of headers.entries()) {
      const cellId = cells[index]!;
      await this.http.request(
        'POST',
        `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(cellId)}/children`,
        {
          query: { document_revision_id: -1 },
          body: { children: [buildRichTextBlock(header, 'text')] },
        },
      );
    }
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

function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildRichTextBlock(content: string, requestedType?: string): DocRecord {
  const blockType: SupportedBlockType = isSupportedBlockType(requestedType)
    ? requestedType
    : 'text';
  return {
    block_type: BLOCK_TYPE_NUM[blockType],
    [blockType]: {
      elements: [{ text_run: { content } }],
      style: {},
    },
  };
}

function isSupportedBlockType(value: string | undefined): value is SupportedBlockType {
  return value !== undefined && Object.prototype.hasOwnProperty.call(BLOCK_TYPE_NUM, value);
}
