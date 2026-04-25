import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFileDocument } from '../../../src/application/ingestion/chunking/classify.ts';

describe('classifyFileDocument', () => {
  it('classifies image MIME as media_summary', () => {
    assert.equal(classifyFileDocument({ fileName: 'photo.png', mimeType: 'image/png', text: '' }), 'media_summary');
  });

  it('classifies video MIME as media_summary', () => {
    assert.equal(classifyFileDocument({ fileName: 'recording.mp4', mimeType: 'video/mp4', text: '' }), 'media_summary');
  });

  it('classifies transcript from text keywords', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'call.txt', mimeType: 'text/plain', text: 'Transcript: speaker 1: hello, speaker 2: hi [00:00:01]' }),
      'transcript',
    );
  });

  it('classifies contract from filename', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'vendor-contract.pdf', mimeType: 'application/pdf', text: 'this agreement is between...' }),
      'contract',
    );
  });

  it('classifies handbook from text', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'welcome.pdf', mimeType: 'application/pdf', text: 'Employee Manual - Welcome to the team' }),
      'handbook',
    );
  });

  it('classifies policy from text', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'hr-doc.pdf', mimeType: 'application/pdf', text: 'Leave policy: employees are entitled to 20 days of annual leave.' }),
      'policy',
    );
  });

  it('classifies sop from text', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'process.pdf', mimeType: 'application/pdf', text: 'Runbook: Step 1 — restart the service. Procedure for handling incidents.' }),
      'sop',
    );
  });

  it('classifies finance_doc from text', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'q3.xlsx', mimeType: 'application/vnd.ms-excel', text: 'Profit and loss statement for Q3 — revenue: $1.2M, expenses: $800k' }),
      'finance_doc',
    );
  });

  it('classifies generic_text as fallback', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'notes.txt', mimeType: 'text/plain', text: 'some random notes about the project' }),
      'generic_text',
    );
  });

  it('transcript takes precedence over generic when both keywords present', () => {
    assert.equal(
      classifyFileDocument({ fileName: 'meeting.txt', mimeType: 'text/plain', text: 'Meeting minutes transcript speaker 1 said hello' }),
      'transcript',
    );
  });
});
