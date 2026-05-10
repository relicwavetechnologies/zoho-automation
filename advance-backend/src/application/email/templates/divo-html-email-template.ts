import type {
  DivoEmailSection,
  DivoEmailTemplateData,
  RenderedEmailBody,
} from '../email.types';

const PALETTE = {
  shell: '#F4F1EE',
  card: '#FFFFFF',
  ink: '#111827',
  muted: '#6B7280',
  border: '#E7E2DD',
  navy: '#111827',
  wine: '#A91635',
  rose: '#F5DDE3',
  soft: '#FAF8F6',
};

export class DivoHtmlEmailTemplate {
  render(input: DivoEmailTemplateData): RenderedEmailBody {
    return {
      html: this.renderHtml(input),
      text: this.renderText(input),
    };
  }

  private renderHtml(input: DivoEmailTemplateData): string {
    const variantLabel = variantLabelFor(input.variant);
    const preheader = input.preheader ?? input.intro ?? input.title;
    const sections = input.sections ?? [];

    return `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PALETTE.shell};font-family:Aptos,'Helvetica Neue',Arial,sans-serif;color:${PALETTE.ink};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.shell};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${PALETTE.card};border:1px solid ${PALETTE.border};border-radius:24px;overflow:hidden;box-shadow:0 18px 50px rgba(17,24,39,.10);">
            <tr>
              <td style="background:${PALETTE.navy};padding:28px 32px;color:#FFFFFF;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-size:22px;line-height:1;font-weight:800;letter-spacing:-.02em;">Divo</td>
                    <td align="right"><span style="display:inline-block;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.20);border-radius:999px;padding:7px 12px;font-size:12px;line-height:1;color:#F8FAFC;">${escapeHtml(variantLabel)}</span></td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 32px 10px 32px;">
                ${input.eyebrow ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:${PALETTE.wine};font-weight:800;margin-bottom:14px;">${escapeHtml(input.eyebrow)}</div>` : ''}
                <h1 style="margin:0;color:${PALETTE.ink};font-size:34px;line-height:1.08;letter-spacing:-.04em;font-weight:800;">${escapeHtml(input.title)}</h1>
                ${input.intro ? `<p style="margin:18px 0 0 0;color:${PALETTE.muted};font-size:16px;line-height:1.7;">${escapeHtml(input.intro)}</p>` : ''}
              </td>
            </tr>
            ${input.metadata?.length ? this.renderMetadata(input.metadata) : ''}
            ${sections.map(section => this.renderSection(section)).join('')}
            ${input.cta ? this.renderCta(input.cta.label, input.cta.url) : ''}
            ${this.renderSignature(input)}
          </table>
          ${this.renderFooter(input.footerNote)}
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private renderMetadata(metadata: readonly { readonly label: string; readonly value: string }[]): string {
    const cells = metadata.map(item => `
      <td style="padding:8px 8px 8px 0;">
        <span style="display:inline-block;border:1px solid ${PALETTE.border};background:${PALETTE.soft};border-radius:999px;padding:8px 12px;color:${PALETTE.muted};font-size:13px;line-height:1.2;">
          <strong style="color:${PALETTE.ink};">${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}
        </span>
      </td>`).join('');

    return `
      <tr>
        <td style="padding:18px 32px 4px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
        </td>
      </tr>`;
  }

  private renderSection(section: DivoEmailSection): string {
    return `
      <tr>
        <td style="padding:18px 32px 0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.soft};border:1px solid ${PALETTE.border};border-radius:18px;">
            <tr>
              <td style="padding:22px 22px 20px 22px;">
                ${section.heading ? `<h2 style="margin:0 0 10px 0;color:${PALETTE.ink};font-size:18px;line-height:1.3;font-weight:800;">${escapeHtml(section.heading)}</h2>` : ''}
                <div style="color:${PALETTE.ink};font-size:15px;line-height:1.7;">${paragraphsToHtml(section.body)}</div>
                ${section.bullets?.length ? `<ul style="margin:14px 0 0 20px;padding:0;color:${PALETTE.ink};font-size:15px;line-height:1.7;">${section.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  private renderCta(label: string, url: string): string {
    return `
      <tr>
        <td style="padding:26px 32px 4px 32px;">
          <a href="${escapeAttribute(url)}" style="display:inline-block;background:${PALETTE.wine};color:#FFFFFF;text-decoration:none;border-radius:999px;padding:14px 22px;font-size:15px;line-height:1;font-weight:800;">${escapeHtml(label)}</a>
        </td>
      </tr>`;
  }

  private renderSignature(input: DivoEmailTemplateData): string {
    const name = input.signatureName ?? 'Divo';
    const title = input.signatureTitle ?? 'Agentic operations workspace';
    return `
      <tr>
        <td style="padding:30px 32px 34px 32px;">
          <div style="height:1px;background:${PALETTE.border};margin-bottom:22px;"></div>
          <p style="margin:0;color:${PALETTE.ink};font-size:15px;line-height:1.6;">Best regards,<br><strong>${escapeHtml(name)}</strong></p>
          <p style="margin:6px 0 0 0;color:${PALETTE.muted};font-size:13px;line-height:1.5;">${escapeHtml(title)}</p>
        </td>
      </tr>`;
  }

  private renderFooter(note?: string): string {
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
        <tr>
          <td align="center" style="padding:18px 16px 0 16px;color:${PALETTE.muted};font-size:12px;line-height:1.6;">
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
    case 'executive': return 'Executive note';
    case 'proposal': return 'Proposal';
    case 'follow_up': return 'Follow-up';
    case 'report_delivery': return 'Report';
    case 'invoice_or_finance': return 'Finance';
    case 'standard':
    default: return 'Premium workspace';
  }
}

function paragraphsToHtml(value: string): string {
  return value
    .split(/\n{2,}/)
    .map(paragraph => `<p style="margin:0 0 12px 0;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
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

