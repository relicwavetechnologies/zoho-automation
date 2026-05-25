import type {
  DivoEmailLink,
  DivoEmailSection,
  DivoEmailTemplateData,
  RenderedEmailBody,
} from '../email.types';

/** T1 Editorial — flat layout, blue accent, no nested marketing boxes. */
const PALETTE = {
  shell:     '#F3F4F6',
  card:      '#FFFFFF',
  ink:       '#111827',
  body:      '#4B5563',
  muted:     '#6B7280',
  label:     '#9CA3AF',
  border:    '#E5E7EB',
  divider:   '#F3F4F6',
  accent:    '#4F8CFF',
  accentAlt: '#6366F1',
};

const FONT_STACK = "'Segoe UI',system-ui,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif";

export class DivoHtmlEmailTemplate {
  render(input: DivoEmailTemplateData): RenderedEmailBody {
    return {
      html: this.renderHtml(input),
      text: this.renderText(input),
    };
  }

  private renderHtml(input: DivoEmailTemplateData): string {
    const variantLabel = variantLabelFor(input.variant);
    const preheader    = input.preheader ?? input.intro ?? input.title;
    const sections     = input.sections ?? [];

    const bodyRows = [
      this.renderBrandRow(variantLabel, input.eyebrow),
      this.renderTitleRow(input.title),
      input.intro ? this.renderIntroRow(input.intro) : '',
      input.metadata?.length ? this.renderMetadata(input.metadata) : '',
      input.links?.length ? this.renderLinks(input.links) : '',
      ...sections.map(section => this.renderSection(section)),
      input.cta ? this.renderCta(input.cta.label, input.cta.url) : '',
      this.renderSignature(input),
    ].filter(Boolean).join('');

    return `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PALETTE.shell};font-family:${FONT_STACK};color:${PALETTE.ink};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.shell};padding:24px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${PALETTE.card};border:1px solid ${PALETTE.border};border-radius:8px;overflow:hidden;">
            <tr>
              <td style="height:3px;background:linear-gradient(90deg,${PALETTE.accent},${PALETTE.accentAlt});font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:24px 20px 20px 17px;border-left:3px solid ${PALETTE.accent};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bodyRows}</table>
              </td>
            </tr>
          </table>
          ${this.renderFooter(input.footerNote)}
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private renderBrandRow(variantLabel: string, eyebrow?: string): string {
    const eyebrowLine = eyebrow
      ? `<tr><td style="padding:0 0 8px 0;font-size:11px;line-height:1.4;color:${PALETTE.muted};">${escapeHtml(eyebrow)}</td></tr>`
      : '';
    return `
      ${eyebrowLine}
      <tr>
        <td style="padding:0 0 16px 0;font-size:11px;line-height:1.4;color:${PALETTE.muted};">
          <span style="font-weight:600;color:${PALETTE.accent};">Divo</span>
          <span style="color:${PALETTE.label};"> · </span>
          ${escapeHtml(variantLabel)}
        </td>
      </tr>`;
  }

  private renderTitleRow(title: string): string {
    return `
      <tr>
        <td style="padding:0 0 4px 0;">
          <h1 style="margin:0;color:${PALETTE.ink};font-size:20px;line-height:1.25;letter-spacing:-.02em;font-weight:600;">${escapeHtml(title)}</h1>
        </td>
      </tr>`;
  }

  private renderIntroRow(intro: string): string {
    return `
      <tr>
        <td style="padding:12px 0 0 0;color:${PALETTE.body};font-size:15px;line-height:1.6;">
          ${paragraphsToHtml(intro)}
        </td>
      </tr>`;
  }

  private renderMetadata(metadata: readonly { readonly label: string; readonly value: string }[]): string {
    const pairs: string[] = [];
    for (let i = 0; i < metadata.length; i += 2) {
      const left  = metadata[i]!;
      const right = metadata[i + 1];
      pairs.push(`
        <tr>
          ${this.renderMetadataCell(left)}
          ${right ? this.renderMetadataCell(right) : '<td width="50%"></td>'}
        </tr>`);
    }

    return `
      <tr>
        <td style="padding:16px 0 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${pairs.join('')}</table>
        </td>
      </tr>`;
  }

  private renderMetadataCell(item: { readonly label: string; readonly value: string }): string {
    return `
      <td width="50%" valign="top" style="padding:8px 12px 8px 0;border-bottom:1px solid ${PALETTE.divider};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${PALETTE.label};margin-bottom:4px;">${escapeHtml(item.label)}</div>
        <div style="font-size:14px;line-height:1.35;font-weight:600;color:${PALETTE.ink};">${escapeHtml(item.value)}</div>
      </td>`;
  }

  private renderSection(section: DivoEmailSection): string {
    return `
      <tr>
        <td style="padding:16px 0 0 0;border-top:1px solid ${PALETTE.border};">
          ${section.heading ? `<h2 style="margin:0 0 8px 0;color:${PALETTE.ink};font-size:13px;line-height:1.35;font-weight:600;">${escapeHtml(section.heading)}</h2>` : ''}
          <div style="color:${PALETTE.body};font-size:14px;line-height:1.6;">${paragraphsToHtml(section.body)}</div>
          ${section.bullets?.length ? `<ul style="margin:10px 0 0 18px;padding:0;color:${PALETTE.body};font-size:14px;line-height:1.6;">${section.bullets.map(b => `<li style="margin-bottom:4px;">${linkifyText(b)}</li>`).join('')}</ul>` : ''}
        </td>
      </tr>`;
  }

  private renderLinks(links: readonly DivoEmailLink[]): string {
    const rows = links.map((link, index) => `
      <tr>
        <td style="padding:${index === 0 ? '12' : '10'}px 0 ${index === links.length - 1 ? '0' : '10'}px;${index > 0 ? `border-top:1px solid ${PALETTE.divider};` : ''}">
          <div style="color:${PALETTE.ink};font-size:14px;line-height:1.4;font-weight:600;">${escapeHtml(link.label)}</div>
          <div style="margin-top:6px;font-size:13px;line-height:1.5;">
            <a href="${escapeAttribute(link.url)}" style="color:${PALETTE.accent};text-decoration:underline;word-break:break-all;">${linkifyText(link.url)}</a>
          </div>
        </td>
      </tr>`).join('');

    return `
      <tr>
        <td style="padding:16px 0 0 0;border-top:1px solid ${PALETTE.border};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td>
      </tr>`;
  }

  private renderCta(label: string, url: string): string {
    return `
      <tr>
        <td style="padding:20px 0 0 0;">
          <a href="${escapeAttribute(url)}" style="display:inline-block;background:${PALETTE.accent};color:#FFFFFF;text-decoration:none;border-radius:6px;padding:10px 18px;font-size:14px;line-height:1;font-weight:600;">${escapeHtml(label)}</a>
        </td>
      </tr>`;
  }

  private renderSignature(input: DivoEmailTemplateData): string {
    const name  = input.signatureName ?? 'Divo';
    const title = input.signatureTitle ?? 'Agentic operations workspace';
    return `
      <tr>
        <td style="padding:24px 0 0 0;color:${PALETTE.body};font-size:14px;line-height:1.55;">
          <p style="margin:0;">Best regards,<br><strong style="color:${PALETTE.ink};">${escapeHtml(name)}</strong></p>
          <p style="margin:6px 0 0 0;color:${PALETTE.muted};font-size:12px;line-height:1.45;">${escapeHtml(title)}</p>
        </td>
      </tr>`;
  }

  private renderFooter(note?: string): string {
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr>
          <td align="center" style="padding:16px 16px 0 16px;color:${PALETTE.muted};font-size:11px;line-height:1.5;">
            ${escapeHtml(note ?? 'Sent with Divo.')}
          </td>
        </tr>
      </table>`;
  }

