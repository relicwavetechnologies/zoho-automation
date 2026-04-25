/**
 * Faithfulness grader — checks whether the generated answer's claims
 * are supported by the retrieved document context.
 *
 * Uses gemini-3.1-flash-lite-preview via Vercel AI SDK.
 * Falls back to { grounded: true } on any error so a grader failure
 * never silently blocks a valid response.
 */

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Logger } from '../../shared/logger';

export interface GradeAnswerInput {
  answer:        string;
  contextChunks: string[];
  query:         string;
  geminiApiKey:  string | undefined;
}

export interface GradeAnswerOutput {
  grounded: boolean;
  reason:   string;
}

const GRADER_MODEL   = 'gemini-3.1-flash-lite-preview';
const GRADER_TIMEOUT = 8_000;

export async function gradeAnswer(input: GradeAnswerInput, logger: Logger): Promise<GradeAnswerOutput> {
  if (!input.geminiApiKey || input.contextChunks.length === 0) {
    return { grounded: true, reason: 'no_grader_or_context' };
  }

  const log = logger.child({ fn: 'gradeAnswer' });
  const contextText = input.contextChunks.slice(0, 6).join('\n\n---\n\n').slice(0, 4000);
  const answerText  = input.answer.slice(0, 1200);

  const prompt = [
    'You are a faithfulness judge.',
    'Given the CONTEXT and ANSWER below, reply with JSON {"grounded": true/false, "reason": "..."}.',
    '"grounded": true means every factual claim in the ANSWER is directly supported by the CONTEXT.',
    '"grounded": false means the ANSWER contains claims not supported by the CONTEXT.',
    'Keep "reason" under 30 words.',
    '',
    `CONTEXT:\n${contextText}`,
    '',
    `ANSWER:\n${answerText}`,
    '',
    'JSON:',
  ].join('\n');

  try {
    const google = createGoogleGenerativeAI({ apiKey: input.geminiApiKey });
    const { text: rawText } = await generateText({
      model:       google(GRADER_MODEL),
      prompt,
      temperature: 0,
      maxOutputTokens: 80,
      abortSignal: AbortSignal.timeout(GRADER_TIMEOUT),
    });

    const jsonMatch = rawText.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('answer-grader.parse_failed', { rawText });
      return { grounded: true, reason: 'grader_parse_error' };
    }

    const result = JSON.parse(jsonMatch[0]) as { grounded?: boolean; reason?: string };
    return {
      grounded: result.grounded !== false,
      reason:   result.reason ?? 'ok',
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError' || String(e).includes('AbortError')) {
      log.warn('answer-grader.timeout');
    } else {
      log.warn('answer-grader.error', { error: String(e) });
    }
    return { grounded: true, reason: 'grader_error' };
  }
}
