export const MEMORY_ACTIVE_SOFT_CAP = 160;
export const MEMORY_ARCHIVE_CAP = 1500;
export const MEMORY_STYLE_SLOT_CAP = 1;
export const MEMORY_IDENTITY_SLOT_CAP = 1;
export const MEMORY_TASK_STALE_DAYS = 14;

export const USER_MEMORY_KINDS = [
  'identity',
  'response_style',
  'preference',
  'constraint',
  'ongoing_task',
  'project',
  'decision',
] as const;

export const USER_MEMORY_SCOPES = ['user_global', 'thread_pinned'] as const;
export const USER_MEMORY_STATUSES = ['active', 'archived', 'forgotten', 'superseded'] as const;
export const USER_MEMORY_SOURCES = ['user_explicit', 'assistant_compacted', 'tool_result'] as const;
export const USER_MEMORY_CHANNEL_ORIGINS = ['desktop', 'lark'] as const;
export const USER_MEMORY_REPLY_LENGTHS = ['short', 'balanced', 'detailed'] as const;
export const USER_MEMORY_TONES = ['neutral', 'warm', 'direct'] as const;
export const USER_MEMORY_FORMATTINGS = ['paragraphs', 'bullets'] as const;

export type UserMemoryKind = typeof USER_MEMORY_KINDS[number];
export type UserMemoryScope = typeof USER_MEMORY_SCOPES[number];
export type UserMemoryStatus = typeof USER_MEMORY_STATUSES[number];
export type UserMemorySource = typeof USER_MEMORY_SOURCES[number];
export type UserMemoryChannelOrigin = typeof USER_MEMORY_CHANNEL_ORIGINS[number];
export type UserMemoryReplyLength = typeof USER_MEMORY_REPLY_LENGTHS[number];
export type UserMemoryTone = typeof USER_MEMORY_TONES[number];
export type UserMemoryFormatting = typeof USER_MEMORY_FORMATTINGS[number];

export type DurableMemoryContextClass =
  | 'lightweight_chat'
  | 'normal_work'
  | 'long_running_task'
  | 'document_grounded_followup';

export type UserBehaviorProfile = {
  preferredReplyLength?: UserMemoryReplyLength;
  preferredTone?: UserMemoryTone;
  preferredFormatting?: UserMemoryFormatting;
  updatedFromMemoryItemId?: string | null;
};

export type ExtractedMemoryDraft = {
  kind: UserMemoryKind;
  scope: UserMemoryScope;
  channelOrigin: UserMemoryChannelOrigin;
  subjectKey: string;
  summary: string;
  valueJson: Record<string, unknown>;
  confidence: number;
  source: UserMemorySource;
  threadId?: string;
  conversationKey?: string;
  lastConfirmedAt?: Date;
  staleAfterAt?: Date;
};

export type FlatUserMemoryItem = {
  id: string;
  kind: UserMemoryKind;
  scope: UserMemoryScope;
  subjectKey: string;
  summary: string;
  valueJson: Record<string, unknown>;
  confidence: number;
  status: UserMemoryStatus;
  source: UserMemorySource;
  threadId?: string | null;
  conversationKey?: string | null;
  lastSeenAt: Date;
  lastConfirmedAt?: Date | null;
  staleAfterAt?: Date | null;
  updatedAt: Date;
};

export type ListedUserMemory = FlatUserMemoryItem & {
  kindLabel: string;
};

export type MemoryPromptContext = {
  behaviorProfile: UserBehaviorProfile | null;
  behaviorProfileContext: string | null;
  durableTaskContext: string[];
  durableTaskContextText: string | null;
  relevantMemoryFacts: string[];
  relevantMemoryFactsText: string | null;
};

export const normalizeMemorySubjectKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);

export const summarizeMemoryText = (value: string, maxLength = 220): string => {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return '';
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
};

export const addDays = (value: Date, days: number): Date =>
  new Date(value.getTime() + days * 24 * 60 * 60 * 1000);

export const formatKindLabel = (kind: UserMemoryKind): string => {
  switch (kind) {
    case 'identity':
      return 'Identity';
    case 'response_style':
      return 'Response style';
    case 'preference':
      return 'Preference';
    case 'constraint':
      return 'Constraint';
    case 'ongoing_task':
      return 'Ongoing task';
    case 'project':
      return 'Project';
    case 'decision':
      return 'Decision';
    default:
      return kind;
  }
};

export const buildBehaviorProfileSummary = (profile: UserBehaviorProfile | null): string | null => {
  if (!profile) {
    return null;
  }
  const parts = [
    profile.preferredReplyLength ? `reply length=${profile.preferredReplyLength}` : null,
    profile.preferredTone ? `tone=${profile.preferredTone}` : null,
    profile.preferredFormatting ? `formatting=${profile.preferredFormatting}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
};
