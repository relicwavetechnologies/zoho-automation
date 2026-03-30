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

const toSentence = (value?: string): string => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return '';
  }
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const inferGreeting = (audience?: string): string => {
  const normalized = normalizeWhitespace(audience);
  if (!normalized || normalized.includes('@')) {
    return 'Hi,';
  }
  const first = normalized.split(/[,\s]+/u).filter(Boolean)[0];
  if (!first) {
    return 'Hi,';
  }
  return `Hi ${first},`;
};

const inferSubject = (input: ComposeEmailInput): string => {
  const explicitSubject = normalizeWhitespace(input.subject);
  if (explicitSubject) {
    return explicitSubject;
  }

  const purpose = normalizeWhitespace(input.purpose);
  if (!purpose) {
    return 'Update';
  }

  return purpose
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .slice(0, 120)
    .trim() || 'Update';
};

const renderFallbackHtmlEmail = (input: ComposeEmailInput, subject: string): string => {
  const facts = (input.facts ?? []).map((entry) => normalizeWhitespace(entry)).filter(Boolean);
  const rawBody = normalizeWhitespace(input.body);
  const purpose = normalizeWhitespace(input.purpose);
  const greeting = escapeHtml(inferGreeting(input.audience));
  const bodyParagraphs = rawBody
    ? rawBody
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
    : [];
  const intro = !rawBody && purpose
    ? `I’m reaching out regarding ${escapeHtml(toSentence(purpose).replace(/[.]$/u, ''))}.`
    : '';
  const attachmentLabel = input.attachments?.length
    ? input.attachments.length === 1
      ? `Attached: ${escapeHtml(input.attachments[0]?.fileName ?? 'requested file')}.`
      : `Attached: ${input.attachments.length} files for reference.`
    : '';
  const closing = !rawBody && !purpose && facts.length === 0
    ? 'Please let me know if you need anything further.'
    : 'Please let me know if you have any questions or would like anything adjusted.';

  const sections: string[] = [
    '<!doctype html>',
    '<html>',
    '<body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">',
    '<div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e6ebf3;border-radius:16px;padding:32px 32px 24px;">',
    `<p style="margin:0 0 18px 0;font-size:16px;line-height:1.6;">${greeting}</p>`,
  ];

  if (bodyParagraphs.length > 0) {
    for (const paragraph of bodyParagraphs) {
      sections.push(
        `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;">${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`,
      );
    }
  } else if (intro) {
    sections.push(
      `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;">${intro}</p>`,
    );
  }

  if (facts.length > 0) {
    sections.push(
      '<div style="margin:20px 0 18px 0;padding:18px 20px;background:#f8fafc;border:1px solid #e7edf5;border-radius:12px;">',
      `<p style="margin:0 0 10px 0;font-size:13px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#44506a;">${facts.length <= 3 ? 'Key details' : 'Highlights'}</p>`,
      '<ul style="margin:0;padding-left:20px;color:#172033;">',
      ...facts.slice(0, 6).map(
        (fact) =>
          `<li style="margin:0 0 8px 0;font-size:15px;line-height:1.6;">${escapeHtml(fact.replace(/^[•*-]\s*/u, ''))}</li>`,
      ),
      '</ul>',
      '</div>',
    );
  }

  if (attachmentLabel) {
    sections.push(
      `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.7;color:#44506a;"><strong>${escapeHtml(attachmentLabel)}</strong></p>`,
    );
  }

  sections.push(
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;">${escapeHtml(closing)}</p>`,
    '<p style="margin:0;font-size:15px;line-height:1.6;">Best,<br />Divo</p>',
    '</div>',
    `<div style="max-width:680px;margin:12px auto 0;color:#6b7280;font-size:12px;line-height:1.5;padding:0 8px;">Subject: ${escapeHtml(subject)}</div>`,
    '</body>',
    '</html>',
  );

  return sections.join('');
};

const fallbackCompose = (input: ComposeEmailInput): ComposeEmailOutput => {
  const facts = (input.facts ?? []).map((entry) => normalizeWhitespace(entry)).filter(Boolean);
  const rawBody = normalizeWhitespace(input.body);
  const subject = inferSubject(input);

  if (input.preserveUserWording && rawBody) {
    return {
      subject,
      body: rawBody,
      isHtml: Boolean(input.preferHtml),
      composedBy: 'fallback',
    };
  }

  const lines: string[] = [];
  lines.push(inferGreeting(input.audience));
  lines.push('');
  if (rawBody) {
    lines.push(rawBody);
    lines.push('');
  } else if (input.purpose) {
    lines.push(`I’m reaching out regarding ${toSentence(input.purpose).replace(/[.]$/u, '')}.`);
    lines.push('');
  }

  if (facts.length > 0) {
    lines.push(facts.length <= 3 ? 'Key details:' : 'Here are the key details:');
    for (const fact of facts.slice(0, 6)) {
      lines.push(`- ${fact.replace(/^[•*-]\s*/u, '')}`);
    }
    lines.push('');
  }

  if (input.attachments?.length) {
    const attachmentLabel = input.attachments.length === 1
      ? `I’ve attached ${input.attachments[0]?.fileName ?? 'the requested file'} for reference.`
      : `I’ve attached ${input.attachments.length} files for reference.`;
    lines.push(attachmentLabel);
    lines.push('');
  }

  if (!rawBody && !input.purpose && facts.length === 0) {
    lines.push('Please let me know if you need anything further.');
    lines.push('');
  } else {
    lines.push('Please let me know if you have any questions or would like anything adjusted.');
    lines.push('');
  }

  lines.push('Best,');

  const plainBody = lines.join('\n').trim();

  return {
    subject,
    body: input.preferHtml ? renderFallbackHtmlEmail(input, subject) : plainBody,
    isHtml: Boolean(input.preferHtml),
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
          'Write polished business emails that feel human, clear, and confident.',
          'Aim for tasteful, high-quality writing rather than stiff corporate filler.',
          'Open with immediate context, keep the middle structured, and end with a clear next step.',
          'Use a subject line that is specific, concise, and natural.',
          'When the message is external, client-facing, or attachment-driven, make it presentation-ready rather than casual.',
          'Subjects should usually be action-oriented and concrete, not vague labels like "Update" unless nothing more specific is available.',
          'Prefer short paragraphs; use flat bullets only when they improve readability.',
          'When facts are provided, organize them cleanly and surface the most important ones first.',
          'Avoid robotic phrasing, generic AI apologies, fluff, and empty pleasantries.',
          'Do not default to "I hope you are doing well" unless the draft clearly calls for it.',
          'Preserve concrete facts, dates, numbers, names, attachments, and requested actions.',
          'If attachments are present, mention them naturally when useful, but do not over-explain them.',
          'If the purpose is transactional, be crisp and direct. If it is client-facing, keep it warm and professional.',
          'Honor the requested tone and template family when provided.',
          'Do not invent facts or attachments.',
          'Default to plain text unless HTML is explicitly preferred.',
          'If HTML is preferred, return lightweight, email-safe HTML using only simple tags like p, ul, li, strong, br, and div with inline styles. Do not include scripts, external assets, markdown fences, or full document commentary.',
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
