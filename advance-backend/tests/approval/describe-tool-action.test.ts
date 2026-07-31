import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolAction, summariseToolAction } from '../../src/application/approval/describe-tool-action.ts';
import { actionPhrase, toolLabel } from '../../src/domain/tools/tool-labels.ts';

describe('describeToolAction', () => {
  it('names the product and the action the way a person would', () => {
    const described = describeToolAction('googleGmail', 'send', {
      op: 'send', to: ['boss@example.com'], subject: 'Q2 report', body: 'Attached.',
    });

    assert.equal(described.tool, 'Gmail');
    assert.equal(described.title, 'Send email');
    assert.deepEqual(described.details.slice(0, 2), [
      { label: 'To', value: 'boss@example.com' },
      { label: 'Subject', value: 'Q2 report' },
    ]);
  });

  it('reads through the MCP `input` wrapper the connectors nest arguments in', () => {
    const described = describeToolAction('airtableRecords', 'delete', {
      connectionId: 'conn-1',
      nativeTool: 'delete_records',
      input: { baseId: 'appABC', tableId: 'tblXYZ', records: ['rec1', 'rec2', 'rec3', 'rec4'] },
    });

    assert.equal(described.title, 'Delete records · delete records');
    const labels = described.details.map(d => d.label);
    assert.ok(labels.includes('Table'), `expected a Table detail, got ${labels.join(', ')}`);
    assert.ok(labels.includes('Base'));
    assert.equal(described.details.find(d => d.label === 'Records')?.value, 'rec1, rec2, rec3 +1 more');
  });

  it('does not repeat the action when the operation says the same thing', () => {
    assert.equal(describeToolAction('larkMessaging', 'send', { op: 'send' }).title, 'Send messages');
  });

  it('falls back to a readable name for a tool it has never heard of', () => {
    const described = describeToolAction('someNewThing', 'update', { title: 'Weekly plan' });
    assert.equal(described.tool, 'Some New Thing');
    assert.equal(described.title, 'Edit items');
  });

  it('keeps a single detail line short enough to sit on a card', () => {
    const described = describeToolAction('googleDocs', 'update', { documentId: 'doc-1', body: 'x'.repeat(500) });
    const body = described.details.find(d => d.label === 'Body')!;
    assert.ok(body.value.length <= 160, `detail was ${body.value.length} chars`);
    assert.ok(body.value.endsWith('…'));
  });

  it('drops noise an approver cannot judge', () => {
    const described = describeToolAction('googleDrive', 'delete', { connectionId: 'conn-9', pageSize: 100, fileId: 'f-1' });
    assert.deepEqual(described.details, [{ label: 'File', value: 'f-1' }]);
  });

  it('summarises to one line for places that can only show a string', () => {
    assert.equal(
      summariseToolAction('zohoBooks', 'create', { module: 'Invoices', amount: 4200 }),
      'Add invoices — Module: Invoices · Amount: 4200',
    );
  });

  it('says something useful even with no arguments at all', () => {
    assert.equal(summariseToolAction('semrush', 'read', {}), 'View SEO data');
  });
});

describe('tool labels', () => {
  it('phrases an action group the same way the access screens do', () => {
    assert.equal(actionPhrase('airtableSchema', 'delete'), 'Delete tables and fields');
    assert.equal(actionPhrase('scheduledWorkflows', 'execute'), 'Run schedules');
  });

  it('covers every canonical tool, so nothing falls back to a machine name', async () => {
    const { CANONICAL_TOOL_IDS } = await import('../../src/domain/tools/tool-id.ts');
    for (const id of CANONICAL_TOOL_IDS) {
      const label = toolLabel(id);
      assert.notEqual(label.noun, 'items', `${id} has no label`);
    }
  });
});
