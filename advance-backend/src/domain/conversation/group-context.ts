export type GroupChatAttachmentKind = 'image' | 'file';

export type GroupChatAttachmentStatus =
  /** Streamed into the sender's container workspace; the agent reads it from there. */
  | 'workspace'
  /** Deliberately not read. Divo does not accept this kind of attachment yet. */
  | 'unsupported';

export interface GroupChatAttachmentContext {
  readonly kind: GroupChatAttachmentKind;
  readonly fileName: string;
  readonly mimeType: string;
  readonly larkFileKey?: string;
  readonly larkMessageId?: string;
  readonly ingestionStatus?: GroupChatAttachmentStatus;
  /**
   * Why Divo could not take the file. Set only for `unsupported` attachments,
   * so it can say so in its own voice instead of answering from the filename.
   */
  readonly inlineContext?: string;
  readonly isInlineComplete?: boolean;
  readonly error?: string;
}

export interface GroupChatMessage {
  readonly id: string;
  readonly senderOpenId: string;
  readonly senderName: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
  readonly botMentioned: boolean;
  readonly attachments?: readonly GroupChatAttachmentContext[];
  /** Legacy lightweight filename list retained for old snapshots and summaries. */
  readonly attachedFiles?: readonly string[];
}

export interface GroupChatSummary {
  readonly summary?: string;
  readonly latestObjective?: string;
  readonly latestDirection?: string;
  readonly activeEntities: readonly string[];
  readonly decisions?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly owners?: readonly string[];
  readonly deadlines?: readonly string[];
  readonly mentionedResources?: readonly string[];
  readonly completedActions: readonly string[];
  readonly constraints: readonly string[];
  readonly blockers?: readonly string[];
  readonly superseded?: readonly string[];
  readonly userGoals: readonly string[];
  readonly sourceMessageCount: number;
  readonly updatedAt: string;
}

export interface GroupChatWindow {
  readonly summary: GroupChatSummary | null;
  readonly recentMessages: readonly GroupChatMessage[];
  readonly totalMessageCount: number;
}
