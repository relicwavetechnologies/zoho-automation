/**
 * The conversation's file index.
 *
 * A member sends a PDF and then asks for something to be done with it. The model
 * only ever sees the filename — the provider key stays here, on the backend,
 * because a guessable identifier in model-controlled arguments is how someone
 * else's document ends up on a financial record.
 *
 * Recording is best-effort: losing an index row costs an attachment the member
 * can re-send, which is not worth failing their message over. Resolution is the
 * opposite — it fails loudly, because the alternative is attaching the wrong file
 * and reporting success.
 */

import type { Logger } from '../../shared/logger';

export const CONVERSATION_ATTACHMENT_TTL_MS = 24 * 60 * 60_000;

export interface ConversationAttachmentRecord {
  readonly companyId:       string;
  readonly userId:          string;
  readonly channel:         string;
  readonly conversationKey: string;
  readonly chatId:          string;
  readonly larkMessageId:   string;
  readonly larkFileKey:     string;
  readonly fileName:        string;
  readonly mimeType:        string;
  readonly sizeBytes?:      number;
}

export interface ConversationAttachmentRow extends ConversationAttachmentRecord {
  readonly receivedAt: Date;
}

export interface ConversationAttachmentStore {
  record(entries: readonly ConversationAttachmentRecord[], expiresAt: Date): Promise<void>;
  listLive(input: {
    companyId:       string;
    userId:          string;
    channel:         string;
    conversationKey: string;
    now:             Date;
  }): Promise<readonly ConversationAttachmentRow[]>;
}

/** Filenames arrive from chat clients with stray case and spacing; identity does not depend on either. */
export const normalizeFileName = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

export type AttachmentLookup =
  | { readonly kind: 'found';       readonly row: ConversationAttachmentRow }
  | { readonly kind: 'not_found';   readonly available: readonly string[] }
  | { readonly kind: 'ambiguous';   readonly matches: readonly ConversationAttachmentRow[] };

/**
 * Exact match only, newest first.
 *
 * No fuzzy matching and no nearest-neighbour fallback: the cost of the wrong PDF
 * on a vendor bill is a financial error that reads to everyone as a success.
 */
export function selectAttachment(
  rows: readonly ConversationAttachmentRow[],
  fileName: string,
): AttachmentLookup {
  const wanted = normalizeFileName(fileName);
  const matches = rows
    .filter(row => normalizeFileName(row.fileName) === wanted)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

  if (matches.length === 0) {
    const available = [...new Set(rows.map(row => row.fileName))];
    return { kind: 'not_found', available };
  }

  // The same file re-sent is the same file; two different uploads under one name
  // are not, and picking either silently would be a guess.
  const distinct = new Set(matches.map(row => row.larkFileKey));
  if (distinct.size > 1) return { kind: 'ambiguous', matches };

  return { kind: 'found', row: matches[0]! };
}

export class ConversationAttachmentService {
  constructor(
    private readonly store: ConversationAttachmentStore,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entries: readonly ConversationAttachmentRecord[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.store.record(
        entries,
        new Date(this.now().getTime() + CONVERSATION_ATTACHMENT_TTL_MS),
      );
    } catch (error) {
      this.logger.warn('conversation_attachment.record_failed', {
        count: entries.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async lookup(input: {
    companyId:       string;
    userId:          string;
    channel:         string;
    conversationKey: string;
    fileName:        string;
  }): Promise<AttachmentLookup> {
    const rows = await this.store.listLive({
      companyId:       input.companyId,
      userId:          input.userId,
      channel:         input.channel,
      conversationKey: input.conversationKey,
      now:             this.now(),
    });
    return selectAttachment(rows, input.fileName);
  }
}
