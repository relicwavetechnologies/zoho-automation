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
  localTimeZoneHint?: string;
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

const isVaguePreferenceText = (value: string): boolean => {
  const normalized = stripTrailingPunctuation(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return true;
  }
  return /^(this|that|it|same)\b/.test(normalized)
    || /\b(this|that|same)\s+(timing|time|one)\b/.test(normalized)
    || /\btiming only\b/.test(normalized)
    || /\bthis only\b/.test(normalized);
};

const isTrivialObjectiveText = (value: string): boolean => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^(@[^\s]+\s*)+/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return true;
  }
  if (normalized.length < 8) {
    return true;
  }
  return /^(ok|okay|sure|yes|no|done|continue|proceed|go on|try again|retry|thanks|thank you|cool|great|nice|thik h|thik hai|theek h|theek hai)$/i.test(normalized);
};

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

const SUPPORTED_TIME_ZONES = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : [];

const TIME_ZONE_BY_LOWER = new Map(SUPPORTED_TIME_ZONES.map((value) => [value.toLowerCase(), value]));

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeUtcOffset = (value: string): string => {
  const cleaned = value.replace(/\s+/g, '');
  const sign = cleaned.startsWith('-') ? '-' : '+';
  const unsigned = cleaned.replace(/^[-+]/, '');
  if (unsigned.includes(':')) {
    const [hours, minutes = '00'] = unsigned.split(':');
    return `UTC${sign}${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
  }
  if (unsigned.length > 2) {
    const hours = unsigned.slice(0, -2);
    const minutes = unsigned.slice(-2);
    return `UTC${sign}${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
  }
  return `UTC${sign}${unsigned.padStart(2, '0')}:00`;
};

const resolveCanonicalTimeZone = (candidate: string): string | null => {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  const byList = TIME_ZONE_BY_LOWER.get(trimmed.toLowerCase());
  if (byList) {
    return byList;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
};

type TimezonePreference = {
  subjectKey: string;
  summary: string;
  valueJson: Record<string, unknown>;
  confidence: number;
};

const hasTimezonePreferenceIntent = (text: string): boolean =>
  /\b(?:prefer|remember|normalize|adjust|use|schedule|timing|timezone|time|convert|show)\b/i.test(text);

const resolveTimezonePreference = (text: string, localTimeZoneHint?: string): TimezonePreference | null => {
  if (!hasTimezonePreferenceIntent(text)) {
    return null;
  }

  const ianaMatch = text.match(/\b([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/);
  if (ianaMatch?.[1]) {
    const canonical = resolveCanonicalTimeZone(ianaMatch[1]);
    if (canonical) {
      return {
        subjectKey: `timezone_preference_${normalizeMemorySubjectKey(canonical)}`,
        summary: `User prefers scheduling and time references in ${canonical}.`,
        valueJson: {
          type: 'timezone',
          timezone: canonical,
          rawMention: ianaMatch[1],
          appliesTo: ['calendar', 'scheduling', 'time_parsing', 'time_display'],
        },
        confidence: 0.97,
      };
    }
  }

  const cityMatches = SUPPORTED_TIME_ZONES
    .map((zone) => {
      const parts = zone.split('/');
      const city = parts[parts.length - 1]?.replace(/_/g, ' ');
      return city ? { zone, city } : null;
    })
    .filter((value): value is { zone: string; city: string } => Boolean(value))
    .filter(({ city }) => new RegExp(`\\b${escapeRegex(city)}\\b`, 'i').test(text));
  if (cityMatches.length === 1) {
    const match = cityMatches[0];
    return {
      subjectKey: `timezone_preference_${normalizeMemorySubjectKey(match.zone)}`,
      summary: `User prefers scheduling and time references in ${match.zone}.`,
      valueJson: {
        type: 'timezone',
        timezone: match.zone,
        rawMention: match.city,
        appliesTo: ['calendar', 'scheduling', 'time_parsing', 'time_display'],
      },
      confidence: 0.93,
    };
  }

  const utcOffsetMatch = text.match(/\b(?:utc|gmt)\s*([+-]\s*\d{1,2}(?::?\d{2})?)\b/i);
  if (utcOffsetMatch?.[1]) {
    const normalizedOffset = normalizeUtcOffset(utcOffsetMatch[1]);
    return {
      subjectKey: `timezone_preference_${normalizeMemorySubjectKey(normalizedOffset)}`,
      summary: `User prefers scheduling and time references in ${normalizedOffset}.`,
      valueJson: {
        type: 'utc_offset',
        utcOffset: normalizedOffset,
        rawMention: stripTrailingPunctuation(utcOffsetMatch[0]),
        appliesTo: ['calendar', 'scheduling', 'time_parsing', 'time_display'],
      },
      confidence: 0.94,
    };
  }

  const abbreviationMatch = text.match(/\b([A-Z]{2,5})\b/);
  if (abbreviationMatch?.[1] && /\b(?:timezone|time|timing|schedule|utc)\b/i.test(text)) {
    const label = abbreviationMatch[1];
    return {
      subjectKey: `timezone_preference_${normalizeMemorySubjectKey(label)}`,
      summary: `User prefers scheduling and time references in timezone "${label}".`,
      valueJson: {
        type: 'timezone_label',
        timezoneLabel: label,
        rawMention: label,
        resolution: 'unresolved_label',
        appliesTo: ['calendar', 'scheduling', 'time_parsing', 'time_display'],
      },
      confidence: 0.72,
    };
  }

  if (/\b(?:local timezone|local time)\b/i.test(text)) {
    const canonicalLocal = localTimeZoneHint ? resolveCanonicalTimeZone(localTimeZoneHint) : null;
    if (canonicalLocal) {
      return {
        subjectKey: `timezone_preference_${normalizeMemorySubjectKey(canonicalLocal)}`,
        summary: `User prefers scheduling and time references in ${canonicalLocal}.`,
        valueJson: {
          type: 'timezone',
          timezone: canonicalLocal,
          rawMention: 'local timezone',
          appliesTo: ['calendar', 'scheduling', 'time_parsing', 'time_display'],
        },
        confidence: 0.9,
      };
    }
    return {
      subjectKey: 'timezone_preference_local',
      summary: 'User prefers scheduling and time references in their local timezone.',
      valueJson: {
        type: 'local_timezone',
        appliesTo: ['calendar', 'scheduling', 'time_parsing', 'time_display'],
      },
      confidence: 0.88,
    };
  }

  return null;
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

    const timezonePreference = resolveTimezonePreference(text, input.localTimeZoneHint);
    if (timezonePreference) {
      drafts.push(buildBaseDraft(input, {
        kind: 'preference',
        scope: 'user_global',
        subjectKey: timezonePreference.subjectKey,
        summary: timezonePreference.summary,
        valueJson: timezonePreference.valueJson,
        confidence: timezonePreference.confidence,
        source: 'user_explicit',
        lastConfirmedAt: now,
      }));
    }

    const preferMatch = text.match(/\b(?:i prefer|i like)\s+(.{3,120})/i);
    if (preferMatch?.[1]) {
      const value = summarizeMemoryText(stripTrailingPunctuation(preferMatch[1]));
      if (!isVaguePreferenceText(value)) {
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
      if (isTrivialObjectiveText(value)) {
        continue;
      }
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
      if (!isTrivialObjectiveText(objective)) {
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
