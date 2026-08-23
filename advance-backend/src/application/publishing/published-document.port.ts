import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';

export interface PublishRequest {
  readonly slug: string;
  readonly title: string;
  readonly html: string;
}

export interface PublishedDocument {
  readonly url: string;
  readonly deploymentId: string;
}

export interface PublishedDocumentPort {
  publish(request: PublishRequest): Promise<Result<PublishedDocument, InfraError>>;
}
