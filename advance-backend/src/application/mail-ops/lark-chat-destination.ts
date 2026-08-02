import type { Result } from '../../shared/result';
import type { InfraError } from '../../shared/errors';

/**
 * Whether a Lark chat may receive a company's mail.
 *
 * `unknown_chat` and `other_company` are deliberately separate. The first is
 * ordinary — Divo has simply never been in that room — and the member can fix
 * it. The second means one Lark installation serves more than one Divo company
 * and the named room belongs to a different one; that is the cross-tenant leak
 * this guard exists for, and it is never the member's mistake to fix.
 */
export type LarkChatDestinationVerdict =
  | { readonly status: 'allowed' }
  | { readonly status: 'unknown_chat' }
  | { readonly status: 'other_company' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface LarkChatDirectoryPort {
  get(input: {
    companyId: string;
    chatId: string;
  }): Promise<Result<{ chatId: string } | null, InfraError>>;
  listCompanyIdsForChat(
    chatId: string,
  ): Promise<Result<readonly string[], InfraError>>;
}

export interface AuthorizeLarkChatDestination {
  (input: {
    readonly companyId: string;
    readonly chatId: string;
  }): Promise<LarkChatDestinationVerdict>;
}

/**
 * Ground a `chatId` in something Divo actually knows.
 *
 * A mail rule used to accept any chat ID string at all, and the "use governed
 * Lark chat discovery" rule existed only as prompt text — so anything the bot
 * could post to was reachable, including, where one Lark install serves two
 * Divo companies, the other company's rooms.
 *
 * The evidence used here is the room record Divo writes when it observes a
 * group chat. A room this company has never been in is refused rather than
 * guessed at: mail is being forwarded out of somebody's mailbox, and failing
 * closed costs a member one setup step.
 */
export function createLarkChatDestinationAuthorizer(
  directory: LarkChatDirectoryPort,
): AuthorizeLarkChatDestination {
  return async ({ companyId, chatId }) => {
    const own = await directory.get({ companyId, chatId });
    if (!own.ok) {
      return { status: 'unavailable', reason: own.error.message };
    }
    if (own.value) return { status: 'allowed' };

    const owners = await directory.listCompanyIdsForChat(chatId);
    if (!owners.ok) {
      return { status: 'unavailable', reason: owners.error.message };
    }
    return owners.value.length > 0
      ? { status: 'other_company' }
      : { status: 'unknown_chat' };
  };
}

/**
 * The delivery-time backstop.
 *
 * Creation is where a chat is really vetted; this only refuses a chat that is
 * positively known to belong to another company. It cannot require a room
 * record, because the commonest destination of all — the member's own DM with
 * Divo — never has one.
 */
export function larkChatDeliveryAllowed(
  verdict: LarkChatDestinationVerdict,
): boolean {
  return verdict.status !== 'other_company';
}
