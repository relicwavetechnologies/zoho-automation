import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkCalendarClient } from '../../src/infrastructure/channels/lark/clients/lark-calendar.client.ts';
import { LarkApiError } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import { TOKEN_RESPONSE, buildMockFetch, errorMock } from '../helpers/mock-fetch.ts';

const DEPS = { appId: 'app1', appSecret: 'secret1' };
const TOKEN_HANDLER = { match: (url: string) => url.includes('tenant_access_token'), response: TOKEN_RESPONSE };
const CAL_ID = 'primary';

describe('LarkCalendarClient', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ── listEvents ────────────────────────────────────────────────────────────

  describe('listEvents', () => {
    it('GETs events and returns normalized array', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/events'),
          response: {
            code: 0,
            data: {
              items: [
                { event_id: 'ev1', summary: 'Team standup', start_time: { timestamp: '1700000000' }, end_time: { timestamp: '1700001800' } },
                { event_id: 'ev2', summary: 'Review', start_time: { timestamp: '1700010000' }, end_time: { timestamp: '1700013600' } },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      const events = await client.listEvents(CAL_ID) as Array<Record<string, unknown>>;

      assert.equal(events.length, 2);
      assert.equal(events[0]?.['eventId'], 'ev1');
      assert.equal(events[0]?.['summary'], 'Team standup');
      assert.equal(events[1]?.['eventId'], 'ev2');
    });

    it('passes page_size query param', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      await client.listEvents(CAL_ID, 15);

      const apiCall = calls.find(c => c.url.includes('page_size=15'));
      assert.ok(apiCall, 'should pass page_size param');
    });

    it('URL-encodes calendarId in path', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      await client.listEvents('cal/special&id');

      const apiCall = calls.find(c => c.url.includes('calendar/v4'));
      assert.ok(apiCall?.url.includes('cal%2Fspecial%26id'), 'should URL-encode calendarId');
    });

    it('returns empty array when no items', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      const events = await client.listEvents(CAL_ID);
      assert.deepEqual(events, []);
    });
  });

  // ── getEvent ──────────────────────────────────────────────────────────────

  describe('getEvent', () => {
    it('GETs a single event by id', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/events/ev-99'),
          response: {
            code: 0,
            data: {
              event: { event_id: 'ev-99', summary: 'All-hands', start_time: { timestamp: '1700000000' } },
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      const event = await client.getEvent(CAL_ID, 'ev-99') as Record<string, unknown>;

      assert.equal(event['eventId'], 'ev-99');
      assert.equal(event['summary'], 'All-hands');
    });

    it('throws LarkApiError when event not found', async () => {
      globalThis.fetch = errorMock('event not found', 1502307);
      const client = new LarkCalendarClient(DEPS);
      await assert.rejects(() => client.getEvent(CAL_ID, 'missing'), LarkApiError);
    });
  });

  // ── createEvent ───────────────────────────────────────────────────────────

  describe('createEvent', () => {
    it('POSTs event and returns eventId', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/events'),
          response: { code: 0, data: { event: { event_id: 'new-ev-1', summary: 'Q1 Planning' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      const result = await client.createEvent(CAL_ID, {
        title: 'Q1 Planning',
        startTime: '2025-01-10T09:00:00Z',
        endTime: '2025-01-10T10:00:00Z',
      });

      assert.equal(result.eventId, 'new-ev-1');
    });

    it('converts ISO times to unix timestamps in body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/events'),
          response: { code: 0, data: { event: { event_id: 'ev1' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      await client.createEvent(CAL_ID, {
        title: 'Meeting',
        startTime: '2025-06-01T10:00:00Z',
        endTime: '2025-06-01T11:00:00Z',
      });

      const apiCall = calls.find(c => c.method === 'POST' && !c.url.includes('tenant_access_token'));
      const body = apiCall?.body as Record<string, unknown>;
      const startTime = body?.['start_time'] as Record<string, unknown>;
      assert.ok(startTime?.['timestamp'], 'should have timestamp');
      assert.equal(startTime['timezone'], 'UTC');
    });

    it('includes attendees when provided', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/events'),
          response: { code: 0, data: { event: { event_id: 'ev1' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      await client.createEvent(CAL_ID, {
        title: 'Meeting',
        startTime: '2025-06-01T10:00:00Z',
        endTime: '2025-06-01T11:00:00Z',
        attendeeIds: ['uid1', 'uid2'],
      });

      const apiCall = calls.find(c => c.method === 'POST' && !c.url.includes('tenant_access_token'));
      const body = apiCall?.body as Record<string, unknown>;
      const attendees = body?.['attendees'] as unknown[];
      assert.equal(attendees?.length, 2);
    });
  });

  // ── updateEvent ───────────────────────────────────────────────────────────

  describe('updateEvent', () => {
    it('PATCHes the event', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: (url, m) => m === 'PATCH', response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      await client.updateEvent(CAL_ID, 'ev-1', { summary: 'Updated title' });

      const apiCall = calls.find(c => c.method === 'PATCH');
      assert.ok(apiCall?.url.includes('ev-1'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body?.['summary'], 'Updated title');
    });
  });

  // ── deleteEvent ───────────────────────────────────────────────────────────

  describe('deleteEvent', () => {
    it('sends DELETE to the event URL', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: (url, m) => m === 'DELETE', response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkCalendarClient(DEPS);
      await client.deleteEvent(CAL_ID, 'ev-del');

      const apiCall = calls.find(c => c.method === 'DELETE');
      assert.ok(apiCall?.url.includes('ev-del'));
    });

    it('throws on API error', async () => {
      globalThis.fetch = errorMock('calendar event not found', 1502307);
      const client = new LarkCalendarClient(DEPS);
      await assert.rejects(() => client.deleteEvent(CAL_ID, 'gone'), LarkApiError);
    });
  });
});
