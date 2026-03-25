import {
  addDays,
  type ExtractedMemoryDraft,
  normalizeMemorySubjectKey,
  summarizeMemoryText,
  type UserMemoryChannelOrigin,
  type UserMemoryReplyLength,
  type UserMemoryFormatting,
  type UserMemoryTone,
} from './contracts';

type ExtractionBaseInput = {
  channelOrigin: UserMemoryChannelOrigin;
  threadId?: string;
  conversationKey?: string;
  now?: Date;
};

const buildBaseDraft = (
  input: ExtractionBaseInput,
  draft: Omit<ExtractedMemoryDraft, 'channelOrigin' | 'threadId' | 'conversationKey'>,
): ExtractedMemoryDraft => ({
  ...draft,
  channelOrigin: input.channelOrigin,
  threadId: input.threadId,
  conversationKey: input.conversationKey,
});

const stripTrailingPunctuation = (value: string): string =>
  value.trim().replace(/[.?!,;:]+$/g, '').trim();

const parseReplyLength = (text: string): UserMemoryReplyLength | undefined => {
  if (/\b(?:brief|briefly|concise|short|one[- ]line|few words|minimal)\b/i.test(text)) {
    return 'short';
  }
  if (/\b(?:detailed|detail|long|thorough|deep dive|comprehensive)\b/i.test(text)) {
    return 'detailed';
  }
  if (/\b(?:balanced|medium length|normal length)\b/i.test(text)) {
    return 'balanced';
  }
  return undefined;
};

const parseFormatting = (text: string): UserMemoryFormatting | undefined => {
  if (/\b(?:bullet points|bullets|bullet list|list format)\b/i.test(text)) {
    return 'bullets';
  }
  if (/\b(?:paragraphs|paragraph form)\b/i.test(text)) {
    return 'paragraphs';
  }
  return undefined;
};

const parseTone = (text: string): UserMemoryTone | undefined => {
  if (/\b(?:direct|straightforward|to the point)\b/i.test(text)) {
    return 'direct';
  }
  if (/\b(?:warm|friendly)\b/i.test(text)) {
    return 'warm';
  }
  if (/\b(?:neutral|formal)\b/i.test(text)) {
    return 'neutral';
  }
  return undefined;
};

