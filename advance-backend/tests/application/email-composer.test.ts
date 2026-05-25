import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailComposerService } from '../../src/application/email/email-composer.service.ts';
import { DivoHtmlEmailTemplate } from '../../src/application/email/templates/divo-html-email-template.ts';

describe('EmailComposerService', () => {
  it('builds multipart alternative MIME when template is provided', () => {
    const composer = new EmailComposerService();
    const result = composer.compose({
      to: [{ email: 'alice@example.com' }],
      subject: 'Research summary',
      text: 'Plain fallback',
      template: {
        title: 'Jawa 42 Bobber',
        intro: 'Hi Anish, here is the summary.',
        sections: [{ heading: 'Pricing', body: 'From ₹1.95L', bullets: ['On-road ~₹2.33L'] }],
      },
    });

    assert.match(result.raw, /multipart\/alternative/);
    assert.match(result.raw, /text\/html; charset=UTF-8/);
    assert.match(result.raw, /text\/plain; charset=UTF-8/);
    assert.match(result.raw, /Jawa 42 Bobber/);
    assert.match(result.raw, /4f8cff/i);
  });

  it('builds plain-text MIME with all headers when no template', () => {
    const composer = new EmailComposerService();
    const result = composer.compose({
      from: { name: 'Divo Ops', email: 'ops@example.com' },
      to: [{ name: 'Alice', email: 'alice@example.com' }],
      cc: [{ email: 'finance@example.com' }],
      bcc: [{ email: 'audit@example.com' }],
      subject: 'Quarterly update',
      text: 'Hello Alice,\n\nHere is the update.',
      threadId: 'thread-1',
      inReplyTo: '<msg-1@example.com>',
      references: ['<msg-0@example.com>', '<msg-1@example.com>'],
    });

    assert.match(result.raw, /^From: Divo Ops <ops@example\.com>/);
    assert.match(result.raw, /To: Alice <alice@example\.com>/);
    assert.match(result.raw, /Cc: finance@example\.com/);
    assert.match(result.raw, /Bcc: audit@example\.com/);
    assert.match(result.raw, /In-Reply-To: <msg-1@example\.com>/);
    assert.match(result.raw, /References: <msg-0@example\.com> <msg-1@example\.com>/);
    assert.match(result.raw, /Content-Type: text\/plain; charset=UTF-8/);
    assert.doesNotMatch(result.raw, /Content-Type: text\/html/);
    assert.match(result.raw, /Hello Alice/);
    assert.ok(result.encodedRaw.length > 0);
    assert.doesNotMatch(result.encodedRaw, /[+/=]/);
  });

  it('builds multipart when raw HTML is provided alongside plain text', () => {
    const composer = new EmailComposerService();
    const result = composer.compose({
      to: [{ email: 'alice@example.com' }],
      subject: 'HTML note',
      text: 'Plain fallback',
      html: '<p>Premium HTML</p>',
    });

    assert.match(result.raw, /multipart\/alternative/);
    assert.match(result.raw, /Content-Type: text\/html/);
    assert.match(result.raw, /Plain fallback/);
    assert.match(result.raw, /Premium HTML/);
  });

  it('passes attachments into MIME composition', () => {
    const composer = new EmailComposerService();
    const result = composer.compose({
      to: [{ email: 'alice@example.com' }],
      subject: 'Attached',
      text: 'See attached.',
      attachments: [{
        fileName: 'report.csv',
        mimeType: 'text/csv',
        sizeBytes: 7,
        content: Buffer.from('a,b\n1,2'),
        source: 'outbound_artifact',
      }],
    });

    assert.match(result.raw, /Content-Type: multipart\/mixed; boundary="divo_mixed_/);
    assert.match(result.raw, /Content-Disposition: attachment; filename="report\.csv"/);
    assert.match(result.raw, new RegExp(Buffer.from('a,b\n1,2').toString('base64')));
  });

  it('renders Divo template into HTML and text fallback', () => {
    const template = new DivoHtmlEmailTemplate();
    const rendered = template.render({
      variant: 'proposal',
      eyebrow: 'Divo proposal',
      title: 'Automation rollout',
      intro: 'A focused rollout plan for your operations team.',
      metadata: [{ label: 'Timeline', value: '2 weeks' }],
      sections: [{
        heading: 'Scope',
        body: 'We will connect Gmail and Drive first.',
        bullets: ['Draft workflows', 'Approval-safe sending'],
      }],
      cta: { label: 'Review proposal', url: 'https://example.com/proposal' },
      signatureName: 'Aria from Divo',
    });

    assert.match(rendered.html, /<table role="presentation"/);
    assert.match(rendered.html, /Divo/);
    assert.match(rendered.html, /Automation rollout/);
    assert.match(rendered.html, /Review proposal/);
    assert.match(rendered.html, /https:\/\/example\.com\/proposal/);
    assert.doesNotMatch(rendered.html, /<script/i);
    assert.match(rendered.text, /Automation rollout/);
    assert.match(rendered.text, /- Draft workflows/);
    assert.match(rendered.text, /Review proposal: https:\/\/example\.com\/proposal/);
  });

  it('renders finance amounts and transaction counts visibly', () => {
    const template = new DivoHtmlEmailTemplate();
    const rendered = template.render({
      variant: 'invoice_or_finance',
      title: 'Total Payment Received',
      intro: 'The total payment received by the company to date is ₹62,71,81,387.60 across 4,000 transactions.',
      metadata: [
        { label: 'Amount', value: '₹62,71,81,387.60' },
        { label: 'Transactions', value: '4,000 transactions' },
      ],
    });

    assert.match(rendered.html, /Total Payment Received/);
    assert.match(rendered.html, /₹62,71,81,387\.60/);
    assert.match(rendered.html, /4,000 transactions/);
    assert.match(rendered.text, /Amount: ₹62,71,81,387\.60/);
    assert.match(rendered.text, /Transactions: 4,000 transactions/);
  });

  it('renders multiple links as visible link cards with text fallback', () => {
    const template = new DivoHtmlEmailTemplate();
    const rendered = template.render({
      title: 'Best Bikes 2026',
      intro: 'Hi Anish, here are two links for the best bikes of 2026:',
      links: [
        { label: 'Bicycling guide', url: 'https://www.bicycling.com/bikes-gear/a123/best-bikes-2026' },
        { label: 'Cycling Weekly picks', url: 'https://www.cyclingweekly.com/group-tests/best-road-bikes' },
      ],
    });

    assert.match(rendered.html, /Bicycling guide/);
    assert.match(rendered.html, /Cycling Weekly picks/);
    assert.match(rendered.html, /https:\/\/www\.bicycling\.com\/bikes-gear\/a123\/best-bikes-2026/);
    assert.match(rendered.html, /href="https:\/\/www\.bicycling\.com/);
    assert.doesNotMatch(rendered.html, /#A91635/i);
    assert.doesNotMatch(rendered.html, /border-radius:24px/i);
    assert.match(rendered.text, /Bicycling guide: https:\/\/www\.bicycling\.com\/bikes-gear\/a123\/best-bikes-2026/);
    assert.match(rendered.text, /Cycling Weekly picks: https:\/\/www\.cyclingweekly\.com\/group-tests\/best-road-bikes/);
  });
});
