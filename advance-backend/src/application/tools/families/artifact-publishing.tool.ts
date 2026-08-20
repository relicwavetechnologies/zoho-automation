import { z } from 'zod';
import type { Tool } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError, type InfraError } from '../../../shared/errors';
import { asToolId } from '../../../shared/ids';
import type { ArtifactRepoPort } from '../../../infrastructure/persistence/artifact.repository';
import { ARTIFACT_LIMITS } from '../../../domain/artifact/artifact';
import type { PublishedDocumentPort } from '../../publishing/published-document.port';
import { buildDocument } from '../../../domain/artifact/document';

const TOOL_ID = 'artifactPublish' as const;

const ArgsSchema = z.object({
  artifactId: z.string().trim().min(1).max(ARTIFACT_LIMITS.maxIdChars),
}).strict();

const ResultSchema = z.object({
  url: z.string().url(),
}).strict();

type Args = z.infer<typeof ArgsSchema>;
type ToolResult = z.infer<typeof ResultSchema>;

export interface ArtifactPublishingToolDeps {
  readonly artifacts: Pick<ArtifactRepoPort, 'get' | 'markPublished'>;
  readonly publisher: PublishedDocumentPort;
}

export function createArtifactPublishingTool(
  deps: ArtifactPublishingToolDeps,
): Tool<Args, ToolResult> {
  return {
    id: asToolId(TOOL_ID),
    family: 'context',
    actionGroups: new Set(['create']),
    argsSchema: ArgsSchema,
    resultSchema: ResultSchema,
    description: 'Publish an HTML artifact as an unprotected link.',
    parameterDocs: '- artifactId: The existing HTML artifact id to publish',
    permissionCheck(_args, perm) {
      const allowed = perm.allowedActionsByTool.get(asToolId(TOOL_ID))?.has('create') ?? false;
      return allowed
        ? ok('create')
        : err(new PermissionError({
          toolId: TOOL_ID,
          action: 'create',
          reason: 'not_allowed',
          message: 'You do not have permission to publish artifacts.',
        }));
    },
    async execute(args, ctx): Promise<Result<ToolResult, ToolError>> {
      const scope = {
        companyId: ctx.runContext.companyId,
        userId: ctx.runContext.userId,
        artifactId: args.artifactId,
      };
      const found = await deps.artifacts.get(scope);
      if (!found.ok) return err(infraFailure(found.error));
      if (!found.value) {
        return err(new ToolError({
          toolId: TOOL_ID,
          reason: 'bad_args',
          message: 'That artifact does not exist or is not yours.',
        }));
      }
      if (found.value.mime !== 'text/html') {
        return err(new ToolError({
          toolId: TOOL_ID,
          reason: 'bad_args',
          message: 'Only HTML artifacts can be published.',
        }));
      }

      const published = await deps.publisher.publish({
        slug: slugFor(found.value.artifactId),
        title: found.value.title,
        html: buildDocument(found.value.body, 'light', 'standalone', {
          title: found.value.title,
        }),
      });
      if (!published.ok) return err(infraFailure(published.error));

      const saved = await deps.artifacts.markPublished(scope, {
        publishedUrl: published.value.url,
        publishedAt: ctx.clock.now().toISOString(),
        publishGateHash: null,
        publishDeploymentId: published.value.deploymentId,
      });
      if (!saved.ok) {
        return err(new ToolError({
          toolId: TOOL_ID,
          reason: 'partial',
          message: 'The page was published, but Divo could not save its publication record. The link was not returned.',
          cause: saved.error,
        }));
      }

      return ok({ url: published.value.url });
    },
  };
}

function slugFor(artifactId: string): string {
  const slug = artifactId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `divo-artifact-${slug || 'document'}`;
}

function infraFailure(error: InfraError): ToolError {
  return new ToolError({
    toolId: TOOL_ID,
    reason: 'upstream_failure',
    message: error.message,
    cause: error,
  });
}
