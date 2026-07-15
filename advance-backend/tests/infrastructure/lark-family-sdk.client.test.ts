import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@larksuiteoapi/node-sdk';
import { LarkApprovalClient } from '../../src/infrastructure/channels/lark/clients/lark-approval.client';
import { LarkBaseClient } from '../../src/infrastructure/channels/lark/clients/lark-base.client';
import { LarkCalendarClient } from '../../src/infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkMeetingClient } from '../../src/infrastructure/channels/lark/clients/lark-meeting.client';
import { LarkDocClient } from '../../src/infrastructure/channels/lark/clients/lark-doc.client';
import { LarkToolMessagingClient } from '../../src/infrastructure/channels/lark/clients/lark-messaging.client';
import { LarkTaskClient } from '../../src/infrastructure/channels/lark/clients/lark-task.client';

type SdkRequest = { method: string; url: string; params?: unknown; data?: unknown };

function sdkStub(respond: (request: SdkRequest) => unknown) {
  const requests: SdkRequest[] = [];
  const sdkClient = {
    request: async (request: SdkRequest) => {
      requests.push(request);
      return { code: 0, data: respond(request) };
    },
  } as unknown as Pick<Client, 'request'>;
  return { sdkClient, requests };
}

const deps = (sdkClient: Pick<Client, 'request'>) => ({ appId: 'app', appSecret: 'secret', sdkClient });

