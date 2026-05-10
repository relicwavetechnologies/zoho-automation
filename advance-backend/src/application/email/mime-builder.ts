import type { EmailAddress } from './email.types';

export interface BuildMimeMessageInput {
  readonly to: readonly EmailAddress[];
  readonly cc?: readonly EmailAddress[];
  readonly bcc?: readonly EmailAddress[];
  readonly from?: EmailAddress;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly threadId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}

export interface BuiltMimeMessage {
  readonly raw: string;
  readonly encodedRaw: string;
}

const CRLF = '\r\n';

export class MimeBuilder {
  build(input: BuildMimeMessageInput): BuiltMimeMessage {
    const headers = this.buildHeaders(input);
    const body = input.html
      ? this.buildAlternativeBody(input.text, input.html)
      : {
        contentType: 'text/plain; charset=UTF-8',
        body: normalizeLineEndings(input.text),
      };

    const raw = [
      ...headers,
      `Content-Type: ${body.contentType}`,
      'MIME-Version: 1.0',
      '',
      body.body,
    ].join(CRLF);

    return {
      raw,
      encodedRaw: encodeBase64Url(raw),
    };
  }

  private buildHeaders(input: BuildMimeMessageInput): string[] {
    const headers: string[] = [];
    if (input.from) headers.push(`From: ${formatAddress(input.from)}`);
    headers.push(`To: ${formatAddressList(input.to)}`);
    if (input.cc?.length) headers.push(`Cc: ${formatAddressList(input.cc)}`);
    if (input.bcc?.length) headers.push(`Bcc: ${formatAddressList(input.bcc)}`);
    headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
    if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
    if (input.references?.length) headers.push(`References: ${input.references.join(' ')}`);
    if (input.threadId) headers.push(`X-Divo-Thread-Id: ${input.threadId}`);
    return headers;
  }

  private buildAlternativeBody(text: string, html: string): { contentType: string; body: string } {
    const boundary = `divo_alt_${randomBoundaryToken()}`;
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeLineEndings(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeLineEndings(html),
      `--${boundary}--`,
      '',
    ].join(CRLF);

    return {
      contentType: `multipart/alternative; boundary="${boundary}"`,
      body,
    };
  }
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r?\n/g, CRLF);
}

function randomBoundaryToken(): string {
  return Math.random().toString(36).slice(2, 12);
}

function formatAddressList(addresses: readonly EmailAddress[]): string {
  return addresses.map(formatAddress).join(', ');
}

function formatAddress(address: EmailAddress): string {
  const email = sanitizeHeaderValue(address.email.trim());
  const name = address.name?.trim();
  if (!name) return email;
  return `${quoteDisplayName(name)} <${email}>`;
}

function quoteDisplayName(name: string): string {
  const sanitized = sanitizeHeaderValue(name);
  if (/^[A-Za-z0-9 ._-]+$/.test(sanitized)) return sanitized;
  return `"${sanitized.replace(/"/g, '\\"')}"`;
}

function encodeHeaderValue(value: string): string {
  return sanitizeHeaderValue(value.trim());
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

