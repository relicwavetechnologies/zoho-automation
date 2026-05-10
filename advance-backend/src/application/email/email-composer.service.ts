import type { EmailAddress, DivoEmailTemplateData } from './email.types';
import { MimeBuilder, type BuiltMimeMessage } from './mime-builder';
import { DivoHtmlEmailTemplate } from './templates/divo-html-email-template';

export interface ComposeEmailInput {
  readonly to: readonly EmailAddress[];
  readonly cc?: readonly EmailAddress[];
  readonly bcc?: readonly EmailAddress[];
  readonly from?: EmailAddress;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly template?: DivoEmailTemplateData;
  readonly threadId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}

export class EmailComposerService {
  constructor(
    private readonly mimeBuilder = new MimeBuilder(),
    private readonly divoTemplate = new DivoHtmlEmailTemplate(),
  ) {}

  compose(input: ComposeEmailInput): BuiltMimeMessage {
    const rendered = input.template ? this.divoTemplate.render(input.template) : null;
    const text = input.text ?? rendered?.text ?? stripHtml(input.html ?? '');
    const html = input.html ?? rendered?.html;

    return this.mimeBuilder.build({
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      ...(input.from ? { from: input.from } : {}),
      subject: input.subject,
      text,
      ...(html ? { html } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
    });
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

