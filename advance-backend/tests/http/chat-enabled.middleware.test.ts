import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { createRequireChatEnabled } from '../../src/http/desktop/web-chat-access.middleware.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
} as any;

function invoke(check: () => Promise<boolean>, locals: Record<string, unknown> = {
  companyId: 'co-1', userId: 'u-1',
}) {
  return new Promise<{ status: number; body: any; nextCalls: number }>(resolve => {
    let status = 200;
    let nextCalls = 0;
    const req = { path: '/runs' } as Request;
    const res = {
      locals,
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body, nextCalls }); return this; },
    } as unknown as Response;
    const next: NextFunction = () => {
      nextCalls += 1;
      resolve({ status, body: null, nextCalls });
    };
    createRequireChatEnabled({ chatEnabledFor: check, logger: noopLogger })(req, res, next);
  });
}

describe('web chat access gate', () => {
  it('passes an explicitly enabled department', async () => {
    const result = await invoke(async () => true);
    assert.equal(result.nextCalls, 1);
    assert.equal(result.status, 200);
  });

  it('refuses a department whose chat is disabled', async () => {
    const result = await invoke(async () => false);
    assert.equal(result.nextCalls, 0);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'chat_not_enabled');
  });

  it('fails closed when the entitlement lookup is unavailable', async () => {
    const result = await invoke(async () => { throw new Error('database unavailable'); });
    assert.equal(result.nextCalls, 0);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'chat_availability_unavailable');
  });

  it('fails closed when authenticated identity context is missing', async () => {
    const result = await invoke(async () => true, {});
    assert.equal(result.nextCalls, 0);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'chat_availability_unavailable');
  });
});
