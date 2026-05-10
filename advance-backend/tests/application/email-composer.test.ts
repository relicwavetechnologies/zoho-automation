import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailComposerService } from '../../src/application/email/email-composer.service.ts';
import { DivoHtmlEmailTemplate } from '../../src/application/email/templates/divo-html-email-template.ts';

describe('EmailComposerService', () => {
  it('builds plain-text MIME with to, cc, bcc, and reply headers', () => {
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
    assert.ok(result.encodedRaw.length > 0);
    assert.doesNotMatch(result.encodedRaw, /[+/=]/);
  });

  it('builds multipart alternative when HTML is provided', () => {
    const composer = new EmailComposerService();
    const result = composer.compose({
      to: [{ email: 'alice@example.com' }],
      subject: 'HTML note',
      text: 'Plain fallback',
      html: '<p>Premium HTML</p>',
    });

    assert.match(result.raw, /Content-Type: multipart\/alternative; boundary="divo_alt_/);
    assert.match(result.raw, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(result.raw, /Content-Type: text\/html; charset=UTF-8/);
    assert.match(result.raw, /<p>Premium HTML<\/p>/);
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
    assert.doesNotMatch(rendered.html, /<script/i);
    assert.match(rendered.text, /Automation rollout/);
    assert.match(rendered.text, /- Draft workflows/);
  });
});

