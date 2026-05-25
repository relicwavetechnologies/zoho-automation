import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateFromPlainText, parsePlainTextSections } from '../../src/application/email/plain-text-to-template.ts';

describe('plain-text-to-template', () => {
  it('parses ALL CAPS sections and intro', () => {
    const body = [
      'Hey Anish,',
      'Here is the research summary.',
      '',
      'JAWA 42 BOBBER — FULL RESEARCH SUMMARY',
      '________________________________',
      '',
      'PRICING (India, Ex-Showroom):',
      '- Range: ₹1.95L – ₹2.22L',
      '- On-road (Delhi): ~₹2.33L',
      '',
      'ENGINE & PERFORMANCE:',
      '- 334cc liquid-cooled',
    ].join('\n');

    const parsed = parsePlainTextSections(body);
    assert.match(parsed.intro ?? '', /Hey Anish/);
    assert.ok(parsed.sections.length >= 1);
    assert.equal(parsed.sections[0]?.heading, 'PRICING (India, Ex-Showroom)');
    assert.ok(parsed.sections[0]?.bullets?.length);
  });

  it('builds report_delivery variant for research subjects', () => {
    const template = buildTemplateFromPlainText('Jawa 42 Bobber — research summary', 'Full report body');
    assert.equal(template.variant, 'report_delivery');
    assert.equal(template.title, 'Jawa 42 Bobber — research summary');
  });
});
