import { z } from 'zod';
import type { Tool } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import { asToolId } from '../../../shared/ids';
import { ARTIFACT_LIMITS } from '../../../domain/artifact/artifact';
import type {
  ArtifactPublishingFailure,
  ArtifactPublishingService,
} from '../../publishing/artifact-publishing.service';

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
  readonly service: ArtifactPublishingService;
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
      const published = await deps.service.publish({
        scope,
        publishedAt: ctx.clock.now().toISOString(),
      });
      if (!published.ok) return err(toolFailure(published.error));
      return ok({ url: published.value.url });
    },
  };
}

function toolFailure(failure: ArtifactPublishingFailure): ToolError {
  if (failure.kind === 'not_found' || failure.kind === 'unsupported_mime') {
    return new ToolError({ toolId: TOOL_ID, reason: 'bad_args', message: failure.message });
  }
  if (failure.kind === 'partial') {
    return new ToolError({ toolId: TOOL_ID, reason: 'partial', message: failure.message, cause: failure.error });
  }
  return new ToolError({
    toolId: TOOL_ID,
    reason: 'upstream_failure',
    message: failure.error.message,
    cause: failure.error,
  });
}
