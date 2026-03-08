import config from '../../../config';
import { logger } from '../../../utils/logger';
import { companyContextResolver } from '../../agents/support/company-context.resolver';
import { larkWorkspaceConfigRepository, type DecryptedLarkWorkspaceConfig } from './lark-workspace-config.repository';
import { LarkTenantTokenService } from './lark-tenant-token.service';

type LarkDocsServiceOptions = {
  fetchImpl?: typeof fetch;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
};

type CreateMarkdownDocInput = {
  companyId?: string;
  larkTenantKey?: string;
  title: string;
  markdown: string;
  folderToken?: string;
};

export type LarkMarkdownDocResult = {
  title: string;
  documentId: string;
  url: string;
  blockCount: number;
};

type RequestOptions = {
  companyId: string;
  workspaceConfig: DecryptedLarkWorkspaceConfig | null;
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  headers?: Record<string, string>;
};

type LarkTextElement = {
  text_run: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      italic?: boolean;
      strikethrough?: boolean;
      inline_code?: boolean;
      link?: { url: string };
    };
  };
};

type LarkBlock =
  | { block_type: 2; text: { elements: LarkTextElement[] } }
  | { block_type: 3; heading1: { elements: LarkTextElement[] } }
  | { block_type: 4; heading2: { elements: LarkTextElement[] } }
  | { block_type: 5; heading3: { elements: LarkTextElement[] } }
  | { block_type: 6; heading4: { elements: LarkTextElement[] } }
  | { block_type: 7; heading5: { elements: LarkTextElement[] } }
  | { block_type: 8; heading6: { elements: LarkTextElement[] } }
  | { block_type: 12; bullet: { elements: LarkTextElement[] } }
  | { block_type: 13; ordered: { elements: LarkTextElement[] } }
  | { block_type: 14; code: { elements: LarkTextElement[] } }
  | { block_type: 15; quote: { elements: LarkTextElement[] } }
  | { block_type: 22; divider: Record<string, never> };

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const normalizeMarkdown = (md: string): string => md.replace(/\r\n/g, '\n').trim();

const readLarkErrorMessage = (payload: unknown): string => {
  const record = asRecord(payload);
  return asString(record?.msg) ?? asString(record?.message) ?? 'Unknown Lark API error';
};

const normalizeTitle = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) {
    return 'Lark Document';
  }
  return trimmed.slice(0, 120);
};

export class LarkDocsIntegrationError extends Error {
  readonly code: 'lark_docs_unavailable' | 'lark_docs_invalid_response' | 'lark_docs_blocks_failed';

  constructor(
    message: string,
    code: 'lark_docs_unavailable' | 'lark_docs_invalid_response' | 'lark_docs_blocks_failed',
  ) {
    super(message);
    this.code = code;
  }
}

function parseInlineMarkdown(text: string): LarkTextElement[] {
  const elements: LarkTextElement[] = [];
  const tokenRegex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ text_run: { content: text.slice(lastIndex, match.index) } });
    }

    const [full, , bold, italic, code, strike, linkText, linkUrl] = match;
    if (bold) {
      elements.push({ text_run: { content: bold, text_element_style: { bold: true } } });
    } else if (italic) {
      elements.push({ text_run: { content: italic, text_element_style: { italic: true } } });
    } else if (code) {
      elements.push({ text_run: { content: code, text_element_style: { inline_code: true } } });
    } else if (strike) {
      elements.push({ text_run: { content: strike, text_element_style: { strikethrough: true } } });
    } else if (linkText && linkUrl) {
      elements.push({ text_run: { content: linkText, text_element_style: { link: { url: linkUrl } } } });
    } else {
      elements.push({ text_run: { content: full } });
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    elements.push({ text_run: { content: text.slice(lastIndex) } });
  }

  return elements.length > 0 ? elements : [{ text_run: { content: text } }];
}