describe('Lark family clients through the official SDK boundary', () => {
  it('maps task records while preserving the documented SDK request', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ task: { guid: 'task-1', summary: 'Ship SDK', completed: true } }));
    const task = await new LarkTaskClient(deps(sdkClient)).getTask('task-1');

    assert.deepEqual(task, { taskId: 'task-1', title: 'Ship SDK', completed: true });
    assert.deepEqual(requests[0], { method: 'GET', url: '/open-apis/task/v2/tasks/task-1' });
  });

  it('constructs calendar mutations through the SDK', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ event: { event_id: 'event-1' } }));
    const result = await new LarkCalendarClient(deps(sdkClient)).createEvent('primary', {
      title: 'Review', startTime: '2026-07-15T10:00:00.000Z', endTime: '2026-07-15T11:00:00.000Z', attendeeIds: ['ou_1'],
    });

    assert.deepEqual(result, { eventId: 'event-1' });
    assert.equal(requests[0]?.method, 'POST');
    assert.equal(requests[0]?.url, '/open-apis/calendar/v4/calendars/primary/events');
    assert.deepEqual(requests[0]?.data, {
      summary: 'Review',
      start_time: { timestamp: '1784109600', timezone: 'UTC' },
      end_time: { timestamp: '1784113200', timezone: 'UTC' },
      attendees: [{ type: 'user', user_id: 'ou_1' }],
    });
  });

  it('searches video meetings through the official SDK boundary', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ items: [{ id: 'meeting-1', topic: 'Launch review' }] }));
    const meetings = await new LarkMeetingClient(deps(sdkClient)).searchMeetings({
      query: 'launch', startTime: '1784066400', endTime: '1784152800', limit: 10,
    });

    assert.deepEqual(meetings, [{ id: 'meeting-1', topic: 'Launch review' }]);
    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/open-apis/vc/v1/meetings/search',
      params: { page_size: 10 },
      data: {
        query: 'launch',
        meeting_filter: { start_time: { start_time: '1784066400', end_time: '1784152800' } },
      },
    });
  });

  it('uses the matching Lark payload field for every supported rich-text block type', async () => {
    const cases = [
      ['text', 2],
      ['heading1', 3],
      ['heading2', 4],
      ['heading3', 5],
      ['bullet', 12],
      ['code', 14],
    ] as const;

    for (const [blockType, blockTypeNumber] of cases) {
      const { sdkClient, requests } = sdkStub(request => request.method === 'GET'
        ? { document: { document_id: 'doc-root' } }
        : {});
      await new LarkDocClient(deps(sdkClient)).appendBlock('doc-1', 'Hello', blockType);

      assert.deepEqual(requests, [
        { method: 'GET', url: '/open-apis/docx/v1/documents/doc-1' },
        {
          method: 'POST',
          url: '/open-apis/docx/v1/documents/doc-1/blocks/doc-root/children',
          data: {
            children: [{
              block_type: blockTypeNumber,
              [blockType]: { elements: [{ text_run: { content: 'Hello' } }], style: {} },
            }],
          },
        },
      ]);
    }
  });

  it('creates a table using the documented payload and populates header cells', async () => {
    const { sdkClient, requests } = sdkStub(request => {
      if (request.method === 'GET') return { document: { document_id: 'doc-root' } };
      if (request.url.endsWith('/blocks/doc-root/children')) {
        return {
          children: [{
            table: {
              cells: ['cell-1', 'cell-2', 'cell-3', 'cell-4'],
              property: { row_size: 2, column_size: 2, header_row: true },
            },
          }],
        };
      }
      return {};
    });

    await new LarkDocClient(deps(sdkClient)).insertTable('doc-1', {
      rows: 2,
      cols: 2,
      headers: ['Owner', 'Status'],
    });

    assert.deepEqual(requests, [
      { method: 'GET', url: '/open-apis/docx/v1/documents/doc-1' },
      {
        method: 'POST',
        url: '/open-apis/docx/v1/documents/doc-1/blocks/doc-root/children',
        params: { document_revision_id: -1 },
        data: {
          children: [{
            block_type: 31,
            table: { property: { row_size: 2, column_size: 2, header_row: true } },
          }],
        },
      },
      {
        method: 'POST',
        url: '/open-apis/docx/v1/documents/doc-1/blocks/cell-1/children',
        params: { document_revision_id: -1 },
        data: {
          children: [{ block_type: 2, text: { elements: [{ text_run: { content: 'Owner' } }], style: {} } }],
        },
      },
      {
        method: 'POST',
        url: '/open-apis/docx/v1/documents/doc-1/blocks/cell-2/children',
        params: { document_revision_id: -1 },
        data: {
          children: [{ block_type: 2, text: { elements: [{ text_run: { content: 'Status' } }], style: {} } }],
        },
      },
    ]);
  });

  it('updates rich text using the documented patch operation', async () => {
    const { sdkClient, requests } = sdkStub(() => ({}));

    await new LarkDocClient(deps(sdkClient)).updateBlock('doc-1', 'block-1', 'Updated');

    assert.deepEqual(requests, [{
      method: 'PATCH',
      url: '/open-apis/docx/v1/documents/doc-1/blocks/block-1',
      params: { document_revision_id: -1 },
      data: {
        update_text_elements: { elements: [{ text_run: { content: 'Updated' } }] },
      },
    }]);
  });

  it('resolves the canonical Lark URL through Drive metadata after document creation', async () => {
    const { sdkClient, requests } = sdkStub(request => request.url.includes('/metas/')
      ? { metas: [{ doc_token: 'doc-1', url: 'https://example.larksuite.com/docx/doc-1' }] }
      : { document: { document_id: 'doc-1', revision_id: 1, title: 'Launch notes' } });

    const result = await new LarkDocClient(deps(sdkClient)).createDoc('Launch notes');

    assert.deepEqual(result, {
      docToken: 'doc-1',
      url: 'https://example.larksuite.com/docx/doc-1',
    });
    assert.deepEqual(requests, [
      {
        method: 'POST',
        url: '/open-apis/docx/v1/documents',
        data: { title: 'Launch notes' },
      },
      {
        method: 'POST',
        url: '/open-apis/drive/v1/metas/batch_query',
        data: {
          request_docs: [{ doc_token: 'doc-1', doc_type: 'docx' }],
          with_url: true,
        },
      },
    ]);
  });

  it('preserves successful creation when Drive metadata has no canonical URL', async () => {
    const { sdkClient } = sdkStub(request => request.url.includes('/metas/')
      ? { metas: [{ doc_token: 'doc-1' }] }
      : { document: { document_id: 'doc-1' } });

    assert.deepEqual(
      await new LarkDocClient(deps(sdkClient)).createDoc('Launch notes'),
      { docToken: 'doc-1' },
    );
  });

  it('does not turn a Drive metadata failure into a failed document creation', async () => {
    const { sdkClient } = sdkStub(request => {
      if (request.url.includes('/metas/')) throw new Error('metadata unavailable');
      return { document: { document_id: 'doc-1' } };
    });

    assert.deepEqual(
      await new LarkDocClient(deps(sdkClient)).createDoc('Launch notes'),
      { docToken: 'doc-1' },
    );
  });

  it('rejects a create response that has no document ID', async () => {
    const { sdkClient } = sdkStub(() => ({ document: {} }));

    await assert.rejects(
      () => new LarkDocClient(deps(sdkClient)).createDoc('Launch notes'),
      /did not include document_id/,
    );
  });

  it('creates Base records through the SDK with caller fields unchanged', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ record: { record_id: 'rec-1' } }));
    const result = await new LarkBaseClient(deps(sdkClient)).createRecord('app-1', 'tbl-1', { Name: 'Divo' });

    assert.deepEqual(result, { recordId: 'rec-1' });
    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/open-apis/bitable/v1/apps/app-1/tables/tbl-1/records',
      data: { fields: { Name: 'Divo' } },
    });
  });

  it('uses the installed-app SDK client for native approvals', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ instance_code: 'approval-1' }));
    const result = await new LarkApprovalClient(deps(sdkClient)).createInstance('leave', { reason: 'Vacation' });

    assert.deepEqual(result, { instanceCode: 'approval-1' });
    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/open-apis/approval/v4/instances',
      data: { approval_code: 'leave', form: '[{"id":"reason","value":"Vacation"}]' },
    });
  });

  it('uses the Divo-selected user token client for managed Lark messages', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ message_id: 'msg-1' }));
    const result = await new LarkToolMessagingClient({ ...deps(sdkClient), userToken: 'managed-user-token' })
      .sendMessage('chat-1', 'Hello');

    assert.deepEqual(result, { messageId: 'msg-1' });
    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/open-apis/im/v1/messages?receive_id_type=chat_id',
      data: { receive_id: 'chat-1', msg_type: 'text', content: '{"text":"Hello"}' },
    });
  });
});
