import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { subjectFromToolAction } from '../../src/application/decision/subject-from-tool-action';

describe('subjectFromToolAction', () => {
  it('gives a tool with no third party behind it no subject at all', () => {
    // Rather than a Divo-branded strip. `webSearch` and `knowledge` have no
    // vendor, and drawing one would be the card claiming an involvement that
    // does not exist.
    assert.equal(subjectFromToolAction('webSearch', 'read', { query: 'gst rates' }), undefined);
    assert.equal(subjectFromToolAction('knowledge', 'read', {}), undefined);
  });

  it('reads a Gmail send as a message, and marks it irreversible', () => {
    const subject = subjectFromToolAction('googleGmail', 'send', {
      to: ['priya@westbridge.co.in'],
      cc: 'accounts@emiactech.com',
      subject: 'Re: Invoice 2214 overdue',
      body: 'Hi Priya,\n\nCould you confirm the payment date?',
    });

    assert.equal(subject?.brand, 'gmail');
    assert.equal(subject?.target, 'Re: Invoice 2214 overdue');
    assert.equal(subject?.irreversible, true);
    assert.deepEqual(subject?.preview, {
      kind: 'message',
      to: ['priya@westbridge.co.in'],
      cc: ['accounts@emiactech.com'],
      subject: 'Re: Invoice 2214 overdue',
      body: 'Hi Priya,\n\nCould you confirm the payment date?',
    });
  });

  it('finds the arguments MCP tools nest under input', () => {
    const subject = subjectFromToolAction('googleGmail', 'send', {
      nativeTool: 'send_message',
      input: { to: ['a@b.com'], body: 'hello' },
    });
    assert.equal(subject?.preview?.kind, 'message');
  });

  it('does not mark a create or an update irreversible', () => {
    // Everything Divo writes to can be edited afterwards. A warning on almost
    // every card is the same as no warning.
    assert.equal(subjectFromToolAction('zohoBooks', 'create', { amount: '100' })?.irreversible, undefined);
    assert.equal(subjectFromToolAction('airtableRecords', 'update', { fields: { A: 1 } })?.irreversible, undefined);
    assert.equal(subjectFromToolAction('airtableRecords', 'delete', { recordId: 'rec1' })?.irreversible, true);
  });

  it('reads a Sheets write as a grid, keeping the total honest', () => {
    const subject = subjectFromToolAction('googleSheets', 'update', {
      range: 'Leads!A1:B7',
      values: [
        ['Company', 'Owner'],
        ['Westbridge', 'Aleem'],
        ['Nandi', 'Priya'],
        ['Halcyon', 'Aleem'],
        ['Orbit', 'Meera'],
        ['Kestrel', 'Priya'],
      ],
    });

    assert.equal(subject?.brand, 'googleSheets');
    assert.equal(subject?.target, 'Leads!A1:B7');
    assert.equal(subject?.preview?.kind, 'table');
    const preview = subject!.preview as Extract<typeof subject.preview, { kind: 'table' }>;
    assert.deepEqual(preview.columns, ['Company', 'Owner']);
    assert.equal(preview.rows.length, 4);
    // Five data rows, four shown. The count has to name the one not drawn or
    // the approver reads a five-row write as a four-row one.
    assert.equal(preview.more, 1);
  });

  it('treats a first row containing a blank as data, not as headers', () => {
    // A sheet append whose first row is data would otherwise lose that row into
    // the header and show one row fewer than is being written.
    const subject = subjectFromToolAction('googleSheets', 'create', {
      values: [['Westbridge', ''], ['Nandi', 'Priya']],
    });
    const preview = subject!.preview as Extract<typeof subject.preview, { kind: 'table' }>;
    assert.deepEqual(preview.columns, ['Column 1', 'Column 2']);
    assert.equal(preview.rows.length, 2);
  });

  it('reads a Zoho Books invoice as money, with its line items', () => {
    const subject = subjectFromToolAction('zohoBooks', 'create', {
      customerName: 'Westbridge Retail Pvt Ltd',
      amount: '184500',
      dueDate: '2026-09-02',
      lineItems: [
        { name: 'Retainer — August', amount: '150000' },
        { name: 'GST 18%', amount: '27750' },
      ],
    });

    assert.equal(subject?.brand, 'zohoBooks');
    assert.deepEqual(subject?.preview, {
      kind: 'money',
      amount: '184500',
      party: 'Westbridge Retail Pvt Ltd',
      due: '2026-09-02',
      lines: [
        { label: 'Retainer — August', value: '150000' },
        { label: 'GST 18%', value: '27750' },
      ],
    });
  });

  it('reads an Airtable write as a record under its table name', () => {
    const subject = subjectFromToolAction('airtableRecords', 'update', {
      table: 'Vendors',
      fields: { Name: 'Halcyon Foods', Status: 'Approved' },
    });
    assert.equal(subject?.brand, 'airtable');
    assert.deepEqual(subject?.preview, {
      kind: 'record',
      collection: 'Vendors',
      fields: [
        { name: 'Name', value: 'Halcyon Foods' },
        { name: 'Status', value: 'Approved' },
      ],
    });
  });

  it('reads a Lark calendar create as an event, not as a file', () => {
    // The shape a real `larkCalendar` create sends. `title` alone also satisfies
    // the file preview, so before `event` was ordered ahead of it a meeting
    // rendered as a paperclip captioned "New file".
    const subject = subjectFromToolAction('larkCalendar', 'create', {
      op: 'create',
      title: 'Westbridge — Q3 review',
      startTime: '2026-08-21T15:00:00+05:30',
      endTime: '2026-08-21T16:00:00+05:30',
      attendees: ['Aleem Khan', 'Priya Nair'],
    });

    assert.equal(subject?.brand, 'lark');
    assert.equal(subject?.preview?.kind, 'event');
    const preview = subject!.preview as Extract<typeof subject.preview, { kind: 'event' }>;
    assert.equal(preview.title, 'Westbridge — Q3 review');
    assert.equal(preview.starts, '2026-08-21T15:00:00+05:30');
    assert.deepEqual(preview.attendees, ['Aleem Khan', 'Priya Nair']);
  });

  it('still reads a Drive file named by title as a file', () => {
    // The other side of that ordering: nothing with a start time reaches `file`,
    // and everything else named by `title` still does.
    const subject = subjectFromToolAction('googleDrive', 'create', {
      title: 'FY26 board pack.pdf',
      mimeType: 'application/pdf',
    });
    assert.equal(subject?.preview?.kind, 'file');
  });

  it('gives a Lark task delete the brand strip and no preview', () => {
    // A delete carries an id and nothing else. There is no object to draw, and
    // an empty preview box would read as "nothing is being changed".
    const subject = subjectFromToolAction('larkTask', 'delete', { op: 'delete', taskId: 'task_881' });
    assert.equal(subject?.brand, 'lark');
    assert.equal(subject?.irreversible, true);
    assert.equal(subject?.preview, undefined);
  });

  it('still names the product when the arguments match no shape', () => {
    // The brand strip alone is the honest result. An empty preview box would
    // read as "nothing is being changed".
    const subject = subjectFromToolAction('semrush', 'read', { cursor: 'abc', pageSize: 50 });
    assert.equal(subject?.brand, 'semrush');
    assert.equal(subject?.preview, undefined);
  });
});
