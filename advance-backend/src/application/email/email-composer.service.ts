import type { EmailAddress, DivoEmailTemplateData } from './email.types';
import type { ResolvedAttachment } from './attachment.types';
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
  readonly attachments?: readonly ResolvedAttachment[];
}

export class EmailComposerService {
  constructor(
    private readonly mimeBuilder = new MimeBuilder(),
    private readonly divoTemplate = new DivoHtmlEmailTemplate(),
  ) {}

  compose(input: ComposeEmailInput): BuiltMimeMessage {
    // HTML template disabled — plain text is more reliable across email clients.
    // The Divo HTML template renders data tables and structured content poorly
    // (horizontal overflow, missing body text). Re-enable once the template is reworked.
    const rendered = input.template
      ? this.divoTemplate.render(input.template)
      : null;
    const text = input.text ?? rendered?.text ?? stripHtml(input.html ?? '');

    return this.mimeBuilder.build({
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      ...(input.from ? { from: input.from } : {}),
      subject: input.subject,
      text,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      ...(input.attachments?.length ? {
        attachments: input.attachments.map(attachment => ({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          content: attachment.content,
        })),
      } : {}),
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
