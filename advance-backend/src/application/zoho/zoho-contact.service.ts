import type { ZohoBooksOrganization, ZohoBooksPaginatedClient } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { ToolError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import { mapZohoError } from './zoho-error.utils';
import { refuseSelfDealing } from './zoho-self-dealing';
import { createZohoBooksWriteRunner } from './zoho-books-write';
import type { ZohoWriteSummary } from './zoho-books-write-result';

export interface ContactCreateOutput {
  readonly record: Record<string, unknown>;
  readonly summary: ZohoWriteSummary;
}

type CallContext = {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId?: string;
  readonly signal?: AbortSignal;
};

const text = (record: Record<string, unknown>, ...keys: string[]): string =>
  keys.map(key => record[key]).find(value => typeof value === 'string' && value.trim()) as string | undefined ?? '';

async function chooseOrganization(
  booksClient: ZohoBooksPaginatedClient,
  input: CallContext,
): Promise<ZohoBooksOrganization | undefined> {
  try {
    const organizations = await booksClient.listOrganizations(input.companyId, {
      userId: input.userId,
      connectionId: input.connectionId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return input.organizationId
      ? organizations.find(item => item.organizationId === input.organizationId)
      : (organizations.find(item => item.isDefault === true) ?? organizations[0]);
  } catch {
    return undefined;
  }
}

export function createZohoContactService(deps: {
  readonly booksClient: ZohoBooksPaginatedClient;
  readonly appBaseUrl: string;
}) {
  return {
    async create(input: CallContext & { fields?: Record<string, unknown> }): Promise<Result<ContactCreateOutput, ToolError>> {
      if (!input.fields) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for create_contact' }));
      }

      const contactFields = input.fields;
      const organization = await chooseOrganization(deps.booksClient, input);
      const refusal = refuseSelfDealing({
        organization,
        party: {
          name: text(contactFields, 'contact_name', 'company_name'),
          gstNo: text(contactFields, 'gst_no'),
        },
        role: text(contactFields, 'contact_type') === 'vendor' ? 'vendor' : 'customer',
        act: 'Creating this contact',
      });
      if (refusal) return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: refusal }));

      const writer = createZohoBooksWriteRunner({
        booksClient: deps.booksClient,
        companyId: input.companyId,
        userId: input.userId,
        connectionId: input.connectionId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        appBaseUrl: deps.appBaseUrl,
      });

      try {
        const written = await writer.writeRecord({
          module: 'contacts',
          verb: 'created',
          method: 'POST',
          path: '/contacts',
          body: contactFields,
        });
        return ok({ record: written.record, summary: written.summary });
      } catch (error) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          cause: error,
          message: mapZohoError(error),
        }));
      }
    },
  };
}
