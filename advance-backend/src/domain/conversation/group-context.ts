export interface GroupChatMessage {
  readonly id: string;
  readonly senderOpenId: string;
  readonly senderName: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
  readonly botMentioned: boolean;
  readonly attachedFiles?: readonly string[];
}

export interface GroupChatSummary {
  readonly summary?: string;
  readonly latestObjective?: string;
  readonly activeEntities: readonly string[];
  readonly completedActions: readonly string[];
  readonly constraints: readonly string[];
  readonly userGoals: readonly string[];
  readonly sourceMessageCount: number;
  readonly updatedAt: string;
}

export interface GroupChatWindow {
  readonly summary: GroupChatSummary | null;
  readonly recentMessages: readonly GroupChatMessage[];
  readonly totalMessageCount: number;
}
