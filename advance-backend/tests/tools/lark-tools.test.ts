/**
 * Unit tests for all 6 Lark tool families.
 *
 * Each tool section covers:
 *  - permissionCheck: denied when action not in allowedActionsByTool
 *  - permissionCheck: returns correct action group on success
 *  - execute: happy path (fake client returns data → ok result)
 *  - execute: missing required arg → err(bad_args)
 *  - execute: infra throws → err(upstream_failure), never throws
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeDeniedPerm, makeCtx } from './tool-test.helpers.ts';

import { createLarkTaskTool }     from '../../src/application/orchestration/tools/families/lark-task.tool.ts';
import { createLarkMessagingTool } from '../../src/application/orchestration/tools/families/lark-messaging.tool.ts';
import { createLarkContactsTool }  from '../../src/application/orchestration/tools/families/lark-contacts.tool.ts';
import { createLarkCalendarTool }  from '../../src/application/orchestration/tools/families/lark-calendar.tool.ts';
import { createLarkDocTool }       from '../../src/application/orchestration/tools/families/lark-doc.tool.ts';
import { createLarkBaseTool }      from '../../src/application/orchestration/tools/families/lark-base.tool.ts';
import { createLarkApprovalTool }  from '../../src/application/orchestration/tools/families/lark-approval.tool.ts';

// ─── lark-task ────────────────────────────────────────────────────────────────

describe('larkTask tool', () => {
  const task = { taskId: 'task-1', title: 'Test task', completed: false };

  const fakeClient = {
    createTask:   async () => ({ taskId: 'task-1', title: 'Test task' }),
    updateTask:   async () => {},
    completeTask: async () => {},
    deleteTask:   async () => {},
    listTasks:    async () => [task],
    getTask:      async () => ({ ...task, dueDate: '2025-12-01' }),
  };

  describe('permissionCheck', () => {
    it('denies when larkTask not in allowedActionsByTool', () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const result = tool.permissionCheck({ op: 'create', title: 'x' }, makeDeniedPerm());
      assert.equal(result.ok, false);
      assert.equal((result as any).error.kind, 'permission');
    });

    it('denies create when only read allowed', () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const result = tool.permissionCheck({ op: 'create', title: 'x' }, makeAllowedPerm('larkTask', ['read']));
      assert.equal(result.ok, false);
    });

    it('returns "create" action group for op=create', () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const result = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('larkTask', ['create']));
      assert.equal(result.ok, true);
      assert.equal((result as any).value, 'create');
    });

    it('returns "read" action group for op=list', () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const result = tool.permissionCheck({ op: 'list' }, makeAllowedPerm('larkTask', ['read']));
      assert.equal(result.ok, true);
      assert.equal((result as any).value, 'read');
    });

    it('returns "update" for op=complete', () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const result = tool.permissionCheck({ op: 'complete', taskId: 't1' }, makeAllowedPerm('larkTask', ['update']));
      assert.equal(result.ok, true);
      assert.equal((result as any).value, 'update');
    });

    it('returns "delete" for op=delete', () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const result = tool.permissionCheck({ op: 'delete', taskId: 't1' }, makeAllowedPerm('larkTask', ['delete']));
      assert.equal(result.ok, true);
      assert.equal((result as any).value, 'delete');
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('larkTask', ['read', 'create', 'update', 'delete']);

    it('create: returns ok with taskId on success', async () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create', title: 'Test task' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.taskId, 'task-1');
      assert.equal((r as any).value.success, true);
    });

    it('create: returns bad_args when title missing', async () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('update: returns bad_args when taskId missing', async () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const r = await tool.execute({ op: 'update', title: 'new' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('list: returns ok with data array', async () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, true);
      assert.ok(Array.isArray((r as any).value.data));
    });

    it('complete: returns ok when taskId provided', async () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const r = await tool.execute({ op: 'complete', taskId: 'task-1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: returns ok with task data', async () => {
      const tool = createLarkTaskTool({ client: fakeClient });
      const r = await tool.execute({ op: 'get', taskId: 'task-1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('infra throws → upstream_failure, never throws', async () => {
      const throwing = { ...fakeClient, createTask: async () => { throw new Error('API down'); } };
      const tool = createLarkTaskTool({ client: throwing });
      const r = await tool.execute({ op: 'create', title: 'x' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── lark-messaging ───────────────────────────────────────────────────────────

describe('larkMessaging tool', () => {
  const fakeClient = {
    sendMessage:  async (_chatId: string, _text: string) => ({ messageId: 'msg-1' }),
    replyMessage: async (_msgId: string, _text: string) => ({ messageId: 'msg-2' }),
    listMessages: async () => [{ messageId: 'msg-1', text: 'hi', senderId: 'u1', timestamp: 'ts' }],
    getMessage:   async () => ({ messageId: 'msg-1', text: 'hi', senderId: 'u1', timestamp: 'ts' }),
  };

  describe('permissionCheck', () => {
    it('denies send when not allowed', () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'send' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });

    it('returns "send" for op=send', () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'send' }, makeAllowedPerm('larkMessaging', ['send']));
      assert.equal(r.ok, true);
      assert.equal((r as any).value, 'send');
    });

    it('returns "read" for op=list', () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'list' }, makeAllowedPerm('larkMessaging', ['read']));
      assert.equal(r.ok, true);
      assert.equal((r as any).value, 'read');
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('larkMessaging', ['read', 'send']);

    it('send: ok with messageId', async () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = await tool.execute({ op: 'send', chatId: 'chat-1', text: 'hello' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.messageId, 'msg-1');
    });

    it('send: bad_args when chatId missing', async () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = await tool.execute({ op: 'send', text: 'hi' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('send: defaults to locked current chat for scheduled delivery runs', async () => {
      let capturedChatId: string | null = null;
      const client = {
        ...fakeClient,
        sendMessage: async (chatId: string, _text: string) => {
          capturedChatId = chatId;
          return { messageId: 'msg-locked' };
        },
      };
      const lockedCtx = makeCtx('larkMessaging', ['read', 'send'], {
        chatId: 'oc_locked_dm_chat',
        deliveryMode: 'current_chat_only',
      });
      const tool = createLarkMessagingTool({ client });
      const r = await tool.execute({ op: 'send', text: 'hi' }, lockedCtx);
      assert.equal(r.ok, true);
      assert.equal(capturedChatId, 'oc_locked_dm_chat');
      assert.equal((r as any).value.messageId, 'msg-locked');
    });

    it('send: rejects explicit different chat when scheduled delivery is locked', async () => {
      const lockedCtx = makeCtx('larkMessaging', ['read', 'send'], {
        chatId: 'oc_locked_dm_chat',
        deliveryMode: 'current_chat_only',
      });
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = await tool.execute({ op: 'send', chatId: 'oc_other_group', text: 'hi' }, lockedCtx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
      assert.match((r as any).error.message, /locked to the current chat/i);
    });

    it('reply: ok with messageId', async () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = await tool.execute({ op: 'reply', messageId: 'msg-1', text: 'pong' }, ctx);
      assert.equal(r.ok, true);
    });

    it('send_dm: rejects when scheduled delivery is locked to current chat', async () => {
      const lockedCtx = makeCtx('larkMessaging', ['read', 'send'], {
        chatId: 'oc_locked_dm_chat',
        deliveryMode: 'current_chat_only',
      });
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = await tool.execute({ op: 'send_dm', text: 'hello', recipientName: 'Abhishek' }, lockedCtx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
      assert.match((r as any).error.message, /locked to the current chat/i);
    });

    it('list: ok with data array', async () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = await tool.execute({ op: 'list', chatId: 'chat-1' }, ctx);
      assert.equal(r.ok, true);
      assert.ok(Array.isArray((r as any).value.data));
    });

    it('get: bad_args when messageId missing', async () => {
      const tool = createLarkMessagingTool({ client: fakeClient });
      const r = await tool.execute({ op: 'get' }, ctx);
      assert.equal(r.ok, false);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = { ...fakeClient, sendMessage: async () => { throw new Error('err'); } };
      const tool = createLarkMessagingTool({ client: throwing });
      const r = await tool.execute({ op: 'send', chatId: 'c', text: 't' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── lark-contacts ───────────────────────────────────────────────────────────

describe('larkContacts tool', () => {
  const peopleResolver = {
    resolve: async () => ({
      resolved: [{ openId: 'ou_1', displayName: 'Anish Suman', email: 'anish@example.com' }],
      ambiguous: [],
      notFound: [],
    }),
  };
  const contactsClient = {
    searchUsers: async () => [{
      openId: 'ou_1',
      displayName: 'Anish Suman',
      enterpriseEmail: 'anish@example.com',
      department: 'Engineering',
    }],
    searchDepartments: async () => [{ departmentId: 'od_1', name: 'Engineering' }],
    listDepartmentMembers: async () => [{ openId: 'ou_1', displayName: 'Anish Suman' }],
  };

  describe('permissionCheck', () => {
    it('returns "read" for lookup', () => {
      const tool = createLarkContactsTool({ peopleResolver, contactsClient });
      const r = tool.permissionCheck({ op: 'lookup', query: 'anish' }, makeAllowedPerm('larkContacts', ['read']));
      assert.equal(r.ok, true);
      assert.equal((r as any).value, 'read');
    });

    it('denies when read is not allowed', () => {
      const tool = createLarkContactsTool({ peopleResolver, contactsClient });
      const r = tool.permissionCheck({ op: 'search', query: 'anish' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('larkContacts', ['read']);

    it('lookup: returns found contacts from resolver', async () => {
      const tool = createLarkContactsTool({ peopleResolver, contactsClient });
      const r = await tool.execute({ op: 'lookup', query: 'anish' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.data.found[0].openId, 'ou_1');
    });

    it('search: returns live users', async () => {
      const tool = createLarkContactsTool({ peopleResolver, contactsClient });
      const r = await tool.execute({ op: 'search', query: 'anish', excludeExternalUsers: true }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.data.users[0].department, 'Engineering');
    });

    it('get: requires openIds', async () => {
      const tool = createLarkContactsTool({ peopleResolver, contactsClient });
      const r = await tool.execute({ op: 'get' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });
  });
});

// ─── lark-calendar ────────────────────────────────────────────────────────────

describe('larkCalendar tool', () => {
  const fakeClient = {
    listEvents:   async () => [{ eventId: 'ev-1', title: 'Standup' }],
    getEvent:     async () => ({ eventId: 'ev-1', title: 'Standup' }),
    createEvent:  async () => ({ eventId: 'ev-2' }),
    updateEvent:  async () => {},
    deleteEvent:  async () => {},
  };

  describe('permissionCheck', () => {
    it('denies create when only read allowed', () => {
      const tool = createLarkCalendarTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('larkCalendar', ['read']));
      assert.equal(r.ok, false);
    });

    it('returns "read" for op=list', () => {
      const tool = createLarkCalendarTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'list' }, makeAllowedPerm('larkCalendar', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "delete" for op=delete', () => {
      const tool = createLarkCalendarTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'delete', eventId: 'x' }, makeAllowedPerm('larkCalendar', ['delete']));
      assert.equal((r as any).value, 'delete');
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('larkCalendar', ['read', 'create', 'update', 'delete']);

    it('list: ok with array', async () => {
      const tool = createLarkCalendarTool({ client: fakeClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, true);
    });

    it('create: ok when required fields present', async () => {
      const tool = createLarkCalendarTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create', title: 'Sync', startTime: '2025-01-01T10:00:00Z', endTime: '2025-01-01T11:00:00Z' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.eventId, 'ev-2');
    });

    it('create: bad_args when title missing', async () => {
      const tool = createLarkCalendarTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create', startTime: 'x', endTime: 'y' }, ctx);
      assert.equal(r.ok, false);
    });

    it('get: bad_args when eventId missing', async () => {
      const tool = createLarkCalendarTool({ client: fakeClient });
      const r = await tool.execute({ op: 'get' }, ctx);
      assert.equal(r.ok, false);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = { ...fakeClient, listEvents: async () => { throw new Error('down'); } };
      const tool = createLarkCalendarTool({ client: throwing });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── lark-doc ─────────────────────────────────────────────────────────────────

describe('larkDoc tool', () => {
  const fakeClient = {
    getDoc:       async () => ({ title: 'Doc', content: '...' }),
    createDoc:    async () => ({ docToken: 'doc-abc', url: 'https://tenant.larksuite.com/docx/doc-abc', docUrl: 'https://tenant.larksuite.com/docx/doc-abc' }),
    createMarkdownDoc: async () => ({ docToken: 'doc-md', url: 'https://tenant.larksuite.com/docx/doc-md', docUrl: 'https://tenant.larksuite.com/docx/doc-md' }),
    appendBlock:  async () => {},
    appendMarkdown: async () => {},
    listBlocks:   async () => [{ type: 'text', content: 'hello' }],
  };

  describe('permissionCheck', () => {
    it('returns "read" for op=get', () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'get' }, makeAllowedPerm('larkDoc', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "create" for op=create', () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('larkDoc', ['create']));
      assert.equal((r as any).value, 'create');
    });

    it('returns "update" for op=append_block', () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'append_block' }, makeAllowedPerm('larkDoc', ['update']));
      assert.equal((r as any).value, 'update');
    });

    it('denies when not allowed', () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'create' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('larkDoc', ['read', 'create', 'update']);

    it('get: ok with data', async () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = await tool.execute({ op: 'get', docToken: 'doc-abc' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: bad_args when docToken missing', async () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = await tool.execute({ op: 'get' }, ctx);
      assert.equal(r.ok, false);
    });

    it('create: ok with docToken', async () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create', title: 'New Doc' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.docToken, 'doc-abc');
      assert.equal((r as any).value.url, 'https://tenant.larksuite.com/docx/doc-abc');
    });

    it('create_markdown: ok with docToken and URL', async () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create_markdown', title: 'New Doc', content: '# Heading\n\nBody' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.docToken, 'doc-md');
      assert.equal((r as any).value.docUrl, 'https://tenant.larksuite.com/docx/doc-md');
    });

    it('create: bad_args when title missing', async () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create' }, ctx);
      assert.equal(r.ok, false);
    });

    it('append_block: bad_args when docToken missing', async () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = await tool.execute({ op: 'append_block', content: 'hello' }, ctx);
      assert.equal(r.ok, false);
    });

    it('append_markdown: bad_args when content missing', async () => {
      const tool = createLarkDocTool({ client: fakeClient });
      const r = await tool.execute({ op: 'append_markdown', docToken: 'doc-abc' }, ctx);
      assert.equal(r.ok, false);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = { ...fakeClient, createDoc: async () => { throw new Error('err'); } };
      const tool = createLarkDocTool({ client: throwing });
      const r = await tool.execute({ op: 'create', title: 'x' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── lark-base ────────────────────────────────────────────────────────────────

describe('larkBase tool', () => {
  const fakeClient = {
    listRecords:   async () => [{ id: 'r1' }],
    getRecord:     async () => ({ id: 'r1' }),
    createRecord:  async () => ({ recordId: 'r-new' }),
    updateRecord:  async () => {},
    deleteRecord:  async () => {},
    searchRecords: async () => [{ id: 'r2' }],
  };

  describe('permissionCheck', () => {
    it('returns "read" for op=list_records', () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'list_records' }, makeAllowedPerm('larkBase', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "delete" for op=delete_record', () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'delete_record' }, makeAllowedPerm('larkBase', ['delete']));
      assert.equal((r as any).value, 'delete');
    });

    it('denies when action not allowed', () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'create_record' }, makeAllowedPerm('larkBase', ['read']));
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('larkBase', ['read', 'create', 'update', 'delete']);

    it('bad_args when appToken or tableId missing', async () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = await tool.execute({ op: 'list_records' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('list_records: ok with data', async () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = await tool.execute({ op: 'list_records', appToken: 'app1', tableId: 'tbl1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('create_record: ok with recordId', async () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create_record', appToken: 'app1', tableId: 'tbl1', fields: { name: 'Alice' } }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.recordId, 'r-new');
    });

    it('create_record: bad_args when fields missing', async () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create_record', appToken: 'app1', tableId: 'tbl1' }, ctx);
      assert.equal(r.ok, false);
    });

    it('search_records: bad_args when filter missing', async () => {
      const tool = createLarkBaseTool({ client: fakeClient });
      const r = await tool.execute({ op: 'search_records', appToken: 'app1', tableId: 'tbl1' }, ctx);
      assert.equal(r.ok, false);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = { ...fakeClient, listRecords: async () => { throw new Error('err'); } };
      const tool = createLarkBaseTool({ client: throwing });
      const r = await tool.execute({ op: 'list_records', appToken: 'app1', tableId: 'tbl1' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── lark-approval ────────────────────────────────────────────────────────────

describe('larkApproval tool', () => {
  const fakeClient = {
    listInstances:   async () => [{ instanceCode: 'inst-1' }],
    getInstance:     async () => ({ instanceCode: 'inst-1', status: 'PENDING' }),
    createInstance:  async () => ({ instanceCode: 'inst-new' }),
  };

  describe('permissionCheck', () => {
    it('returns "read" for op=list', () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'list' }, makeAllowedPerm('larkApproval', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "create" for op=create', () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('larkApproval', ['create']));
      assert.equal((r as any).value, 'create');
    });

    it('denies create when only read allowed', () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('larkApproval', ['read']));
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('larkApproval', ['read', 'create']);

    it('bad_args when approvalCode missing', async () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('list: ok with instances', async () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = await tool.execute({ op: 'list', approvalCode: 'apv-1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: bad_args when instanceCode missing', async () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = await tool.execute({ op: 'get', approvalCode: 'apv-1' }, ctx);
      assert.equal(r.ok, false);
    });

    it('get: ok with instance data', async () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = await tool.execute({ op: 'get', approvalCode: 'apv-1', instanceCode: 'inst-1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('create: ok with instanceCode', async () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create', approvalCode: 'apv-1', formValues: { reason: 'leave' } }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.instanceCode, 'inst-new');
    });

    it('create: bad_args when formValues missing', async () => {
      const tool = createLarkApprovalTool({ client: fakeClient });
      const r = await tool.execute({ op: 'create', approvalCode: 'apv-1' }, ctx);
      assert.equal(r.ok, false);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = { ...fakeClient, listInstances: async () => { throw new Error('err'); } };
      const tool = createLarkApprovalTool({ client: throwing });
      const r = await tool.execute({ op: 'list', approvalCode: 'apv-1' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});
