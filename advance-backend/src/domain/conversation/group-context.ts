export type GroupChatAttachmentKind = 'image' | 'file';

export type GroupChatAttachmentStatus =
  | 'pending'
  | 'processing'
  | 'indexed'
  | 'failed'
  /** Read for this turn only; nothing was stored and nothing can be retrieved later. */
  | 'inline_only'
  /** Deliberately not read. Divo does not accept this kind of attachment yet. */
  | 'unsupported';

export interface GroupChatAttachmentContext {
  readonly kind: GroupChatAttachmentKind;
  readonly fileName: string;
  readonly mimeType: string;
  readonly larkFileKey?: string;
  readonly larkMessageId?: string;
  readonly fileAssetId?: string;
  readonly cloudinaryUrl?: string;
  /**
   * Inline image bytes for the current turn only. Stripped before the message
   * is persisted — see `withoutTransientBytes` — so this is never present on a
   * context read back out of the group snapshot.
   */
  readonly base64DataUrl?: string;
  readonly ingestionStatus?: GroupChatAttachmentStatus;
  /**
   * Internal prompt-only OCR / extracted file context. This is persisted in the
   * group context snapshot and must not be posted back into Lark.
   */
  readonly inlineContext?: string;
  readonly isInlineComplete?: boolean;
  readonly rawTextPreview?: string;
  readonly retrievalHint?: string;
  readonly indexedChunkCount?: number;
  readonly documentClass?: string;
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

// ─── Multimodal content parts (AI-SDK-agnostic) ─────────────────────────────

export interface GroupContextTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface GroupContextImagePart {
  readonly type: 'image';
  readonly url: string;
}

export type GroupContextContentPart = GroupContextTextPart | GroupContextImagePart;

export interface GroupContextForLLM {
  readonly systemHeader: string;
  readonly parts: readonly GroupContextContentPart[];
  readonly hasImages: boolean;
}
