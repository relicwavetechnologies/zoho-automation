import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import type { InfraError } from '../../shared/errors';
import type {
  ArtifactRepoPort,
  ArtifactScope,
} from '../../infrastructure/persistence/artifact.repository';
import { buildDocument } from '../../domain/artifact/document';
import type { PublishedDocumentPort } from './published-document.port';

export type ArtifactPublishingFailure =
  | { readonly kind: 'not_found'; readonly message: string }
  | { readonly kind: 'unsupported_mime'; readonly message: string }
  | { readonly kind: 'upstream'; readonly error: InfraError }
  | { readonly kind: 'partial'; readonly message: string; readonly error: InfraError };

export interface PublishArtifactInput {
  readonly scope: ArtifactScope & { readonly artifactId: string };
  readonly publishedAt: string;
}

export interface PublishArtifactResult {
  readonly url: string;
  readonly deploymentId: string;
}

export interface ArtifactPublishingServiceDeps {
  readonly artifacts: Pick<ArtifactRepoPort, 'get' | 'markPublished'>;
  readonly publisher: PublishedDocumentPort;
}

/** One ownership-scoped publish path for Pi and the member panel. */
export class ArtifactPublishingService {
  constructor(private readonly deps: ArtifactPublishingServiceDeps) {}

  async publish(
    input: PublishArtifactInput,
  ): Promise<Result<PublishArtifactResult, ArtifactPublishingFailure>> {
    const found = await this.deps.artifacts.get(input.scope);
    if (!found.ok) return err({ kind: 'upstream', error: found.error });
    if (!found.value) {
      return err({
        kind: 'not_found',
        message: 'That artifact does not exist or is not yours.',
      });
    }
    if (found.value.mime !== 'text/html') {
      return err({
        kind: 'unsupported_mime',
        message: 'Only HTML artifacts can be published.',
      });
    }

    const published = await this.deps.publisher.publish({
      slug: slugFor(found.value.artifactId),
      title: found.value.title,
      html: buildDocument(found.value.body, 'light', 'standalone', {
        title: found.value.title,
      }),
    });
    if (!published.ok) return err({ kind: 'upstream', error: published.error });

    const saved = await this.deps.artifacts.markPublished(input.scope, {
      publishedUrl: published.value.url,
      publishedAt: input.publishedAt,
      publishGateHash: null,
      publishDeploymentId: published.value.deploymentId,
    });
    if (!saved.ok) {
      return err({
        kind: 'partial',
        message: 'The page was published, but Divo could not save its publication record. The link was not returned.',
        error: saved.error,
      });
    }

    return ok({
      url: published.value.url,
      deploymentId: published.value.deploymentId,
    });
  }
}

function slugFor(artifactId: string): string {
  const slug = artifactId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `divo-artifact-${slug || 'document'}`;
}
