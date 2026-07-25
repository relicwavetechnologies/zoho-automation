/**
 * The key a turn's working context is stored under.
 *
 * A group chat is not one conversation. Colleagues hold several unrelated
 * threads in the same room, and keying working context on the chat alone means
 * every thread reads and writes one shared history: Divo answers a question in
 * one thread using what someone said in another, and each participant's turns
 * accumulate in a transcript the whole room draws on.
 *
 * Room-level ambient context is a separate, bounded thing and stays keyed on
 * the chat — see `LarkChatContextService`. This key is only for the working
 * context of a turn.
 *
 * A top-level group message seeds a thread rooted at itself, because that is
 * what the channel does when Divo replies in-thread: the follow-up arrives
 * carrying this message's ID as its root, and keying on the message ID now is
 * what lets that follow-up find this turn. Keying on the chat instead would
 * make the first turn of every thread invisible to the second.
 *
 * A DM is already private to one person, so it keys on the chat unchanged.
 */

export interface ConversationKeyInput {
  readonly chatId: string;
  readonly chatType?: string;
  readonly messageId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
}

export const conversationKeyForMessage = (input: ConversationKeyInput): string => {
  if (input.chatType !== 'group') return String(input.chatId);

  // Root before thread ID, deliberately. Lark assigns a topic ID only once the
  // thread exists, so the message that seeds a thread has no `thread_id` while
  // every reply in it has one. Preferring `thread_id` would give the seed turn
  // and the first reply different keys — losing the question the reply is
  // answering, in the most common shape a group thread takes. The root is
  // stable from the first message onward, and where Lark supplies only a topic
  // ID the fallback keys that whole topic consistently.
  const threadIdentity = input.rootMessageId ?? input.threadId ?? input.messageId;
  return threadIdentity
    ? `${String(input.chatId)}:thread:${String(threadIdentity)}`
    : String(input.chatId);
};
