import type { DivoEmailSection, DivoEmailTemplateData, DivoEmailTemplateVariant } from './email.types';

export function buildTemplateFromPlainText(
  subject: string,
  bodyText: string,
  overrides?: Partial<Pick<DivoEmailTemplateData, 'variant' | 'eyebrow' | 'signatureName' | 'signatureTitle' | 'footerNote'>>,
): DivoEmailTemplateData {
  const { intro, sections } = parsePlainTextSections(bodyText);
  const metadata = extractMetadataFromText(bodyText);
  const links = extractLinksFromText(bodyText);

  return {
    variant: overrides?.variant ?? inferVariantFromContent(subject, bodyText),
    title: subject.trim() || 'Divo message',
    ...(intro ? { intro } : {}),
    ...(metadata?.length ? { metadata } : {}),
    ...(links?.length ? { links } : {}),
    ...(sections.length ? { sections } : {}),
    ...(overrides?.eyebrow ? { eyebrow: overrides.eyebrow } : {}),
    ...(overrides?.signatureName ? { signatureName: overrides.signatureName } : {}),
    ...(overrides?.signatureTitle ? { signatureTitle: overrides.signatureTitle } : {}),
    footerNote: overrides?.footerNote ?? 'Sent with Divo.',
  };
}

export function parsePlainTextSections(text: string): {
  readonly intro?: string;
  readonly sections: readonly DivoEmailSection[];
} {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: DivoEmailSection[] = [];
  const introLines: string[] = [];

  let current: { heading?: string; bodyLines: string[]; bullets: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const body = current.bodyLines.join('\n').trim();
    const bullets = current.bullets;
    if (body || bullets.length) {
      sections.push({
        ...(current.heading ? { heading: current.heading } : {}),
        body: body || bullets.join('\n'),
        ...(bullets.length ? { bullets } : {}),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (current) current.bodyLines.push('');
      else if (introLines.length && introLines[introLines.length - 1] !== '') introLines.push('');
      continue;
    }

    if (/^[-_=]{4,}$/.test(trimmed)) continue;

    if (isSectionHeader(trimmed)) {
      flush();
      current = {
        heading: normalizeSectionHeading(trimmed),
        bodyLines: [],
        bullets: [],
      };
      continue;
    }

    const bullet = parseBullet(trimmed);
    if (bullet && current) {
      current.bullets.push(bullet);
      continue;
    }

    if (current) {
      current.bodyLines.push(line.trimEnd());
    } else {
      introLines.push(line.trimEnd());
    }
  }

  flush();

  const intro = introLines.join('\n').trim();
  return {
    ...(intro ? { intro } : {}),
    sections,
  };
}

function isSectionHeader(line: string): boolean {
  if (/^#{1,3}\s+\S/.test(line)) return true;
  if (/^[A-Z][A-Za-z0-9\s/&–—\-(),]+:\s*$/.test(line)) return true;
  if (/^[A-Z0-9][A-Z0-9\s/&\-().]{3,}$/.test(line) && line === line.toUpperCase()) {
    // Banner titles (e.g. "JAWA 42 BOBBER — FULL RESEARCH SUMMARY") stay in intro.
    if (/[—–]/.test(line) || /\bSUMMARY\b/.test(line)) return false;
    return line.length <= 48;
  }
  return false;
}

function normalizeSectionHeading(line: string): string {
  return line
    .replace(/^#{1,3}\s+/, '')
    .replace(/:\s*$/, '')
    .trim();
}

function parseBullet(line: string): string | undefined {
  const match = line.match(/^[-*•]\s+(.+)$/);
  return match?.[1]?.trim();
}

function inferVariantFromContent(subject: string, body: string): DivoEmailTemplateVariant {
  const hay = `${subject}\n${body}`.toLowerCase();
  if (/invoice|finance|payment|overdue|\bar\b|zoho books|₹|receivable/.test(hay)) return 'invoice_or_finance';
  if (/proposal/.test(hay)) return 'proposal';
  if (/follow[- ]?up/.test(hay)) return 'follow_up';
  if (/research|report|summary/.test(hay)) return 'report_delivery';
  if (/executive|ceo|board/.test(hay)) return 'executive';
  return 'standard';
}

function extractMetadataFromText(text: string): DivoEmailTemplateData['metadata'] {
  const metadata: Array<NonNullable<DivoEmailTemplateData['metadata']>[number]> = [];
  const amount = text.match(/₹\s?[\d,]+(?:\.\d+)?(?:\s*(?:L|Cr|K))?/i)?.[0];
  if (amount) metadata.push({ label: 'Amount', value: amount.replace(/\s+/g, ' ') });

  const transactions = text.match(/\b[\d,]+\s+transactions?\b/i)?.[0];
  if (transactions) metadata.push({ label: 'Transactions', value: transactions });

  const priceRange = text.match(/₹[\d.]+\s*[Lk]?\s*[–—-]\s*₹[\d.]+/i)?.[0];
  if (priceRange) metadata.push({ label: 'Price range', value: priceRange });

  return metadata.length ? metadata : undefined;
}

function extractLinksFromText(text: string): DivoEmailTemplateData['links'] {
  const links: Array<NonNullable<DivoEmailTemplateData['links']>[number]> = [];
  const seen = new Set<string>();

  for (const line of text.split(/\n+/)) {
    for (const url of extractUrls(line)) {
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ label: linkLabelFromLine(line, url, links.length + 1), url });
    }
  }

  return links.length ? links : undefined;
}

function extractUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s<>"']+/gi)]
    .map(match => match[0].replace(/[),.;:!?]+$/g, ''))
    .filter(url => /^https?:\/\/[^\s<>"']+$/i.test(url));
}

function linkLabelFromLine(line: string, url: string, index: number): string {
  const beforeUrl = line.slice(0, line.indexOf(url)).replace(/^\s*(?:[-*•]|\d+[\).:-])\s*/, '').trim();
  if (beforeUrl && beforeUrl.length <= 80) return beforeUrl;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host ? `${host} link` : `Link ${index}`;
  } catch {
    return `Link ${index}`;
  }
}
