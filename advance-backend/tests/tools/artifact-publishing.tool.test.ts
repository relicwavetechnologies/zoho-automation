import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactPublishingTool } from '../../src/application/tools/families/artifact-publishing.tool.ts';
import { ArtifactPublishingService } from '../../src/application/publishing/artifact-publishing.service.ts';
import { err, ok } from '../../src/shared/result.ts';
import { InfraError, ToolError } from '../../src/shared/errors.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

const artifact = {
  artifactId: 'reports/q4',
  title: 'Q4 report',
  mime: 'text/html' as const,
  body: '<p>Q4 report body only</p>',
  version: 1,
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
};

function makeTool(overrides: {
  artifact?: typeof artifact | null;
  publisherResult?: ReturnType<typeof ok> | ReturnType<typeof err>;
  markResult?: ReturnType<typeof ok> | ReturnType<typeof err>;
} = {}) {
  const calls = { publish: undefined as any, mark: undefined as any };
  const artifacts = {
    get: async () => overrides.artifact === null ? ok(null) : ok(overrides.artifact ?? artifact),
    markPublished: async (_scope: unknown, publication: unknown) => {
      calls.mark = publication;
      return overrides.markResult ?? ok({ ...artifact, publishedUrl: 'https://published.example/', preview: '' });
    },
  };
  const publisher = {
    publish: async (request: unknown) => {
      calls.publish = request;
      return overrides.publisherResult ?? ok({ url: 'https://published.example/', deploymentId: 'dpl-1' });
    },
  };
  return {
    tool: createArtifactPublishingTool({
      service: new ArtifactPublishingService({ artifacts, publisher }),
    }),
    calls,
  };
}

describe('artifact publishing tool', () => {
  it('requires the create permission', () => {
    const { tool } = makeTool();
    assert.equal(tool.permissionCheck({ artifactId: 'reports/q4' }, makeDeniedPerm()).ok, false);
    assert.deepEqual(
      tool.permissionCheck({ artifactId: 'reports/q4' }, makeAllowedPerm('artifactPublish', ['create'])),
      { ok: true, value: 'create' },
    );
  });

  it('accepts only an existing artifact id, never a body or title', () => {
    const { tool } = makeTool();
    assert.equal(tool.argsSchema.safeParse({ artifactId: 'reports/q4' }).success, true);
    assert.equal(tool.argsSchema.safeParse({ artifactId: 'reports/q4', body: '<p>new</p>' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ artifactId: 'reports/q4', title: 'new title' }).success, false);
  });

  it('publishes owned HTML without a gate and returns only the URL', async () => {
    const { tool, calls } = makeTool();
    const result = await tool.execute({ artifactId: 'reports/q4' }, makeCtx('artifactPublish', ['create'], { channel: 'web' }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.url, 'https://published.example/');
    assert.deepEqual(result.value, { url: 'https://published.example/' });
    assert.equal(calls.publish.slug, 'divo-artifact-reports-q4');
    assert.equal(calls.publish.title, 'Q4 report');
    assert.match(calls.publish.html, /<p>Q4 report body only<\/p>/);
    assert.equal(calls.mark.publishedUrl, result.value.url);
    assert.equal(calls.mark.publishDeploymentId, 'dpl-1');
    assert.equal(calls.mark.publishGateHash, null);
    assert.equal(tool.resultSchema.safeParse(result.value).success, true);
  });

  it('refuses markdown without publishing', async () => {
    const { tool, calls } = makeTool({ artifact: { ...artifact, mime: 'text/markdown' } });
    const result = await tool.execute({ artifactId: 'reports/q4' }, makeCtx('artifactPublish', ['create']));

    assert.equal(result.ok, false);
    assert.ok(result.error instanceof ToolError);
    assert.equal(result.error.payload.reason, 'bad_args');
    assert.match(result.error.message, /HTML artifacts/);
    assert.equal(calls.publish, undefined);
  });

  it('does not turn a publisher failure into a success', async () => {
    const failure = new InfraError({ layer: 'http', op: 'vercel.deployments.create', cause: new Error('nope'), message: 'Vercel is unavailable.' });
    const { tool, calls } = makeTool({ publisherResult: err(failure) });
    const result = await tool.execute({ artifactId: 'reports/q4' }, makeCtx('artifactPublish', ['create']));

    assert.equal(result.ok, false);
    assert.equal(result.error.payload.reason, 'upstream_failure');
    assert.equal(result.error.message, 'Vercel is unavailable.');
    assert.equal(calls.mark, undefined);
  });
});