function markdownToLarkBlocks(markdown: string): LarkBlock[] {
  const lines = markdown.split('\n');
  const blocks: LarkBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    const codeFenceMatch = line.match(/^```(\w*)$/);
    if (codeFenceMatch) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push({
        block_type: 14,
        code: {
          elements: [{ text_run: { content: codeLines.join('\n') } }],
        },
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ block_type: 22, divider: {} });
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const blockTypeMap: Record<number, 3 | 4 | 5 | 6 | 7 | 8> = {
        1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8,
      };
      const blockType = blockTypeMap[level] ?? 3;
      const headingKey = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'][level - 1] as
        'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6';
      blocks.push({ block_type: blockType, [headingKey]: { elements: parseInlineMarkdown(content) } } as LarkBlock);
      i += 1;
      continue;
    }

    if (line.startsWith('> ')) {
      blocks.push({ block_type: 15, quote: { elements: parseInlineMarkdown(line.slice(2)) } });
      i += 1;
      continue;
    }

    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      blocks.push({ block_type: 12, bullet: { elements: parseInlineMarkdown(bulletMatch[1]) } });
      i += 1;
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      blocks.push({ block_type: 13, ordered: { elements: parseInlineMarkdown(orderedMatch[1]) } });
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    blocks.push({ block_type: 2, text: { elements: parseInlineMarkdown(line) } });
    i += 1;
  }

  return blocks;
}

class LarkDocsService {
  private readonly fetchImpl: typeof fetch;

  private readonly log: Pick<typeof logger, 'info' | 'warn' | 'error'>;

  constructor(options: LarkDocsServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? logger;
  }

  async createMarkdownDoc(input: CreateMarkdownDocInput): Promise<LarkMarkdownDocResult> {
    const companyId = await companyContextResolver.resolveCompanyId({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
    });
    const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(companyId);
    const title = normalizeTitle(input.title);
    const markdown = normalizeMarkdown(input.markdown);

    if (!markdown) {
      throw new LarkDocsIntegrationError('Markdown content is empty', 'lark_docs_invalid_response');
    }

    const { documentId, url } = await this.createBlankDocument({
      companyId,
      workspaceConfig,
      title,
      folderToken: input.folderToken,
    });

    const blocks = markdownToLarkBlocks(markdown);
    const blockCount = blocks.length > 0
      ? await this.writeBlocks({ companyId, workspaceConfig, documentId, blocks })
      : 0;

    this.log.info('lark.docs.create.success', {
      companyId,
      title,
      documentId,
      blockCount,
      hasUrl: Boolean(url),
    });

    return {
      title,
      documentId,
      url,
      blockCount,
    };
  }

  private async createBlankDocument(input: {
    companyId: string;
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    title: string;
    folderToken?: string;
  }): Promise<{ documentId: string; url: string }> {
    const body: Record<string, unknown> = { title: input.title };
    if (input.folderToken) {
      body.folder_token = input.folderToken;
    }

    const payload = await this.requestJson<Record<string, unknown>>({
      companyId: input.companyId,
      workspaceConfig: input.workspaceConfig,
      method: 'POST',
      path: '/open-apis/docx/v1/documents',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

    const data = asRecord(payload.data);
    const document = asRecord(data?.document);
    const documentId =
      asString(document?.document_id)
      ?? asString(data?.document_id)
      ?? asString(document?.documentId);

    if (!documentId) {
      throw new LarkDocsIntegrationError(
        'Lark create document response missing document_id',
        'lark_docs_invalid_response',
      );
    }

    const url =
      asString(document?.url)
      ?? asString(data?.url)
      ?? `https://docs.larksuite.com/docx/${documentId}`;

    return { documentId, url };
  }

  private async writeBlocks(input: {
    companyId: string;
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    documentId: string;
    blocks: LarkBlock[];
  }): Promise<number> {
    const chunkSize = 50;
    let written = 0;

    for (let i = 0; i < input.blocks.length; i += chunkSize) {
      const chunk = input.blocks.slice(i, i + chunkSize);
      try {
        await this.requestJson({
          companyId: input.companyId,
          workspaceConfig: input.workspaceConfig,
          method: 'POST',
          path: `/open-apis/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.documentId)}/children?document_revision_id=-1`,
          body: JSON.stringify({
            children: chunk,
            index: written,
          }),
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        throw new LarkDocsIntegrationError(
          error instanceof Error ? error.message : 'Lark docs block append failed',
          'lark_docs_blocks_failed',
        );
      }
      written += chunk.length;
    }

    return written;
  }
  private buildTokenService(workspaceConfig: DecryptedLarkWorkspaceConfig | null) {
    return new LarkTenantTokenService({
      apiBaseUrl: workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL,
      appId: workspaceConfig?.appId ?? config.LARK_APP_ID,
      appSecret: workspaceConfig?.appSecret ?? config.LARK_APP_SECRET,
      staticToken: workspaceConfig?.staticTenantAccessToken ?? config.LARK_BOT_TENANT_ACCESS_TOKEN,
      fetchImpl: this.fetchImpl,
      log: this.log,
    });
  }

  private resolveCredentialMeta(workspaceConfig: DecryptedLarkWorkspaceConfig | null) {
    return {
      appId: workspaceConfig?.appId ?? config.LARK_APP_ID,
      tokenSource: workspaceConfig?.appId ? 'workspace_config' : 'env_fallback',
      apiBaseUrl: workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL,
    } as const;
  }

  private async requestJson<T = Record<string, unknown>>(input: RequestOptions): Promise<T> {
    const credentialMeta = this.resolveCredentialMeta(input.workspaceConfig);
    const tokenService = this.buildTokenService(input.workspaceConfig);
    const accessToken = await tokenService.getAccessToken();
    const url = new URL(`${credentialMeta.apiBaseUrl}${input.path}`);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(input.headers ?? {}),
        },
        body: input.body,
      });
    } catch (error) {
      throw new LarkDocsIntegrationError(
        `Lark docs request failed: ${error instanceof Error ? error.message : 'unknown_network_error'}`,
        'lark_docs_unavailable',
      );
    }

    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    const record = asRecord(payload) ?? {};
    const code = asNumber(record.code);

    if (!response.ok || (code !== undefined && code !== 0)) {
      this.log.error('lark.docs.request.failed', {
        companyId: input.companyId,
        appId: credentialMeta.appId,
        tokenSource: credentialMeta.tokenSource,
        method: input.method,
        path: input.path,
        statusCode: response.status,
        code,
        msg: readLarkErrorMessage(record),
      });
      throw new LarkDocsIntegrationError(
        `Lark docs request failed (${response.status}): ${readLarkErrorMessage(record)}`,
        'lark_docs_unavailable',
      );
    }

    this.log.info('lark.docs.request.success', {
      companyId: input.companyId,
      appId: credentialMeta.appId,
      tokenSource: credentialMeta.tokenSource,
      method: input.method,
      path: input.path,
      statusCode: response.status,
    });

    return record as T;
  }
}

export const larkDocsService = new LarkDocsService();
