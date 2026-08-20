import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InfraError } from '../../src/shared/errors.ts';
import {
  VercelPublisher,
  VercelPublisherError,
} from '../../src/infrastructure/publishing/vercel-publisher.ts';

type FetchCall = { url: string; init: RequestInit };

function request() {
  return { slug: 'hello-report', title: 'Hello report', html: '<h1>hello</h1>' };
}

function makePublisher(
  response: Response | (() => Promise<Response>),
  options: { token?: string; projectName?: string; teamId?: string } = {},
): { publisher: VercelPublisher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof response === 'function' ? response() : response;
  };
  return {
    publisher: new VercelPublisher({
      token: options.token ?? 'token-that-must-not-leak',
      projectName: options.projectName ?? 'divo-artifacts',
      teamId: options.teamId,
      fetchImpl,
    }),
    calls,
  };
}

function failureOf(result: Awaited<ReturnType<VercelPublisher['publish']>>): VercelPublisherError {
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof InfraError);
  assert.ok(result.error.payload.cause instanceof VercelPublisherError);
  return result.error.payload.cause;
}

describe('VercelPublisher', () => {
  it('creates a production deployment with inline index.html', async () => {
    const { publisher, calls } = makePublisher(new Response(JSON.stringify({
      id: 'dpl_123',
      url: 'hello-report-abc.vercel.app',
    }), { status: 200 }));

    const result = await publisher.publish(request());

    assert.deepEqual(result, {
      ok: true,
      value: {
        url: 'https://hello-report-abc.vercel.app/',
        deploymentId: 'dpl_123',
      },
    });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    const url = new URL(call.url);
    assert.equal(url.origin, 'https://api.vercel.com');
    assert.equal(url.pathname, '/v13/deployments');
    assert.equal(url.searchParams.get('teamId'), null);
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, {
      Authorization: 'Bearer token-that-must-not-leak',
      'Content-Type': 'application/json',
    });
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      name: 'hello-report',
      project: 'divo-artifacts',
      files: [{ file: 'index.html', data: '<h1>hello</h1>' }],
      projectSettings: { framework: null },
      target: 'production',
    });
  });

  it('adds the team query only when configured', async () => {
    const { publisher, calls } = makePublisher(
      new Response(JSON.stringify({ id: 'dpl_team', url: 'team-report.vercel.app' }), { status: 200 }),
      { teamId: 'team_123' },
    );

    await publisher.publish(request());

    assert.equal(new URL(calls[0]!.url).searchParams.get('teamId'), 'team_123');
  });

  it('fails without a token and never makes a request', async () => {
    const { publisher, calls } = makePublisher(
      new Response(JSON.stringify({ id: 'never' }), { status: 200 }),
      { token: '' },
    );

    const result = await publisher.publish(request());
    const failure = failureOf(result);

    assert.equal(failure.code, 'not_configured');
    assert.equal(failure.retryable, false);
    assert.match(failure.message, /VERCEL_TOKEN/);
    assert.equal(failure.message.includes('token-that-must-not-leak'), false);
    assert.equal(calls.length, 0);
  });

  it('fails without a project name and names the missing variable', async () => {
    const { publisher } = makePublisher(
      new Response(JSON.stringify({ id: 'never' }), { status: 200 }),
      { projectName: '' },
    );

    const failure = failureOf(await publisher.publish(request()));

    assert.equal(failure.code, 'not_configured');
    assert.match(failure.message, /VERCEL_PROJECT_NAME/);
  });

  it('preserves a Vercel 4xx message without marking it retryable', async () => {
    const { publisher } = makePublisher(new Response(JSON.stringify({
      error: { code: 'forbidden', message: 'The token is not allowed to deploy this project' },
    }), { status: 403 }));

    const failure = failureOf(await publisher.publish(request()));

    assert.equal(failure.code, 'upstream_4xx');
    assert.equal(failure.status, 403);
    assert.equal(failure.retryable, false);
    assert.equal(failure.message, 'The token is not allowed to deploy this project');
  });

  it('marks a Vercel 5xx message retryable', async () => {
    const { publisher } = makePublisher(new Response(JSON.stringify({
      error: { message: 'Deployment service unavailable' },
    }), { status: 503 }));

    const failure = failureOf(await publisher.publish(request()));

    assert.equal(failure.code, 'upstream_5xx');
    assert.equal(failure.status, 503);
    assert.equal(failure.retryable, true);
    assert.equal(failure.message, 'Deployment service unavailable');
  });

  it('marks transport failures retryable without exposing the caught error', async () => {
    const { publisher } = makePublisher(async () => { throw new Error('socket reset'); });

    const failure = failureOf(await publisher.publish(request()));

    assert.equal(failure.code, 'transport');
    assert.equal(failure.retryable, true);
    assert.equal(failure.message, 'Vercel deployment request failed.');
    assert.equal(failure.message.includes('socket reset'), false);
  });

  it('rejects a successful response without an HTTPS URL', async () => {
    const { publisher } = makePublisher(new Response(JSON.stringify({ id: 'dpl_bad', url: 'http://unsafe.example' }), { status: 200 }));

    const failure = failureOf(await publisher.publish(request()));

    assert.equal(failure.code, 'invalid_response');
    assert.equal(failure.retryable, true);
  });
});
