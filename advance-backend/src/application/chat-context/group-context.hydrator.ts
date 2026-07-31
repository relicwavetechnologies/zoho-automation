import { randomBytes } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import type { Result } from '../../shared/result';
import type { InfraError } from '../../shared/errors';
import type { GroupChatWindow } from '../../domain/conversation/group-context';
import { GROUP_CONTEXT_POLICY } from '../../domain/conversation/group-context-policy';
import {
  GROUP_CONTEXT_TRUST_POLICY,
  formatAdjacentContext,
  formatGroupContextForPrompt,
  formatGroupContextReference,
  type TranscriptFence,
} from './group-context-formatter';

/**
 * Turns the shared room transcript into the block an isolated Pi run reads.
 *
 * Each Divo user runs in their own container with their own workspace, so a
 * group thread has no single agent that remembers it: whoever speaks next is a
 * different process that never saw the earlier turns. The conversation itself
 * therefore cannot live in any container — it lives in the room record every
 * group message is already written to, and is handed to whichever container is
 * answering, for that run only.
 *
 * What crosses the boundary is exactly what the room can already see: messages
 * and Divo's delivered replies. Workspace files, tool results, approvals, and
 * permissions stay private to their container.
 *
 * Deliberately uncached. The room is written before the run starts — the
 * incoming message is appended by the webhook — so every turn reads a state no
 * earlier turn could have rendered, and a cache keyed on that state would never
 * be read. One indexed row read per group turn is the whole cost.
 */

const TRUNCATION_NOTICE =
  '(Earlier lines of this group reference were dropped to fit the request size limit.)';

/**
 * Said out loud rather than left as silence.
 *
 * A group run whose room read failed answers with no history at all, and would
 * otherwise sound exactly like one that had it — so a request that depends on
 * what was agreed earlier gets a confident answer about nothing.
 */
const UNAVAILABLE_NOTICE = [
  '',
  'The shared history of this room could not be read for this turn.',
  'Do not assume continuity with earlier messages. If the request depends on them,'
  + ' say the room history was unavailable and ask for what you need.',
].join('\n');

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

export interface GroupContextHydratorDeps {
  readonly chatContext: {
    loadContext(companyId: string, chatId: string): Promise<Result<GroupChatWindow, InfraError>>;
  };
  readonly logger: Logger;
}

export interface HydrateGroupContextInput {
  readonly companyId: string;
  readonly chatId: string;
  /**
   * Messages fetched from Lark for this turn, outside the stored record. They
   * are framed and fenced with the room transcript rather than appended after
   * it: sent on their own they would be the one part of the prompt a participant
   * could shape with nothing governing it.
   */
  readonly adjacentContext?: string;
  /**
   * The message being answered. It is already in the room record — the incoming
   * snapshot is stored before the run starts — and it is about to be sent as the
   * ask, so leaving it in the reference block would state the request twice.
   */
  readonly currentMessageId?: string;
}

/**
 * The last whole characters of `text` that fit in `maxBytes`.
 *
 * Measured in bytes because that is what the controller limits, and cut on a
 * character boundary because slicing a UTF-8 buffer anywhere else produces a
 * replacement character. Budgeting a quarter of the limit in characters instead
 * would be safe but would throw away most of the allowance for any language
 * whose characters cost more than one byte.
 */
export function tailWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/**
 * The last whole *lines* of `text` that fit in `maxBytes`.
 *
 * Cutting mid-line would leave the first surviving line without its fence
 * marker, and the frame declares an unmarked line as not having come from the
 * room — so a participant could aim the cut at their own forged line and have it
 * read as trusted. Dropping whole lines keeps every line's marker intact, and if
 * not even the newest line fits, none of the body is sent: framing without
 * transcript beats transcript the frame cannot vouch for.
 */
export function tailLinesWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (bytes(text) <= maxBytes) return text;
  const lines = text.split('\n');
  // The body opens with the newline that separated it from the frame; keeping it
  // means a trimmed block still reads as a block rather than a run-on line.
  for (let start = 1; start < lines.length; start += 1) {
    const candidate = `\n${lines.slice(start).join('\n')}`;
    if (bytes(candidate) <= maxBytes) return candidate;
  }
  return '';
}

/**
 * A reference block assembled so that trimming it can only cost transcript.
 *
 * The oldest lines are expendable; the framing is not. The label marking this
 * text as untrusted, the rule that a file named here is not a file this run
 * holds, the fence that says which lines are really from the room, and the trust
 * policy all have to survive — a block that loses them is worse than no block,
 * because the run then treats colleagues' words as instructions, answers about
 * files it never opened, and believes a forged sender.
 */
export interface GroupContextBlock {
  /** Label, instructions and fence rules. Always sent whole. */
  readonly frame: string;
  /** Summary and transcript: the part there is more of than fits. */
  readonly body: string;
  /** Trust policy. Always sent whole. */
  readonly policy: string;
}

