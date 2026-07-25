import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeShareService } from '../../../src/application/knowledge-share/knowledge-share.service';
import { ShareResolverService } from '../../../src/application/knowledge-share/share-resolver.service';
import { ok } from '../../../src/shared/result';
import type { Logger } from '../../../src/shared/logger';

const logger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => logger,
};

const request = {
  shareId: 'share-1',
  fileAssetId: 'file-1',
  companyId: 'company-1',
  requesterUserId: 'requester-1',
  requesterOpenId: 'ou_requester',
  requesterName: 'Requester',
  fileName: 'internal-pricing.pdf',
  label: 'review' as const,
  cardMessageIds: ['card-1'],
  createdAt: new Date().toISOString(),
};

const cardEvent = {
  action: {
    value: { action: 'share_approve', shareId: request.shareId },
  },
};

describe('ShareResolverService authorization', () => {
  it('does not promote or consume a request for a non-admin actor', async () => {
    let promoted = false;
    let deleted = false;
    const service = new ShareResolverService(
      { promoteToShared: async () => { promoted = true; } } as any,
      {
        get: async () => ok(request),
        del: async () => { deleted = true; return ok(undefined); },
      } as any,
      {} as any,
      logger,
    );

    const result = await service.handle(cardEvent, {
      userId: 'member-1',
      companyId: request.companyId,
      aiRole: 'MEMBER',
      openId: 'ou_member',
    });

    assert.equal(result.ok, false);
    assert.equal(promoted, false);
    assert.equal(deleted, false);
  });

  it('promotes and resolves the request for an authenticated company admin', async () => {
    let promoted = false;
    let deleted = false;
    const updatedCards: string[] = [];
    const service = new ShareResolverService(
      { promoteToShared: async () => { promoted = true; } } as any,
      {
        get: async () => ok(request),
        del: async () => { deleted = true; return ok(undefined); },
      } as any,
      {
        updateMessageById: async (_id: string, content: string) => {
          updatedCards.push(content);
          return ok(undefined);
        },
        sendDirectCard: async () => ok({ messageId: 'notice-1' }),
      } as any,
      logger,
    );

    const result = await service.handle(cardEvent, {
      userId: 'admin-1',
      companyId: request.companyId,
      aiRole: 'COMPANY_ADMIN',
      openId: 'ou_admin',
      displayName: 'Verified Admin',
    });

    assert.equal(result.ok, true);
    assert.equal(promoted, true);
    assert.equal(deleted, true);
    assert.match(updatedCards[0] ?? '', /Verified Admin/);
  });
});

describe('KnowledgeShareService admin delivery', () => {
  it('sends review cards only to active company admins with connected Lark accounts', async () => {
    let connectionWhere: any;
    let cachedRequest: any;
    const recipients: string[] = [];
    const service = new KnowledgeShareService(
      {
        adminMembership: {
          findMany: async () => [{ userId: 'admin-1' }],
        },
        integrationConnection: {
          findMany: async ({ where }: any) => {
            connectionWhere = where;
            return [{
              externalAccountId: 'ou_admin',
              ownerUser: { name: 'Admin' },
            }];
          },
        },
      } as any,
      {
        findById: async () => ok({
          id: 'file-1',
          fileName: 'internal-pricing.pdf',
          mimeType: 'application/pdf',
          companyId: 'company-1',
        }),
      } as any,
      {} as any,
      {
        findByFileAsset: async () => ok([{ chunkText: 'Internal pricing proposal' }]),
      } as any,
      {} as any,
      {
        sendDirectCard: async (openId: string) => {
          recipients.push(openId);
          return ok({ messageId: 'card-1' });
        },
      } as any,
      {
        set: async (_key: string, value: unknown) => {
          cachedRequest = value;
          return ok(undefined);
        },
      } as any,
      logger,
    );

    const result = await service.requestShare({
      companyId: 'company-1',
      requesterUserId: 'requester-1',
      requesterOpenId: 'ou_requester',
      requesterName: 'Requester',
      fileAssetId: 'file-1',
    });

    assert.equal(result.outcome, 'pending_review');
    assert.deepEqual(recipients, ['ou_admin']);
    assert.deepEqual(connectionWhere.ownerUserId, { in: ['admin-1'] });
    assert.deepEqual(cachedRequest.cardMessageIds, ['card-1']);
  });
});
