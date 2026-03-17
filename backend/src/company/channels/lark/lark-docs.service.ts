import config from '../../../config';
import { logger } from '../../../utils/logger';
import { companyContextResolver } from '../../agents/support/company-context.resolver';
import { larkWorkspaceConfigRepository, type DecryptedLarkWorkspaceConfig } from './lark-workspace-config.repository';
import { LarkTenantTokenService } from './lark-tenant-token.service';
import { larkUserAuthLinkRepository } from './lark-user-auth-link.repository';

type LarkDocsServiceOptions = {
  fetchImpl?: typeof fetch;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
};

type CreateMarkdownDocInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: 'tenant' | 'user_linked';
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

export type EditMarkdownDocInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: 'tenant' | 'user_linked';
  documentId: string;
  instruction: string;
  newMarkdown?: string;
  strategy: 'replace' | 'append' | 'patch' | 'delete';
};

export type LarkEditDocResult = {
  documentId: string;
  url: string;
  blocksAffected: number;
};

type RequestOptions = {
  companyId: string;
  workspaceConfig: DecryptedLarkWorkspaceConfig | null;
  appUserId?: string;
  larkTenantKey?: string;
  authMode?: 'tenant' | 'user_linked';
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

type RemoteDocBlock = {
  blockId: string;
  blockType: number;
  parentBlockId?: string;
  children: string[];
  text: string;
};

type RemoteDocSnapshot = {
  rootBlockId: string;
  childBlocks: RemoteDocBlock[];
};

export type LarkDocReadResult = {
  documentId: string;
  url: string;
  exists: boolean;
  blockCount: number;
  text: string;
  headings: string[];
  blocks: RemoteDocBlock[];
};

type MarkdownSection = {
  heading?: string;
  markdown: string;
};

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
const normalizeLooseText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

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

const blockTypeIsHeading = (blockType: number): boolean => blockType >= 3 && blockType <= 8;
const headingLevelForBlockType = (blockType: number): number | null =>
  blockTypeIsHeading(blockType) ? blockType - 2 : null;

const gatherTextRuns = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => gatherTextRuns(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const directContent = asString(record.content);
  const parts = directContent ? [directContent] : [];
  for (const [key, child] of Object.entries(record)) {
    if (key === 'content') {
      continue;
    }
    parts.push(...gatherTextRuns(child));
  }
  return parts;
};

const extractBlockText = (record: Record<string, unknown>): string => {
  const sections = [
    record.text,
    record.heading1,
    record.heading2,
    record.heading3,
    record.heading4,
    record.heading5,
    record.heading6,
    record.bullet,
    record.ordered,
    record.code,
    record.quote,
  ];
  return gatherTextRuns(sections).join(' ').replace(/\s+/g, ' ').trim();
};

const deriveTargetHint = (instruction: string): string | null => {
  const normalized = instruction.trim();
  const quoted = normalized.match(/["“']([^"”']{2,120})["”']/)?.[1];
  if (quoted) {
    return quoted.trim();
  }

  const common = ['introduction', 'summary', 'findings', 'risks', 'priorities', 'actions', 'action items', 'conclusion', 'sources'];
  const lowered = normalizeLooseText(normalized);
  const commonHit = common.find((term) => lowered.includes(term));
  if (commonHit) {
    return commonHit;
  }

  const match = normalized.match(/\b(?:remove|delete|update|rewrite|replace|edit|fix|change)\s+(?:the\s+)?([a-z0-9 _-]{2,80}?)(?:\s+section|\s+part|\s*$)/i)?.[1];
  return match?.trim() ?? null;
};

const findTargetRange = (blocks: RemoteDocBlock[], instruction: string): { startIndex: number; endIndex: number } | null => {
  const targetHint = deriveTargetHint(instruction);
  if (!targetHint) {
    return null;
  }

  const normalizedTarget = normalizeLooseText(targetHint);
  const startIndex = blocks.findIndex((block) => normalizeLooseText(block.text).includes(normalizedTarget));
  if (startIndex < 0) {
    return null;
  }

  const startBlock = blocks[startIndex];
  const startLevel = headingLevelForBlockType(startBlock.blockType);
  if (startLevel === null) {
    return { startIndex, endIndex: startIndex + 1 };
  }

  let endIndex = blocks.length;
  for (let index = startIndex + 1; index < blocks.length; index += 1) {
    const nextLevel = headingLevelForBlockType(blocks[index].blockType);
    if (nextLevel !== null && nextLevel <= startLevel) {
      endIndex = index;
      break;
    }
  }
  return { startIndex, endIndex };
};

const parseMarkdownSections = (markdown: string): MarkdownSection[] => {
  const normalized = normalizeMarkdown(markdown);
  if (!normalized) {
    return [];
  }

  const lines = normalized.split('\n');
  const sections: MarkdownSection[] = [];
  let current: string[] = [];
  let currentHeading: string | undefined;

  const flush = () => {
    const content = current.join('\n').trim();
    if (!content) {
      return;
    }
    sections.push({
      heading: currentHeading,
      markdown: content,
    });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      flush();
      current = [line];
      currentHeading = headingMatch[1]?.trim();
      continue;
    }
    if (current.length === 0) {
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return sections;
};

const selectRelevantMarkdown = (
  strategy: EditMarkdownDocInput['strategy'],
  instruction: string,
  markdown: string | undefined,
): string | undefined => {
  const normalized = normalizeMarkdown(markdown ?? '');
  if (!normalized || strategy === 'replace') {
    return normalized || undefined;
  }

  const targetHint = deriveTargetHint(instruction);
  if (!targetHint) {
    return normalized;
  }
  const target = normalizeLooseText(targetHint);
  const sections = parseMarkdownSections(normalized);
  if (sections.length <= 1) {
    return normalized;
  }

  const matched = sections.find((section) => {
    const heading = normalizeLooseText(section.heading ?? '');
    return heading.includes(target) || target.includes(heading);
  });
  return matched?.markdown ?? normalized;
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

const isTableLine = (line: string): boolean =>
  /^\|.+\|$/.test(line.trim());

const splitTableRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isTableDividerRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));

const formatMarkdownTableAsBullets = (headers: string[], rows: string[][]): LarkBlock[] =>
  rows.map((row, index) => {
    const content = headers
      .map((header, headerIndex) => {
        const value = row[headerIndex]?.trim();
        if (!value) {
          return null;
        }
        return `**${header}:** ${value}`;
      })
      .filter((value): value is string => Boolean(value))
      .join(' | ');

    return {
      block_type: 12,
      bullet: { elements: parseInlineMarkdown(content || `Row ${index + 1}`) },
    };
  });

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

    if (isTableLine(line)) {
      const headerCells = splitTableRow(line);
      const dividerCells = lines[i + 1] ? splitTableRow(lines[i + 1] ?? '') : [];
      if (isTableDividerRow(dividerCells)) {
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && isTableLine(lines[i] ?? '')) {
          rows.push(splitTableRow(lines[i] ?? ''));
          i += 1;
        }
        blocks.push(...formatMarkdownTableAsBullets(headerCells, rows));
        continue;
      }
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

    const paragraphLines = [line.trim()];
    i += 1;
    while (i < lines.length) {
      const nextLine = lines[i] ?? '';
      if (
        nextLine.trim() === ''
        || nextLine.match(/^```/)
        || nextLine.match(/^(#{1,6})\s+/)
        || nextLine.startsWith('> ')
        || nextLine.match(/^[-*+]\s+/)
        || nextLine.match(/^\d+\.\s+/)
        || /^(-{3,}|\*{3,}|_{3,})$/.test(nextLine.trim())
        || isTableLine(nextLine)
      ) {
        break;
      }
      paragraphLines.push(nextLine.trim());
      i += 1;
    }

    blocks.push({
      block_type: 2,
      text: { elements: parseInlineMarkdown(paragraphLines.join(' ')) },
    });
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
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.credentialMode ?? 'tenant',
      title,
      folderToken: input.folderToken,
    });

    const blocks = markdownToLarkBlocks(markdown);
    const blockCount = blocks.length > 0
      ? await this.writeBlocks({
        companyId,
        workspaceConfig,
        appUserId: input.appUserId,
        larkTenantKey: input.larkTenantKey,
        authMode: input.credentialMode ?? 'tenant',
        documentId,
        blocks,
      })
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

  async editMarkdownDoc(input: EditMarkdownDocInput): Promise<LarkEditDocResult> {
    const companyId = await companyContextResolver.resolveCompanyId({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
    });
    const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(companyId);
    const documentId = input.documentId.trim();
    if (!documentId) {
      throw new LarkDocsIntegrationError('Document ID is required for Lark Doc edits', 'lark_docs_invalid_response');
    }

    const snapshot = await this.getDocumentSnapshot({
      companyId,
      workspaceConfig,
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.credentialMode ?? 'tenant',
      documentId,
    });
    const url = `https://docs.larksuite.com/docx/${documentId}`;
    const relevantMarkdown = selectRelevantMarkdown(input.strategy, input.instruction, input.newMarkdown);

    const normalizedStrategy =
      /\b(add|append|insert)\b/i.test(input.instruction) && input.strategy === 'patch'
        ? 'append'
        : input.strategy;

    if (normalizedStrategy === 'replace') {
      const markdown = normalizeMarkdown(relevantMarkdown ?? '');
      if (!markdown) {
        throw new LarkDocsIntegrationError('Replacement markdown content is empty', 'lark_docs_invalid_response');
      }
      if (snapshot.childBlocks.length > 0) {
        await this.deleteChildRange({
          companyId,
          workspaceConfig,
          appUserId: input.appUserId,
          larkTenantKey: input.larkTenantKey,
          authMode: input.credentialMode ?? 'tenant',
          documentId,
          parentBlockId: snapshot.rootBlockId,
          startIndex: 0,
          endIndex: snapshot.childBlocks.length,
        });
      }
      const blocks = markdownToLarkBlocks(markdown);
      const inserted = blocks.length > 0
        ? await this.insertBlocks({
          companyId,
          workspaceConfig,
          appUserId: input.appUserId,
          larkTenantKey: input.larkTenantKey,
          authMode: input.credentialMode ?? 'tenant',
          documentId,
          parentBlockId: snapshot.rootBlockId,
          blocks,
          index: 0,
        })
        : 0;
      return { documentId, url, blocksAffected: Math.max(snapshot.childBlocks.length, inserted) };
    }

    if (normalizedStrategy === 'append') {
      const markdown = normalizeMarkdown(relevantMarkdown ?? '');
      if (!markdown) {
        throw new LarkDocsIntegrationError('Append markdown content is empty', 'lark_docs_invalid_response');
      }
      const blocks = markdownToLarkBlocks(markdown);
      const inserted = await this.insertBlocks({
        companyId,
        workspaceConfig,
        appUserId: input.appUserId,
        larkTenantKey: input.larkTenantKey,
        authMode: input.credentialMode ?? 'tenant',
        documentId,
        parentBlockId: snapshot.rootBlockId,
        blocks,
        index: snapshot.childBlocks.length,
      });
      return { documentId, url, blocksAffected: inserted };
    }

    const range = findTargetRange(snapshot.childBlocks, input.instruction);
    if (!range) {
      throw new LarkDocsIntegrationError(
        'Could not identify the target section to edit in this Lark Doc',
        'lark_docs_invalid_response',
      );
    }

    if (normalizedStrategy === 'delete') {
      await this.deleteChildRange({
        companyId,
        workspaceConfig,
        appUserId: input.appUserId,
        larkTenantKey: input.larkTenantKey,
        authMode: input.credentialMode ?? 'tenant',
        documentId,
        parentBlockId: snapshot.rootBlockId,
        startIndex: range.startIndex,
        endIndex: range.endIndex,
      });
      return { documentId, url, blocksAffected: range.endIndex - range.startIndex };
    }

    const markdown = normalizeMarkdown(relevantMarkdown ?? '');
    if (!markdown) {
      throw new LarkDocsIntegrationError('Updated markdown content is empty', 'lark_docs_invalid_response');
    }
    const replacementBlocks = markdownToLarkBlocks(markdown);
    await this.deleteChildRange({
      companyId,
      workspaceConfig,
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.credentialMode ?? 'tenant',
      documentId,
      parentBlockId: snapshot.rootBlockId,
      startIndex: range.startIndex,
      endIndex: range.endIndex,
    });
    const inserted = await this.insertBlocks({
      companyId,
      workspaceConfig,
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.credentialMode ?? 'tenant',
      documentId,
      parentBlockId: snapshot.rootBlockId,
      blocks: replacementBlocks,
      index: range.startIndex,
    });
    return { documentId, url, blocksAffected: Math.max(range.endIndex - range.startIndex, inserted) };
  }

  async inspectDocument(input: {
    companyId?: string;
    larkTenantKey?: string;
    appUserId?: string;
    credentialMode?: 'tenant' | 'user_linked';
    documentId: string;
  }): Promise<{ documentId: string; url: string; exists: boolean; blockCount: number }> {
    const companyId = await companyContextResolver.resolveCompanyId({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
    });
    const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(companyId);
    const snapshot = await this.getDocumentSnapshot({
      companyId,
      workspaceConfig,
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.credentialMode ?? 'tenant',
      documentId: input.documentId.trim(),
    });

    return {
      documentId: input.documentId.trim(),
      url: `https://docs.larksuite.com/docx/${input.documentId.trim()}`,
      exists: true,
      blockCount: snapshot.childBlocks.length,
    };
  }

  async readDocument(input: {
    companyId?: string;
    larkTenantKey?: string;
    appUserId?: string;
    credentialMode?: 'tenant' | 'user_linked';
    documentId: string;
  }): Promise<LarkDocReadResult> {
    const companyId = await companyContextResolver.resolveCompanyId({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
    });
    const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(companyId);
    const documentId = input.documentId.trim();
    const snapshot = await this.getDocumentSnapshot({
      companyId,
      workspaceConfig,
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.credentialMode ?? 'tenant',
      documentId,
    });

    const headings = snapshot.childBlocks
      .filter((block) => blockTypeIsHeading(block.blockType))
      .map((block) => block.text.trim())
      .filter((value) => value.length > 0);
    const text = snapshot.childBlocks
      .map((block) => block.text.trim())
      .filter((value) => value.length > 0)
      .join('\n');

    return {
      documentId,
      url: `https://docs.larksuite.com/docx/${documentId}`,
      exists: true,
      blockCount: snapshot.childBlocks.length,
      text,
      headings,
      blocks: snapshot.childBlocks,
    };
  }

  private async createBlankDocument(input: {
    companyId: string;
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    appUserId?: string;
    larkTenantKey?: string;
    authMode?: 'tenant' | 'user_linked';
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
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.authMode,
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
    appUserId?: string;
    larkTenantKey?: string;
    authMode?: 'tenant' | 'user_linked';
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
          appUserId: input.appUserId,
          larkTenantKey: input.larkTenantKey,
          authMode: input.authMode,
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

  private async getDocumentSnapshot(input: {
    companyId: string;
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    appUserId?: string;
    larkTenantKey?: string;
    authMode?: 'tenant' | 'user_linked';
    documentId: string;
  }): Promise<RemoteDocSnapshot> {
    const items: RemoteDocBlock[] = [];
    let pageToken: string | undefined;

    do {
      const suffix = pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : '';
      const payload = await this.requestJson<Record<string, unknown>>({
        companyId: input.companyId,
        workspaceConfig: input.workspaceConfig,
        appUserId: input.appUserId,
        larkTenantKey: input.larkTenantKey,
        authMode: input.authMode,
        method: 'GET',
        path: `/open-apis/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.documentId)}/children${suffix ? `${suffix}&document_revision_id=-1` : '?document_revision_id=-1'}`,
      });
      const data = asRecord(payload.data);
      const pageItems = Array.isArray(data?.items) ? data.items : [];
      for (const rawItem of pageItems) {
        const record = asRecord(rawItem);
        if (!record) continue;
        const blockId = asString(record.block_id);
        const blockType = asNumber(record.block_type);
        if (!blockId || blockType === undefined) continue;
        const children = Array.isArray(record.children)
          ? record.children.map((value) => asString(value)).filter((value): value is string => Boolean(value))
          : [];
        items.push({
          blockId,
          blockType,
          parentBlockId: asString(record.parent_id) ?? asString(record.parent_block_id),
          children,
          text: extractBlockText(record),
        });
      }
      pageToken = asString(data?.page_token);
      const hasMore = Boolean(data?.has_more);
      if (!hasMore) {
        pageToken = undefined;
      }
    } while (pageToken);

    return {
      rootBlockId: input.documentId,
      childBlocks: items,
    };
  }

  private async insertBlocks(input: {
    companyId: string;
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    appUserId?: string;
    larkTenantKey?: string;
    authMode?: 'tenant' | 'user_linked';
    documentId: string;
    parentBlockId: string;
    blocks: LarkBlock[];
    index: number;
  }): Promise<number> {
    if (input.blocks.length === 0) {
      return 0;
    }
    const chunkSize = 50;
    let written = 0;
    for (let offset = 0; offset < input.blocks.length; offset += chunkSize) {
      const chunk = input.blocks.slice(offset, offset + chunkSize);
      await this.requestJson({
        companyId: input.companyId,
        workspaceConfig: input.workspaceConfig,
        appUserId: input.appUserId,
        larkTenantKey: input.larkTenantKey,
        authMode: input.authMode,
        method: 'POST',
        path: `/open-apis/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.parentBlockId)}/children?document_revision_id=-1`,
        body: JSON.stringify({
          children: chunk,
          index: input.index + written,
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      written += chunk.length;
    }
    return written;
  }

  private async deleteChildRange(input: {
    companyId: string;
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    appUserId?: string;
    larkTenantKey?: string;
    authMode?: 'tenant' | 'user_linked';
    documentId: string;
    parentBlockId: string;
    startIndex: number;
    endIndex: number;
  }): Promise<void> {
    if (input.endIndex <= input.startIndex) {
      return;
    }
    await this.requestJson({
      companyId: input.companyId,
      workspaceConfig: input.workspaceConfig,
      appUserId: input.appUserId,
      larkTenantKey: input.larkTenantKey,
      authMode: input.authMode,
      method: 'DELETE',
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.parentBlockId)}/children/batch_delete?document_revision_id=-1`,
      body: JSON.stringify({
        start_index: input.startIndex,
        end_index: input.endIndex,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
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

  private resolveCredentialMeta(input: {
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    authMode?: 'tenant' | 'user_linked';
  }) {
    return {
      appId: input.authMode === 'user_linked'
        ? 'user_linked'
        : input.workspaceConfig?.appId ?? config.LARK_APP_ID,
      tokenSource: input.authMode === 'user_linked'
        ? 'user_linked'
        : input.workspaceConfig?.appId ? 'workspace_config' : 'env_fallback',
      apiBaseUrl: input.workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL,
    } as const;
  }

  private async requestJson<T = Record<string, unknown>>(input: RequestOptions): Promise<T> {
    const credentialMeta = this.resolveCredentialMeta({
      workspaceConfig: input.workspaceConfig,
      authMode: input.authMode,
    });
    const accessToken = input.authMode === 'user_linked'
      ? await this.resolveUserLinkedAccessToken(input)
      : await this.buildTokenService(input.workspaceConfig).getAccessToken();
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

  private async resolveUserLinkedAccessToken(input: RequestOptions): Promise<string> {
    if (!input.appUserId) {
      throw new LarkDocsIntegrationError(
        'Desktop Lark account is not linked to an app user. Sign in with Lark again.',
        'lark_docs_unavailable',
      );
    }

    const link = await larkUserAuthLinkRepository.findActiveByUser(input.appUserId, input.companyId);
    if (!link) {
      throw new LarkDocsIntegrationError(
        'No linked Lark desktop account was found. Sign in with Lark again.',
        'lark_docs_unavailable',
      );
    }

    if (input.larkTenantKey && link.larkTenantKey !== input.larkTenantKey) {
      throw new LarkDocsIntegrationError(
        'Linked Lark account does not belong to the active workspace tenant.',
        'lark_docs_unavailable',
      );
    }

    if (link.accessTokenExpiresAt && link.accessTokenExpiresAt.getTime() <= Date.now()) {
      throw new LarkDocsIntegrationError(
        'Linked Lark desktop session has expired. Sign in with Lark again.',
        'lark_docs_unavailable',
      );
    }

    await larkUserAuthLinkRepository.touchLastUsed(link.id);
    return link.accessToken;
  }
}

export const larkDocsService = new LarkDocsService();
