import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@larksuiteoapi/node-sdk';
import { LarkApprovalClient } from '../../src/infrastructure/channels/lark/clients/lark-approval.client';
import { LarkBaseClient } from '../../src/infrastructure/channels/lark/clients/lark-base.client';
import { LarkCalendarClient } from '../../src/infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkMeetingClient } from '../../src/infrastructure/channels/lark/clients/lark-meeting.client';
import { LarkDocClient } from '../../src/infrastructure/channels/lark/clients/lark-doc.client';
import {
  LarkMessagingClient,
  LarkToolMessagingClient,
} from '../../src/infrastructure/channels/lark/clients/lark-messaging.client';
import { LarkTaskClient } from '../../src/infrastructure/channels/lark/clients/lark-task.client';
import type { Logger } from '../../src/shared/logger';

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
const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

describe('Lark family clients through the official SDK boundary', () => {
  it('resolves the installed bot identity through the documented bot endpoint', async () => {
    const { sdkClient, requests } = sdkStub(() => ({
      bot: { open_id: 'ou_bot', bot_name: 'Divo' },
    }));
    const client = new LarkMessagingClient({
      appId: 'app',
      appSecret: 'secret',
      logger: noopLogger,
      sdkClient,
    });

    assert.deepEqual(await client.getBotIdentity(), { openId: 'ou_bot', name: 'Divo' });
    assert.deepEqual(requests[0], { method: 'GET', url: '/open-apis/bot/v3/info' });
  });

  it('maps task records while preserving the documented SDK request', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ task: { guid: 'task-1', summary: 'Ship SDK', completed: true } }));
    const task = await new LarkTaskClient(deps(sdkClient)).getTask('task-1');

    assert.deepEqual(task, { taskId: 'task-1', title: 'Ship SDK', completed: true });
    assert.deepEqual(requests[0], { method: 'GET', url: '/open-apis/task/v2/tasks/task-1' });
  });

  it('creates, updates, completes, and assigns tasks with Task v2 request contracts', async () => {
    const { sdkClient, requests } = sdkStub(request => {
      if (request.method === 'POST' && request.url === '/open-apis/task/v2/tasks') {
        return { task: { guid: 'task-1' } };
      }
      return {};
    });
    const client = new LarkTaskClient(deps(sdkClient));

    assert.deepEqual(await client.createTask({
      title: 'Ship SDK',
      notes: 'Verify contracts',
      dueDate: '2026-07-15T10:00:00.000Z',
      assigneeIds: ['ou_assignee'],
      followerIds: ['ou_follower'],
      tasklist: 'tasklist-1',
    }), { taskId: 'task-1', title: 'Ship SDK' });
    await client.updateTask('task-1', {
      title: 'Ship the SDK',
      notes: 'All request shapes verified',
      dueDate: '2026-07-16T10:00:00.000Z',
      assigneeIds: ['ou_assignee_2'],
    });
    await client.completeTask('task-1');
    await client.addTaskToTasklist('tasklist-2', 'task-1');
    await client.removeTaskFromTasklist('tasklist-2', 'task-1');

    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/open-apis/task/v2/tasks',
      data: {
        summary: 'Ship SDK',
        description: 'Verify contracts',
        due: { timestamp: '1784109600000', is_all_day: false },
        members: [
          { id: 'ou_assignee', type: 'user', role: 'assignee' },
          { id: 'ou_follower', type: 'user', role: 'follower' },
        ],
        tasklists: [{ tasklist_guid: 'tasklist-1' }],
      },
    });
    assert.deepEqual(requests[1], {
      method: 'PATCH',
      url: '/open-apis/task/v2/tasks/task-1',
      data: {
        task: {
          summary: 'Ship the SDK',
          description: 'All request shapes verified',
          due: { timestamp: '1784196000000', is_all_day: false },
          members: [{ id: 'ou_assignee_2', type: 'user', role: 'assignee' }],
        },
        update_fields: ['summary', 'description', 'due', 'members'],
      },
    });
    assert.equal(requests[2]?.method, 'PATCH');
    assert.equal(requests[2]?.url, '/open-apis/task/v2/tasks/task-1');
    const completePayload = requests[2]?.data as { task: { completed_at: string }; update_fields: string[] };
    assert.match(completePayload.task.completed_at, /^\d+$/);
    assert.deepEqual(completePayload.update_fields, ['completed_at']);
    assert.deepEqual(requests.slice(3), [
      {
        method: 'POST',
        url: '/open-apis/task/v2/tasks/task-1/add_tasklist',
        data: { tasklist_guid: 'tasklist-2' },
      },
      {
        method: 'POST',
        url: '/open-apis/task/v2/tasks/task-1/remove_tasklist',
        data: { tasklist_guid: 'tasklist-2' },
      },
    ]);
  });

  it('recognizes Task v2 completed_at values instead of relying on a legacy boolean', async () => {
    const { sdkClient } = sdkStub(() => ({ task: { guid: 'task-1', summary: 'Ship SDK', completed_at: '1784109600000' } }));

    assert.deepEqual(
      await new LarkTaskClient(deps(sdkClient)).getTask('task-1'),
      { taskId: 'task-1', title: 'Ship SDK', completed: true },
    );
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

  it('uses the Calendar attendee batch-delete method and a valid UTC recurrence timestamp', async () => {
    const { sdkClient, requests } = sdkStub(request => {
      if (request.method === 'GET') return { items: [{ attendee_id: 'attendee-1', user_id: 'ou_1' }] };
      if (request.url.endsWith('/events')) return { event: { event_id: 'event-1' } };
      return {};
    });
    const client = new LarkCalendarClient(deps(sdkClient));

    await client.createEvent('primary', {
      title: 'Weekly review',
      startTime: '2026-07-15T10:00:00.000Z',
      endTime: '2026-07-15T11:00:00.000Z',
      recurrence: { frequency: 'weekly', until: '2026-07-31T10:00:00.000Z' },
    });
    await client.updateAttendees('primary', 'event-1', { remove: ['ou_1'] });

    const createData = requests[0]?.data as { recurrence: string[] };
    assert.deepEqual(createData.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20260731T100000Z']);
    assert.deepEqual(requests.slice(1), [
      {
        method: 'GET',
        url: '/open-apis/calendar/v4/calendars/primary/events/event-1/attendees',
      },
      {
        method: 'POST',
        url: '/open-apis/calendar/v4/calendars/primary/events/event-1/attendees/batch_delete',
        data: { attendee_ids: ['attendee-1'] },
      },
    ]);
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

  it('removes a duplicate marker from native bullet blocks', async () => {
    const { sdkClient, requests } = sdkStub(request => request.method === 'GET'
      ? { document: { document_id: 'doc-root' } }
      : {});

    await new LarkDocClient(deps(sdkClient)).appendBlock('doc-1', '• Customer risk', 'bullet');

    assert.equal(
      (requests[1]?.data as any).children[0].bullet.elements[0].text_run.content,
      'Customer risk',
    );
  });

  it('creates a table using the documented payload and populates header and body cells', async () => {
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
      data: [['Abhishek', 'Open']],
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
      {
        method: 'POST',
        url: '/open-apis/docx/v1/documents/doc-1/blocks/cell-3/children',
        params: { document_revision_id: -1 },
        data: {
          children: [{ block_type: 2, text: { elements: [{ text_run: { content: 'Abhishek' } }], style: {} } }],
        },
      },
      {
        method: 'POST',
        url: '/open-apis/docx/v1/documents/doc-1/blocks/cell-4/children',
        params: { document_revision_id: -1 },
        data: {
          children: [{ block_type: 2, text: { elements: [{ text_run: { content: 'Open' } }], style: {} } }],
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

  it('retrieves raw document content, paginates blocks, and deletes a child by its parent range', async () => {
    const { sdkClient, requests } = sdkStub(request => {
      if (request.url.endsWith('/raw_content')) return { content: '# Launch notes' };
      if (request.url.endsWith('/documents/doc-1')) return { document: { document_id: 'doc-1', title: 'Launch notes' } };
      if (request.url.endsWith('/blocks')) {
        const params = request.params as { page_token?: string } | undefined;
        return params?.page_token
          ? { items: [{ block_id: 'child-2' }] }
          : { items: [{ block_id: 'root', children: ['child-1'] }], has_more: true, page_token: 'next' };
      }
      return {};
    });
    const client = new LarkDocClient(deps(sdkClient));

    assert.deepEqual(await client.getDoc('doc-1'), {
      document_id: 'doc-1', title: 'Launch notes', content: '# Launch notes',
    });
    assert.deepEqual(await client.listBlocks('doc-1'), [
      { block_id: 'root', children: ['child-1'] },
      { block_id: 'child-2' },
    ]);
    await client.deleteBlock('doc-1', 'child-1');

    const deleteRequest = requests.at(-1);
    assert.deepEqual(deleteRequest, {
      method: 'DELETE',
      url: '/open-apis/docx/v1/documents/doc-1/blocks/root/children/batch_delete',
      params: { document_revision_id: -1 },
      data: { start_index: 0, end_index: 1 },
    });
    const blockRequests = requests.filter(request => request.url.endsWith('/blocks'));
    assert.deepEqual(blockRequests.slice(0, 2).map(request => request.params), [
      { page_size: 500, document_revision_id: -1 },
      { page_size: 500, document_revision_id: -1, page_token: 'next' },
    ]);
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

  it('searches a Base table using its actual primary field when none is provided', async () => {
    const { sdkClient, requests } = sdkStub(request => {
      if (request.method === 'GET') return { items: [{ field_name: 'Customer', is_primary: true }] };
      return { items: [{ record_id: 'rec-1' }] };
    });

    assert.deepEqual(
      await new LarkBaseClient(deps(sdkClient)).searchRecords('app-1', 'tbl-1', 'Divo'),
      [{ record_id: 'rec-1' }],
    );
    assert.deepEqual(requests, [
      {
        method: 'GET',
        url: '/open-apis/bitable/v1/apps/app-1/tables/tbl-1/fields',
        params: { page_size: 100 },
      },
      {
        method: 'POST',
        url: '/open-apis/bitable/v1/apps/app-1/tables/tbl-1/records/search',
        params: { page_size: 20 },
        data: {
          filter: {
            conjunction: 'and',
            conditions: [{ field_name: 'Customer', operator: 'contains', value: ['Divo'] }],
          },
        },
      },
    ]);
  });

  it('uses the installed-app SDK client for native approvals', async () => {
    const { sdkClient, requests } = sdkStub(request => request.method === 'GET'
      ? { approval: { form: { form_content: '[{"id":"reason","type":"input"}]' } } }
      : { instance_code: 'approval-1' });
    const result = await new LarkApprovalClient(deps(sdkClient)).createInstance('leave', { reason: 'Vacation' });

    assert.deepEqual(result, { instanceCode: 'approval-1' });
    assert.deepEqual(requests, [{
      method: 'GET',
      url: '/open-apis/approval/v4/approvals/leave',
    }, {
      method: 'POST',
      url: '/open-apis/approval/v4/instances',
      data: { approval_code: 'leave', form: '[{"id":"reason","type":"input","value":"Vacation"}]' },
    }]);
  });

  it('lists approval detail using the required history window and instance codes', async () => {
    const { sdkClient, requests } = sdkStub(request => {
      if (request.url === '/open-apis/approval/v4/instances') return { instance_code_list: ['approval-1'] };
      return { instance: { instance_code: 'approval-1', approval_code: 'leave', status: 'APPROVED', title: 'Vacation' } };
    });

    assert.deepEqual(
      await new LarkApprovalClient(deps(sdkClient)).listInstances('leave', 10, { startTime: '1', endTime: '2' }),
      [{ instanceCode: 'approval-1', approvalCode: 'leave', status: 'APPROVED', title: 'Vacation' }],
    );
    assert.deepEqual(requests, [
      {
        method: 'GET',
        url: '/open-apis/approval/v4/instances',
        params: { approval_code: 'leave', start_time: '1', end_time: '2', page_size: 10 },
      },
      {
        method: 'GET',
        url: '/open-apis/approval/v4/instances/approval-1',
      },
    ]);
  });

  it('uses a Card 2.0 payload for outbound Lark messages by default', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ message_id: 'msg-1' }));
    const result = await new LarkToolMessagingClient(deps(sdkClient))
      .sendMessage('chat-1', 'Hello');

    assert.deepEqual(result, { messageId: 'msg-1' });
    assert.equal(requests[0]?.method, 'POST');
    assert.equal(requests[0]?.url, '/open-apis/im/v1/messages');
    assert.deepEqual(requests[0]?.params, { receive_id_type: 'chat_id' });
    const data = requests[0]?.data as { receive_id: string; msg_type: string; content: string };
    assert.equal(data.receive_id, 'chat-1');
    assert.equal(data.msg_type, 'interactive');
    const card = JSON.parse(data.content) as { schema: string; body: { elements: Array<{ tag: string; content?: string }> } };
    assert.equal(card.schema, '2.0');
    assert.deepEqual(card.body.elements[0], { tag: 'markdown', content: 'Hello', text_size: 'normal' });
  });

  it('keeps plain text as an explicit outbound opt-out', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ message_id: 'msg-1' }));
    await new LarkToolMessagingClient(deps(sdkClient)).sendMessage('chat-1', 'Hello', { rendering: 'text' });

    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'chat-1', msg_type: 'text', content: '{"text":"Hello"}' },
    });
  });

  it('preserves resolved mentions when it renders a Card 2.0 group message', async () => {
    const { sdkClient, requests } = sdkStub(() => ({ message_id: 'msg-1' }));
    await new LarkToolMessagingClient(deps(sdkClient))
      .mentionMessage('chat-1', '**Please review**', ['ou_reviewer']);

    const data = requests[0]?.data as { msg_type: string; content: string };
    assert.equal(data.msg_type, 'interactive');
    const card = JSON.parse(data.content) as { body: { elements: Array<{ content?: string }> } };
    assert.equal(card.body.elements[0]?.content, '<at id=ou_reviewer></at> **Please review**');
  });

  it('reads plain text from the documented body.content envelope when listing messages', async () => {
    const { sdkClient } = sdkStub(() => ({
      items: [{
        message_id: 'msg-1',
        msg_type: 'text',
        body: { content: '{"text":"The deployment is ready."}' },
        sender: { id: 'ou_sender' },
        create_time: '1784113200000',
      }],
    }));

    const messages = await new LarkToolMessagingClient(deps(sdkClient)).listMessages('oc_1');

    assert.deepEqual(messages, [{
      messageId: 'msg-1',
      text: 'The deployment is ready.',
      senderId: 'ou_sender',
      timestamp: '1784113200000',
    }]);
  });

  it('renders readable Card 2.0 content through bounded history search rather than returning empty text', async () => {
    const { sdkClient, requests } = sdkStub(() => ({
      items: [{
        message_id: 'msg-3',
        msg_type: 'interactive',
        body: {
          content: JSON.stringify({
            schema: '2.0',
            header: { title: { tag: 'plain_text', content: 'Account health' } },
            body: {
              elements: [
                { tag: 'markdown', content: '**Three** escalations need review.' },
                { tag: 'div', text: { tag: 'plain_text', content: 'Owner: Support' } },
              ],
            },
          }),
        },
        sender: { id: 'ou_bot' },
        create_time: '1784113200002',
      }],
    }));

    const messages = await new LarkToolMessagingClient(deps(sdkClient)).searchMessages('oc_1', 'escalations');

    assert.deepEqual(messages, [{
      messageId: 'msg-3',
      text: 'Account health\n**Three** escalations need review.\nOwner: Support',
      senderId: 'ou_bot',
      timestamp: '1784113200002',
    }]);
    assert.deepEqual(requests[0], {
      method: 'GET',
      url: '/open-apis/im/v1/messages',
      params: {
        container_id_type: 'chat',
        container_id: 'oc_1',
        sort_type: 'ByCreateTimeDesc',
        page_size: 50,
      },
    });
  });

  it('uses chat_mode from the chat-list response instead of an undocumented chat_type field', async () => {
    const { sdkClient } = sdkStub(() => ({
      items: [{ chat_id: 'oc_1', name: 'Launch', chat_mode: 'group', member_count: 3 }],
    }));

    assert.deepEqual(await new LarkToolMessagingClient(deps(sdkClient)).listChats(), [{
      chatId: 'oc_1', name: 'Launch', type: 'group', memberCount: 3,
    }]);
  });

});