  private renderText(input: DivoEmailTemplateData): string {
    const lines = [
      input.eyebrow,
      input.title,
      input.intro,
      ...(input.metadata?.map(item => `${item.label}: ${item.value}`) ?? []),
      ...(input.links?.map(item => `${item.label}: ${item.url}`) ?? []),
      ...(input.sections ?? []).flatMap(section => [
        section.heading,
        section.body,
        ...(section.bullets?.map(b => `- ${b}`) ?? []),
      ]),
      input.cta ? `${input.cta.label}: ${input.cta.url}` : undefined,
      `Best regards,\n${input.signatureName ?? 'Divo'}`,
      input.footerNote,
    ].filter(Boolean);

    return lines.join('\n\n');
  }
}

function variantLabelFor(variant: DivoEmailTemplateData['variant']): string {
  switch (variant) {
    case 'executive':          return 'Executive';
    case 'proposal':           return 'Proposal';
    case 'follow_up':          return 'Follow-up';
    case 'report_delivery':    return 'Report';
    case 'invoice_or_finance': return 'Finance';
    case 'standard':
    default:                   return 'Operations';
  }
}

function paragraphsToHtml(value: string): string {
  return value
    .split(/\n{2,}/)
    .map(paragraph => `<p style="margin:0 0 10px 0;">${linkifyText(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function linkifyText(value: string): string {
  return escapeHtml(value).replace(/https?:\/\/[^\s<>"']+/g, url => (
    `<a href="${escapeAttribute(url)}" style="color:${PALETTE.accent};text-decoration:underline;">${url}</a>`
  ));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
