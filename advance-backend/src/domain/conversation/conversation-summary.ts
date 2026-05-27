/** Structured summary of older conversation turns, stored in RuntimeConversation.summaryJson. */
export interface ConversationSummary {
  readonly facts: readonly string[];
  readonly decisions: readonly string[];
  readonly entities: readonly string[];
  readonly activeWork: readonly string[];
  readonly toolsUsed: readonly string[];
  readonly summarizedTurnCount: number;
  readonly lastSummarizedSequence: number;
  readonly updatedAt: string;
}
