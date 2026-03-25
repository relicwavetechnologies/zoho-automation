import { logger } from '../../../utils/logger';
import { personalVectorMemoryService, type PersonalMemoryMatch } from './personal-vector-memory.service';

export type ResolvedUserPersonalization = {
  profileContextLines: string[];
  responsePreferenceLines: string[];
  evidence: string[];
  preferences: {
    preferredVerbosity?: 'short' | 'detailed';
    preferredTone?: 'direct' | 'friendly' | 'formal';
    preferredFormat?: 'bullets' | 'prose';
    prefersExamples?: boolean;
    avoidClarifyingQuestions?: boolean;
    technicalDepth?: 'high' | 'low';
    prefersIndexedDocsFirst?: boolean;
    prefersOcrFallback?: boolean;
  };
};

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const dedupeMatches = (matches: PersonalMemoryMatch[]): PersonalMemoryMatch[] => {
  const seen = new Set<string>();
  const deduped: PersonalMemoryMatch[] = [];
  for (const match of matches) {
    const key = normalizeWhitespace(match.content).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
};

const buildPersonalizationQuery = (latestUserMessage?: string): string => {
  const base =
    'user preferences response style communication tone verbosity concise detailed direct friendly formal bullets prose paragraphs examples clarification questions technical depth indexed company docs first OCR fallback';
  const latest = latestUserMessage?.trim();
  return latest ? `${base}\nLatest request: ${latest}` : base;
};

const parseBooleanPreference = (
  lowered: string,
  positivePatterns: RegExp[],
  negativePatterns: RegExp[],
): boolean | undefined => {
  if (negativePatterns.some((pattern) => pattern.test(lowered))) return false;
  if (positivePatterns.some((pattern) => pattern.test(lowered))) return true;
  return undefined;
};

const resolvePreferenceSignals = (evidence: string[]): ResolvedUserPersonalization['preferences'] => {
  const resolved: ResolvedUserPersonalization['preferences'] = {};

  for (const raw of evidence) {
    const line = normalizeWhitespace(raw);
    const lowered = line.toLowerCase();

    if (
      /\b(concise|short|brief|minimal|terse)\b/.test(lowered)
      && !resolved.preferredVerbosity
    ) {
      resolved.preferredVerbosity = 'short';
    } else if (
      /\b(detailed|detail|thorough|comprehensive|deep dive|in depth|in-depth|longer)\b/.test(lowered)
      && !resolved.preferredVerbosity
    ) {
      resolved.preferredVerbosity = 'detailed';
    }

    if (
      /\b(direct|straight to the point|to the point|no fluff|minimal fluff)\b/.test(lowered)
      && !resolved.preferredTone
    ) {
      resolved.preferredTone = 'direct';
    } else if (
      /\b(friendly|warm|casual|conversational)\b/.test(lowered)
      && !resolved.preferredTone
    ) {
      resolved.preferredTone = 'friendly';
    } else if (
      /\b(formal|professional)\b/.test(lowered)
      && !resolved.preferredTone
    ) {
      resolved.preferredTone = 'formal';
    }

    if (
      /\b(no bullets|without bullets|avoid bullets|prose|paragraphs?)\b/.test(lowered)
      && !resolved.preferredFormat
    ) {
      resolved.preferredFormat = 'prose';
    } else if (
      /\b(bullets?|bullet points?|list format|lists?)\b/.test(lowered)
      && !resolved.preferredFormat
    ) {
      resolved.preferredFormat = 'bullets';
    }

    const examples = parseBooleanPreference(
      lowered,
      [/\b(with examples|use examples|prefer examples|example[- ]driven)\b/, /\bexamples?\b/],
      [/\b(no examples|without examples|avoid examples)\b/],
    );
    if (examples !== undefined && resolved.prefersExamples === undefined) {
      resolved.prefersExamples = examples;
    }

    const fewerQuestions = parseBooleanPreference(
      lowered,
      [/\b(don'?t ask questions|no questions|ask fewer questions|minimize clarifying questions)\b/],
      [/\b(ask clarifying questions|please clarify when needed)\b/],
    );
    if (fewerQuestions !== undefined && resolved.avoidClarifyingQuestions === undefined) {
      resolved.avoidClarifyingQuestions = fewerQuestions;
    }

    if (
      /\b(highly technical|very technical|deep technical|technical depth)\b/.test(lowered)
      && !resolved.technicalDepth
    ) {
      resolved.technicalDepth = 'high';
    } else if (
      /\b(simple|high level|high-level|non technical|non-technical)\b/.test(lowered)
      && !resolved.technicalDepth
    ) {
      resolved.technicalDepth = 'low';
    }

    if (
      /\b(indexed company docs first|internal document search first|search-documents first|indexed docs first)\b/.test(lowered)
      && resolved.prefersIndexedDocsFirst === undefined
    ) {
      resolved.prefersIndexedDocsFirst = true;
    }

    if (
      /\b(ocr.*fallback|fallback.*ocr|document-ocr-read.*fallback|ocr only as fallback)\b/.test(lowered)
      && resolved.prefersOcrFallback === undefined
    ) {
      resolved.prefersOcrFallback = true;
    }
  }

  return resolved;
};

export const resolveUserPersonalization = (
  matches: PersonalMemoryMatch[],
): ResolvedUserPersonalization => {
  const deduped = dedupeMatches(matches);
  const evidence = deduped.map((match) => normalizeWhitespace(match.content)).filter(Boolean);
  const preferences = resolvePreferenceSignals(evidence);

  const profileContextLines: string[] = [];
  for (const match of deduped) {
    const line = normalizeWhitespace(match.content);
    const lowered = line.toLowerCase();
    if (!line) continue;
    if (match.memoryKind === 'user_profile_fact' || /^user (name|favorite|workplace|likes):/i.test(line)) {
      if (!/\b(user prefers:)\b/i.test(lowered)) {
        profileContextLines.push(line);
      }
    }
    if (profileContextLines.length >= 4) break;
  }

  const responsePreferenceLines: string[] = [];
  if (preferences.preferredVerbosity === 'short') {
    responsePreferenceLines.push('Keep answers concise unless task complexity requires more detail.');
  } else if (preferences.preferredVerbosity === 'detailed') {
    responsePreferenceLines.push('Prefer fuller explanations when the task benefits from them.');
  }
  if (preferences.preferredTone === 'direct') {
    responsePreferenceLines.push('Use a direct, low-fluff tone.');
  } else if (preferences.preferredTone === 'friendly') {
    responsePreferenceLines.push('Keep the tone friendly and conversational without losing clarity.');
  } else if (preferences.preferredTone === 'formal') {
    responsePreferenceLines.push('Use a professional, formal tone.');
  }
  if (preferences.preferredFormat === 'prose') {
    responsePreferenceLines.push('Prefer short prose paragraphs over bullets unless the content is inherently list-shaped.');
  } else if (preferences.preferredFormat === 'bullets') {
    responsePreferenceLines.push('Prefer bullets when they improve scanability.');
  }
  if (preferences.prefersExamples === true) {
    responsePreferenceLines.push('Include examples when they improve understanding.');
  } else if (preferences.prefersExamples === false) {
    responsePreferenceLines.push('Avoid examples unless they are necessary.');
  }
  if (preferences.avoidClarifyingQuestions === true) {
    responsePreferenceLines.push('Avoid unnecessary clarifying questions and make reasonable assumptions when safe.');
  }
  if (preferences.technicalDepth === 'high') {
    responsePreferenceLines.push('Lean technical when explaining implementation details.');
  } else if (preferences.technicalDepth === 'low') {
    responsePreferenceLines.push('Prefer simple, high-level explanations unless deeper detail is requested.');
  }
  if (preferences.prefersIndexedDocsFirst === true) {
    responsePreferenceLines.push('For uploaded/company files, prefer indexed company document retrieval first.');
  }
  if (preferences.prefersOcrFallback === true) {
    responsePreferenceLines.push('Use OCR/direct file reading as a fallback when indexed retrieval is weak or missing.');
  }

  return {
    profileContextLines: Array.from(new Set(profileContextLines)),
    responsePreferenceLines,
    evidence: evidence.slice(0, 8),
    preferences,
  };
};

export const buildUserPersonalizationPromptSections = (
  personalization: ResolvedUserPersonalization | null | undefined,
): string[] => {
  if (!personalization) return [];
  const sections: string[] = [];
  if (personalization.profileContextLines.length > 0) {
    sections.push(
      'Stable user profile context:',
      ...personalization.profileContextLines.map((line) => `- ${line}`),
    );
  }
  if (personalization.responsePreferenceLines.length > 0) {
    sections.push(
      'User response preferences:',
      '- Apply these preferences when they do not conflict with the current explicit request, correctness, or safety.',
      ...personalization.responsePreferenceLines.map((line) => `- ${line}`),
    );
  }
  return sections;
};

export const retrieveUserPersonalizationMemory = async (input: {
  companyId?: string;
  userId?: string;
  conversationKey?: string;
  latestUserMessage?: string;
  limit?: number;
  logPrefix: string;
}): Promise<ResolvedUserPersonalization> => {
  if (!input.companyId || !input.userId) {
    return resolveUserPersonalization([]);
  }

  const limit = Math.max(2, Math.min(8, input.limit ?? 6));
  const queryText = buildPersonalizationQuery(input.latestUserMessage);

  logger.info(`${input.logPrefix}.start`, {
    conversationKey: input.conversationKey,
    queryLength: queryText.length,
    limit,
  });

  const scopedMatches = input.conversationKey
    ? await personalVectorMemoryService.query({
      companyId: input.companyId,
      requesterUserId: input.userId,
      conversationKey: input.conversationKey,
      text: queryText,
      limit: Math.min(4, limit),
    })
    : [];

  const globalMatches = await personalVectorMemoryService.query({
    companyId: input.companyId,
    requesterUserId: input.userId,
    text: queryText,
    limit,
  });

  const personalization = resolveUserPersonalization([
    ...scopedMatches,
    ...globalMatches,
  ]);

  logger.info(`${input.logPrefix}.completed`, {
    conversationScopedMatchCount: scopedMatches.length,
    globalMatchCount: globalMatches.length,
    profileContextCount: personalization.profileContextLines.length,
    responsePreferenceCount: personalization.responsePreferenceLines.length,
  });

  return personalization;
};
