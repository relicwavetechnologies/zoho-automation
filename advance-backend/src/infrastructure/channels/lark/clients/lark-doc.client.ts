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
    type RawContentResponse = { content?: string };
    const [metadata, rawContent] = await Promise.all([
      this.http.request<GetResponse>(
        'GET',
        `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
      ),
      this.http.request<RawContentResponse>(
        'GET',
        `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/raw_content`,
      ),
    ]);
    return { ...metadata.document, content: rawContent.content ?? '' };
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
    await this.appendBlocks(docToken, [{ content, ...(blockType ? { blockType } : {}) }]);
  }

  async appendBlocks(
    docToken: string,
    blocks: Array<{ content: string; blockType?: string }>,
  ): Promise<void> {
    const docData = await this.http.request<{ document: DocRecord }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
    );
    const rootBlockId = docData.document['document_id'] as string;
    await this.http.request(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(rootBlockId)}/children`,
      { body: { children: blocks.map(block => buildRichTextBlock(block.content, block.blockType)) } },
    );
  }

  async listBlocks(docToken: string): Promise<unknown[]> {
    type BlocksResponse = { items?: DocRecord[]; page_token?: string; has_more?: boolean };
    const blocks: DocRecord[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.http.request<BlocksResponse>(
        'GET',
        `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks`,
        {
          query: {
            page_size: 500,
            document_revision_id: -1,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      blocks.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return blocks;
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
    const blocks = await this.listBlocks(docToken) as DocRecord[];
    const parent = blocks.find(block => childBlockIds(block).includes(blockId));
    if (!parent) {
      throw new LarkApiError(`Could not find the parent block for ${blockId}`, 200);
    }
    const parentBlockId = stringValue(parent['block_id']) ?? stringValue(parent['blockId']);
    const childIndex = childBlockIds(parent).indexOf(blockId);
    if (!parentBlockId || childIndex < 0) {
      throw new LarkApiError(`Could not resolve the delete range for block ${blockId}`, 200);
    }
    await this.http.request(
      'DELETE',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(parentBlockId)}/children/batch_delete`,
      {
        query: { document_revision_id: -1 },
        body: { start_index: childIndex, end_index: childIndex + 1 },
      },
    );
  }

  async insertTable(
    docToken: string,
    params: { afterBlockId?: string; rows: number; cols: number; headers?: string[]; data?: string[][] },
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

    const values = [
      ...(params.headers?.length ? [params.headers.slice(0, params.cols)] : []),
      ...(params.data ?? []).map(row => row.slice(0, params.cols)),
    ];
    const populatedCells = values.flatMap((row, rowIndex) =>
      row.map((value, columnIndex) => ({
        value,
        cellIndex: (rowIndex * params.cols) + columnIndex,
      })),
    ).filter(cell => cell.value.length > 0);
    if (populatedCells.length === 0) return;

    const cells = created.children?.[0]?.table?.cells ?? [];
    if (cells.length < params.rows * params.cols) {
      throw new LarkApiError(
        'Lark created the table but did not return enough cell IDs to populate it',
        200,
      );
    }
    for (const { value, cellIndex } of populatedCells) {
      const cellId = cells[cellIndex]!;
      await this.http.request(
        'POST',
        `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(cellId)}/children`,
        {
          query: { document_revision_id: -1 },
          body: { children: [buildRichTextBlock(value, 'text')] },
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
      elements: [{ text_run: { content: blockType === 'bullet' ? stripLeadingBullet(content) : content } }],
      style: {},
    },
  };
}

function stripLeadingBullet(content: string): string {
  return content.replace(/^\s*(?:[•●▪◦]|\*|-)\s+/, '');
}

function isSupportedBlockType(value: string | undefined): value is SupportedBlockType {
  return value !== undefined && Object.prototype.hasOwnProperty.call(BLOCK_TYPE_NUM, value);
}

function childBlockIds(block: DocRecord): string[] {
  const raw = block['children'] ?? block['child_ids'];
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string')
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