export function renderContextBlock(
  block: GroupContextBlock,
  maxBytes: number = GROUP_CONTEXT_POLICY.PI_CONTEXT_MAX_BYTES,
): string {
  const whole = `${block.frame}${block.body}${block.policy}`;
  if (bytes(whole) <= maxBytes) return whole;

  const notice = `\n${TRUNCATION_NOTICE}\n`;
  const room = maxBytes - bytes(block.frame) - bytes(block.policy) - bytes(notice);
  // The framing is short, fixed text, so this cannot happen at the configured
  // budget. If a future edit made it so, send the rules without a transcript
  // rather than a transcript without its rules — even though that returns more
  // than `maxBytes`, which is the lesser failure.
  if (room <= 0) return `${block.frame}${notice}${block.policy}`;

  return `${block.frame}${notice}${tailLinesWithinBytes(block.body, room)}${block.policy}`;
}

function withoutMessage(window: GroupChatWindow, messageId: string | undefined): GroupChatWindow {
  if (!messageId) return window;
  const recentMessages = window.recentMessages.filter(message => message.id !== messageId);
  if (recentMessages.length === window.recentMessages.length) return window;
  return { ...window, recentMessages };
}

/** Short enough to stay cheap, long enough that a participant cannot guess it. */
const newFence = (): TranscriptFence => ({ token: `«${randomBytes(4).toString('hex')}»` });

export class GroupContextHydrator {
  private readonly log: Logger;

  constructor(private readonly deps: GroupContextHydratorDeps) {
    this.log = deps.logger.child({ service: 'group-context-hydrator' });
  }

  /**
   * The shared reference block for this room, or `null` when there is nothing to
   * say. Never throws: a turn that loses its group context is worse than one
   * with it, but far better than a turn that fails.
   */
  async hydrate(input: HydrateGroupContextInput): Promise<GroupContextBlock | null> {
    const fence = newFence();
    const adjacent = input.adjacentContext?.trim()
      ? formatAdjacentContext(input.adjacentContext, fence)
      : '';

    let body: string;
    try {
      const loaded = await this.deps.chatContext.loadContext(input.companyId, input.chatId);
      if (loaded.ok) {
        const window = withoutMessage(loaded.value, input.currentMessageId);
        const rendered = window.recentMessages.length > 0 || window.summary
          ? formatGroupContextForPrompt(window, {
            transcriptTokens: GROUP_CONTEXT_POLICY.PI_TRANSCRIPT_TOKEN_BUDGET,
            summaryTokens: GROUP_CONTEXT_POLICY.PI_SUMMARY_TOKEN_BUDGET,
            fence,
          })
          : '';
        // The framing is whatever the formatter emits for an empty window: the
        // label, the instructions and the fence rules. Everything the room
        // contributed follows it.
        const frame = this.frameFor(fence);
        const whole = rendered ? formatGroupContextReference(rendered) : '';
        body = whole.startsWith(frame) ? whole.slice(frame.length) : (rendered ? `\n${rendered}` : '');
      } else {
        this.log.warn('group_context.load_failed', {
          chatId: input.chatId,
          error: loaded.error.message,
        });
        body = UNAVAILABLE_NOTICE;
      }
    } catch (error) {
      this.log.warn('group_context.hydrate_failed', {
        chatId: input.chatId,
        error: String(error),
      });
      body = UNAVAILABLE_NOTICE;
    }

    if (adjacent) body = `${body}\n\n${adjacent}`;
    if (!body.trim()) return null;

    const block: GroupContextBlock = {
      frame: this.frameFor(fence),
      body,
      // In the in-process engine this policy sat in the system prompt, but an
      // isolated run receives one message, so it travels with the text it
      // governs — and is re-emitted whenever the block has to be trimmed.
      policy: `\n\n${GROUP_CONTEXT_TRUST_POLICY}`,
    };
    // Truncation here is invisible from the runtime's side: it measures what it
    // was handed, which is already capped. Logged so the common case of losing
    // the oldest room lines is visible too, not only the rarer body-size trim.
    const full = bytes(block.frame) + bytes(block.body) + bytes(block.policy);
    if (full > GROUP_CONTEXT_POLICY.PI_CONTEXT_MAX_BYTES) {
      this.log.info('group_context.truncated', {
        chatId: input.chatId,
        renderedBytes: full,
        capBytes: GROUP_CONTEXT_POLICY.PI_CONTEXT_MAX_BYTES,
      });
    }
    this.log.debug('group_context.hydrated', {
      chatId: input.chatId,
      bytes: bytes(renderContextBlock(block)),
      hasAdjacent: Boolean(adjacent),
    });
    return block;
  }

  private frameFor(fence: TranscriptFence): string {
    return formatGroupContextReference(formatGroupContextForPrompt(
      { summary: null, recentMessages: [], totalMessageCount: 0 },
      { fence },
    ));
  }
}
