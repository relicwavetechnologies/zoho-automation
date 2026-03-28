import { generateObject } from 'ai';
import { z } from 'zod';

import { resolveVercelLanguageModel } from './vercel/model-factory';

type ComposeEmailInput = {
  purpose?: string;
  audience?: string;
  tone?: string;
  templateFamily?: string;
  subject?: string;
  body?: string;
  facts?: string[];
  attachments?: Array<{ fileName: string; mimeType: string }>;
  preserveUserWording?: boolean;
  preferHtml?: boolean;
};

type ComposeEmailOutput = {
  subject: string;
  body: string;
  isHtml: boolean;
  composedBy: 'model' | 'fallback';
};

const EMAIL_OUTPUT_SCHEMA = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  isHtml: z.boolean().optional(),
});

const normalizeWhitespace = (value?: string): string =>
  (value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const fallbackCompose = (input: ComposeEmailInput): ComposeEmailOutput => {
  const facts = (input.facts ?? []).map((entry) => normalizeWhitespace(entry)).filter(Boolean);
  const rawBody = normalizeWhitespace(input.body);
  const subject =
    normalizeWhitespace(input.subject)
    || normalizeWhitespace(input.purpose)
    || 'Update';

  if (input.preserveUserWording && rawBody) {
    return {
      subject,
      body: rawBody,
      isHtml: Boolean(input.preferHtml),
      composedBy: 'fallback',
    };
  }

  const lines: string[] = [];
  lines.push('Hi,');
  lines.push('');
  if (rawBody) {
    lines.push(rawBody);
    lines.push('');
  } else if (input.purpose) {
    lines.push(`I’m reaching out regarding ${normalizeWhitespace(input.purpose)}.`);
    lines.push('');
  }

  if (facts.length > 0) {
    lines.push('Relevant details:');
    for (const fact of facts.slice(0, 8)) {
      lines.push(`- ${fact}`);
    }
    lines.push('');
  }

  if (!rawBody && !input.purpose && facts.length === 0) {
    lines.push('Please let me know if you need anything further.');
    lines.push('');
  } else {
    lines.push('Please let me know if you have any questions.');
    lines.push('');
  }

  lines.push('Thanks,');

  return {
    subject,
    body: lines.join('\n').trim(),
    isHtml: false,
    composedBy: 'fallback',
  };
};

export class EmailComposeService {
  async composeEmail(input: ComposeEmailInput): Promise<ComposeEmailOutput> {
    if (input.preserveUserWording) {
      return fallbackCompose(input);
    }

    try {
      const resolvedModel = await resolveVercelLanguageModel('fast');
      const result = await generateObject({
        model: resolvedModel.model,
        schema: EMAIL_OUTPUT_SCHEMA,
        system: [
          'Rewrite and polish business email drafts.',
          'Write concise, human, purpose-first emails.',
          'Avoid robotic phrasing, generic AI apologies, and filler.',
          'Return a crisp subject and a professional body.',
          'Use short paragraphs or flat bullets only when genuinely useful.',
          'Preserve concrete facts, dates, numbers, and requested actions.',
          'Do not invent facts or attachments.',
          'Default to plain text unless HTML is explicitly preferred.',
        ].join(' '),
        prompt: JSON.stringify({
          purpose: normalizeWhitespace(input.purpose),
          audience: normalizeWhitespace(input.audience),
          tone: normalizeWhitespace(input.tone) || 'professional',
          templateFamily: normalizeWhitespace(input.templateFamily),
          subject: normalizeWhitespace(input.subject),
          body: normalizeWhitespace(input.body),
          facts: (input.facts ?? []).map((entry) => normalizeWhitespace(entry)).filter(Boolean),
          attachments: (input.attachments ?? []).map((attachment) => ({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
          })),
          preferHtml: Boolean(input.preferHtml),
        }),
        temperature: 0.2,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: false,
              thinkingLevel: resolvedModel.thinkingLevel,
            },
          },
        },
      });
      return {
        subject: normalizeWhitespace(result.object.subject) || fallbackCompose(input).subject,
        body: normalizeWhitespace(result.object.body) || fallbackCompose(input).body,
        isHtml: Boolean(input.preferHtml && result.object.isHtml),
        composedBy: 'model',
      };
    } catch {
      return fallbackCompose(input);
    }
  }
}

export const emailComposeService = new EmailComposeService();