class MemoryExtractionService {
  extractFromUserMessage(input: ExtractionBaseInput & { text: string }): ExtractedMemoryDraft[] {
    const text = input.text.trim();
    if (!text) {
      return [];
    }

    const drafts: ExtractedMemoryDraft[] = [];
    const now = input.now ?? new Date();

    const nameMatch = text.match(/\bmy name is\s+([A-Za-z][A-Za-z .'-]{1,80})/i);
    if (nameMatch?.[1]) {
      const value = stripTrailingPunctuation(nameMatch[1]);
      drafts.push(buildBaseDraft(input, {
        kind: 'identity',
        scope: 'user_global',
        subjectKey: 'name',
        summary: `User name is ${value}.`,
        valueJson: { field: 'name', value },
        confidence: 0.98,
        source: 'user_explicit',
        lastConfirmedAt: now,
      }));
    }

    const emailMatch = text.match(/\bmy email is\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
    if (emailMatch?.[1]) {
      const value = stripTrailingPunctuation(emailMatch[1].toLowerCase());
      drafts.push(buildBaseDraft(input, {
        kind: 'identity',
        scope: 'user_global',
        subjectKey: 'email',
        summary: `User email is ${value}.`,
        valueJson: { field: 'email', value },
        confidence: 0.99,
        source: 'user_explicit',
        lastConfirmedAt: now,
      }));
    }

    const replyLength = parseReplyLength(text);
    const preferredFormatting = parseFormatting(text);
    const preferredTone = parseTone(text);
    if (
      /\b(?:answer|respond|reply|write)\b/i.test(text)
      && (replyLength || preferredFormatting || preferredTone)
    ) {
      const parts = [
        replyLength ? `reply length ${replyLength}` : null,
        preferredTone ? `tone ${preferredTone}` : null,
        preferredFormatting ? `formatting ${preferredFormatting}` : null,
      ].filter(Boolean);
      drafts.push(buildBaseDraft(input, {
        kind: 'response_style',
        scope: 'user_global',
        subjectKey: 'response_style',
        summary: `User prefers ${parts.join(', ')}.`,
        valueJson: {
          preferredReplyLength: replyLength,
          preferredTone,
          preferredFormatting,
        },
        confidence: 0.96,
        source: 'user_explicit',
        lastConfirmedAt: now,
      }));
    }

    const preferMatch = text.match(/\b(?:i prefer|i like)\s+(.{3,120})/i);
    if (preferMatch?.[1]) {
      const value = summarizeMemoryText(stripTrailingPunctuation(preferMatch[1]));
      drafts.push(buildBaseDraft(input, {
        kind: 'preference',
        scope: 'user_global',
        subjectKey: normalizeMemorySubjectKey(value),
        summary: `User preference: ${value}.`,
        valueJson: { value },
        confidence: 0.84,
        source: 'user_explicit',
        lastConfirmedAt: now,
      }));
    }

    const favoriteMatch = text.match(/\bmy (favorite|favourite)\s+([a-z ]{2,30})\s+is\s+(.{2,80})/i);
    if (favoriteMatch?.[2] && favoriteMatch?.[3]) {
      const category = stripTrailingPunctuation(favoriteMatch[2]);
      const value = summarizeMemoryText(stripTrailingPunctuation(favoriteMatch[3]));
      drafts.push(buildBaseDraft(input, {
        kind: 'preference',
        scope: 'user_global',
        subjectKey: normalizeMemorySubjectKey(`favorite_${category}`),
        summary: `Favorite ${category}: ${value}.`,
        valueJson: { category, value },
        confidence: 0.9,
        source: 'user_explicit',
        lastConfirmedAt: now,
      }));
    }

    const constraintPatterns = [
      /\b(?:use|choose)\s+(.{2,80}),\s+not\s+(.{2,80})/i,
      /\b(?:do not|don't|never)\s+(.{3,120})/i,
      /\balways\s+(.{3,120})/i,
    ];
    for (const pattern of constraintPatterns) {
      const match = text.match(pattern);
      if (!match) {
        continue;
      }
      const value = summarizeMemoryText(stripTrailingPunctuation(match[0]));
      drafts.push(buildBaseDraft(input, {
        kind: 'constraint',
        scope: 'user_global',
        subjectKey: normalizeMemorySubjectKey(value),
        summary: `User constraint: ${value}.`,
        valueJson: { value },
        confidence: 0.9,
        source: 'user_explicit',
        lastConfirmedAt: now,
      }));
      break;
    }

    const ongoingTaskPatterns = [
      /\b(?:we are|i am|i'm|currently)\s+(?:working on|focused on|reconciling|building|preparing|investigating|reviewing|handling)\s+(.{4,120})/i,
      /\b(?:we're|we are)\s+(.{4,120})/i,
    ];
    for (const pattern of ongoingTaskPatterns) {
      const match = text.match(pattern);
      if (!match?.[1]) {
        continue;
      }
      const value = summarizeMemoryText(stripTrailingPunctuation(match[1]));
      drafts.push(buildBaseDraft(input, {
        kind: 'ongoing_task',
        scope: 'thread_pinned',
        subjectKey: normalizeMemorySubjectKey(value),
        summary: `Ongoing task: ${value}.`,
        valueJson: { objective: value },
        confidence: 0.82,
        source: 'user_explicit',
        staleAfterAt: addDays(now, 14),
      }));
      break;
    }

    const projectMatch = text.match(/\bproject\s+["']?([A-Za-z0-9][A-Za-z0-9 _-]{1,80})["']?/i);
    if (projectMatch?.[1]) {
      const value = summarizeMemoryText(stripTrailingPunctuation(projectMatch[1]));
      drafts.push(buildBaseDraft(input, {
        kind: 'project',
        scope: 'thread_pinned',
        subjectKey: normalizeMemorySubjectKey(value),
        summary: `Project: ${value}.`,
        valueJson: { name: value },
        confidence: 0.8,
        source: 'user_explicit',
        staleAfterAt: addDays(now, 21),
      }));
    }

    const decisionMatch = text.match(/\b(?:we decided to|i decided to|decision:)\s+(.{4,120})/i);
    if (decisionMatch?.[1]) {
      const value = summarizeMemoryText(stripTrailingPunctuation(decisionMatch[1]));
      drafts.push(buildBaseDraft(input, {
        kind: 'decision',
        scope: 'thread_pinned',
        subjectKey: normalizeMemorySubjectKey(value),
        summary: `Decision: ${value}.`,
        valueJson: { value },
        confidence: 0.88,
        source: 'user_explicit',
        lastConfirmedAt: now,
        staleAfterAt: addDays(now, 30),
      }));
    }

    return drafts;
  }

  extractFromTaskStateSnapshot(
    input: ExtractionBaseInput & {
      activeObjective?: string | null;
      completedMutations?: Array<{ module?: string; summary: string; ok: boolean }>;
    },
  ): ExtractedMemoryDraft[] {
    const drafts: ExtractedMemoryDraft[] = [];
    const now = input.now ?? new Date();

    if (input.activeObjective?.trim()) {
      const objective = summarizeMemoryText(input.activeObjective);
      drafts.push(buildBaseDraft(input, {
        kind: 'ongoing_task',
        scope: 'thread_pinned',
        subjectKey: normalizeMemorySubjectKey(objective),
        summary: `Ongoing task: ${objective}.`,
        valueJson: { objective },
        confidence: 0.76,
        source: 'assistant_compacted',
        staleAfterAt: addDays(now, 14),
      }));
    }

    for (const mutation of input.completedMutations ?? []) {
      if (!mutation.ok || !mutation.summary.trim()) {
        continue;
      }
      const summary = summarizeMemoryText(mutation.summary);
      drafts.push(buildBaseDraft(input, {
        kind: 'decision',
        scope: 'thread_pinned',
        subjectKey: normalizeMemorySubjectKey(`${mutation.module ?? 'general'}_${summary}`),
        summary: `Completed action: ${summary}.`,
        valueJson: {
          module: mutation.module,
          summary,
        },
        confidence: 0.72,
        source: 'assistant_compacted',
        lastConfirmedAt: now,
        staleAfterAt: addDays(now, 30),
      }));
    }

    return drafts;
  }
}

export const memoryExtractionService = new MemoryExtractionService();
