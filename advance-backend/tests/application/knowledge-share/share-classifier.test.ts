import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyForShare } from '../../../src/application/knowledge-share/share-classifier.ts';

describe('classifyForShare', () => {
  it('returns safe for benign file', () => {
    assert.equal(
      classifyForShare({ fileName: 'onboarding.pdf', mimeType: 'application/pdf', sampleText: 'Welcome to the team, here is your guide.' }),
      'safe',
    );
  });

  it('returns critical for payroll keyword in text', () => {
    assert.equal(
      classifyForShare({ fileName: 'report.pdf', mimeType: 'application/pdf', sampleText: 'payroll processing for Q4' }),
      'critical',
    );
  });

  it('returns critical for salary keyword in filename', () => {
    assert.equal(
      classifyForShare({ fileName: 'salary-sheet.xlsx', mimeType: 'application/vnd.ms-excel' }),
      'critical',
    );
  });

  it('returns critical for confidential keyword', () => {
    assert.equal(
      classifyForShare({ fileName: 'doc.pdf', mimeType: 'application/pdf', sampleText: 'CONFIDENTIAL: do not distribute' }),
      'critical',
    );
  });

  it('returns critical for PII keyword', () => {
    assert.equal(
      classifyForShare({ fileName: 'data.csv', mimeType: 'text/csv', sampleText: 'SSN and personal data of employees' }),
      'critical',
    );
  });

  it('returns review for employee keyword', () => {
    assert.equal(
      classifyForShare({ fileName: 'roster.pdf', mimeType: 'application/pdf', sampleText: 'Each employee must submit a timesheet weekly.' }),
      'review',
    );
  });

  it('returns review for contract keyword', () => {
    assert.equal(
      classifyForShare({ fileName: 'vendor.pdf', mimeType: 'application/pdf', sampleText: 'vendor contract 2024' }),
      'review',
    );
  });

  it('returns review for invoice keyword', () => {
    assert.equal(
      classifyForShare({ fileName: 'invoice.pdf', mimeType: 'application/pdf', sampleText: 'Payment due: $500. Invoice number: 1234.' }),
      'review',
    );
  });

  it('critical takes precedence over review when both match', () => {
    assert.equal(
      classifyForShare({ fileName: 'employee-payroll.pdf', mimeType: 'application/pdf', sampleText: 'employee list with salary information' }),
      'critical',
    );
  });

  it('no sampleText uses filename only', () => {
    assert.equal(
      classifyForShare({ fileName: 'company-handbook.pdf', mimeType: 'application/pdf' }),
      'safe',
    );
  });
});
