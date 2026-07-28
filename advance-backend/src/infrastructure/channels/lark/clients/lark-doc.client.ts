import type {
  LarkDocBlockInput,
  LarkDocBlockStyle,
  LarkDocClientPort,
  LarkDocTextStyle,
} from '../../../../application/orchestration/tools/families/lark-doc.tool';
import { LarkApiError, LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type DocRecord = Record<string, unknown>;

const BLOCK_TYPE_NUM = {
  text:     2,
  heading1: 3,
  heading2: 4,
  heading3: 5,
  heading4: 6,
  heading5: 7,
  heading6: 8,
  heading7: 9,
  heading8: 10,
  heading9: 11,
  bullet:   12,
  ordered:  13,
  code:     14,
  quote:    15,
  todo:     17,
  divider:  22,
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

  async appendBlock(
    docToken: string,
    content: string,
    blockType?: LarkDocBlockInput['blockType'],
    textStyle?: LarkDocTextStyle,
    blockStyle?: LarkDocBlockStyle,
  ): Promise<void> {
    await this.appendBlocks(docToken, [{
      content,
      ...(blockType ? { blockType } : {}),
      ...(textStyle ? { textStyle } : {}),
      ...(blockStyle ? { blockStyle } : {}),
    }]);
  }

  async appendBlocks(docToken: string, blocks: LarkDocBlockInput[]): Promise<void> {
    const docData = await this.http.request<{ document: DocRecord }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
    );
    const rootBlockId = docData.document['document_id'] as string;
    await this.http.request(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(rootBlockId)}/children`,
      {
        body: {
          children: blocks.map(block =>
            buildRichTextBlock(block.content ?? '', block.blockType, block.textStyle, block.blockStyle)),
        },
      },
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

  async updateBlock(
    docToken: string,
    blockId: string,
    content: string,
    textStyle?: LarkDocTextStyle,
  ): Promise<void> {
    await this.http.request(
      'PATCH',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(blockId)}`,
      {
        query: { document_revision_id: -1 },
        body: {
          update_text_elements: {
            elements: [{ text_run: { content, ...textElementStyle(textStyle) } }],
          },
        },
      },
    );
  }

  async updateBlockStyle(docToken: string, blockId: string, style: LarkDocBlockStyle): Promise<void> {
    const { providerStyle, fields } = blockStyle(style);
    await this.http.request(
      'PATCH',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(blockId)}`,
      {
        query: { document_revision_id: -1 },
        body: { update_text_style: { style: providerStyle, fields } },
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
      children?: Array<{ block_id?: string; table?: { cells?: string[] } }>;
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
    const tableBlockId = created.children?.[0]?.block_id;
    if (!tableBlockId || cells.length < params.rows * params.cols) {
      throw new LarkApiError(
        'Lark created the table but did not return enough block IDs to populate it',
        200,
      );
    }

    type TableDescendantsResponse = { items?: DocRecord[] };
    const descendants = await this.http.request<TableDescendantsResponse>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(tableBlockId)}/children`,
      {
        query: {
          document_revision_id: -1,
          with_descendants: 'true',
          page_size: 500,
        },
      },
    );
    const textBlockByCell = new Map(
      (descendants.items ?? []).flatMap(block => {
        const blockId = stringValue(block['block_id']);
        const textBlockId = childBlockIds(block)[0];
        return blockId && textBlockId ? [[blockId, textBlockId] as const] : [];
      }),
    );
    const requests = populatedCells.map(({ value, cellIndex }) => {
      const textBlockId = textBlockByCell.get(cells[cellIndex]!);
      if (!textBlockId) {
        throw new LarkApiError('Lark created the table but did not return its cell text blocks', 200);
      }
      return {
        block_id: textBlockId,
        update_text_elements: { elements: [{ text_run: { content: value } }] },
      };
    });
    await this.http.request(
      'PATCH',
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/batch_update`,
      {
        query: { document_revision_id: -1 },
        body: { requests },
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

function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildRichTextBlock(
  content: string,
  requestedType?: string,
  textStyle?: LarkDocTextStyle,
  requestedBlockStyle?: LarkDocBlockStyle,
): DocRecord {
  const blockType: SupportedBlockType = isSupportedBlockType(requestedType)
    ? requestedType
    : 'text';
  if (blockType === 'divider') return { block_type: BLOCK_TYPE_NUM.divider, divider: {} };
  return {
    block_type: BLOCK_TYPE_NUM[blockType],
    [blockType]: {
      elements: [{
        text_run: {
          content: blockType === 'bullet' ? stripLeadingBullet(content) : content,
          ...textElementStyle(textStyle),
        },
      }],
      style: blockStyle(requestedBlockStyle).providerStyle,
    },
  };
}

function textElementStyle(style?: LarkDocTextStyle): DocRecord {
  if (!style) return {};
  const textElementStyle = {
    ...(style.bold !== undefined ? { bold: style.bold } : {}),
    ...(style.italic !== undefined ? { italic: style.italic } : {}),
    ...(style.strikethrough !== undefined ? { strikethrough: style.strikethrough } : {}),
    ...(style.underline !== undefined ? { underline: style.underline } : {}),
    ...(style.inlineCode !== undefined ? { inline_code: style.inlineCode } : {}),
    ...(style.backgroundColor !== undefined ? { background_color: style.backgroundColor } : {}),
    ...(style.textColor !== undefined ? { text_color: style.textColor } : {}),
    ...(style.link ? { link: { url: encodeURIComponent(style.link) } } : {}),
  };
  return Object.keys(textElementStyle).length > 0 ? { text_element_style: textElementStyle } : {};
}

function blockStyle(style?: LarkDocBlockStyle): { providerStyle: DocRecord; fields: number[] } {
  if (!style) return { providerStyle: {}, fields: [] };
  const providerStyle: DocRecord = {};
  const fields: number[] = [];
  if (style.align !== undefined) {
    providerStyle['align'] = { left: 1, center: 2, right: 3 }[style.align];
    fields.push(1);
  }
  if (style.done !== undefined) { providerStyle['done'] = style.done; fields.push(2); }
  if (style.folded !== undefined) { providerStyle['folded'] = style.folded; fields.push(3); }
  if (style.codeLanguage !== undefined) { providerStyle['language'] = style.codeLanguage; fields.push(4); }
  if (style.wrap !== undefined) { providerStyle['wrap'] = style.wrap; fields.push(5); }
  if (style.backgroundColor !== undefined) {
    providerStyle['background_color'] = style.backgroundColor;
    fields.push(6);
  }
  if (style.indentationLevel !== undefined) {
    providerStyle['indentation_level'] = style.indentationLevel;
    fields.push(7);
  }
  return { providerStyle, fields };
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
