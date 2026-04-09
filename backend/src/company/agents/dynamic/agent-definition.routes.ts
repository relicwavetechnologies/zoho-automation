import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { AI_MODEL_CATALOG } from '../../ai-models/catalog';
import { ApiResponse } from '../../../core/api-response';
import { HttpException } from '../../../core/http-exception';
import { requireAdminRole, requireAdminSession } from '../../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../../utils/async-handler';
import { prisma } from '../../../utils/prisma';
import { agentDefinitionService } from './agent-definition.service';
import { channelMappingService } from './channel-mapping.service';

type ScopedAdminRequest = Request & {
  adminSession?: {
    userId: string;
    sessionId: string;
    role: 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'DEPARTMENT_MANAGER';
    companyId?: string;
    expiresAt: string;
  };
  companyScope?: {
    companyId: string;
  };
};

const createAgentSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  systemPrompt: z.string().trim().min(1).max(50000),
  isRootAgent: z.boolean().optional(),
  toolIds: z.array(z.string().trim().min(1)).max(500).optional(),
  modelId: z.string().trim().min(1).max(255).nullable().optional(),
  provider: z.string().trim().min(1).max(64).nullable().optional(),
  parentId: z.string().cuid().optional(),
});

const updateAgentSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  systemPrompt: z.string().trim().min(1).max(50000).optional(),
  isRootAgent: z.boolean().optional(),
  isActive: z.boolean().optional(),
  toolIds: z.array(z.string().trim().min(1)).max(500).optional(),
  modelId: z.string().trim().min(1).max(255).nullable().optional(),
  provider: z.string().trim().min(1).max(64).nullable().optional(),
  parentId: z.string().cuid().nullable().optional(),
});

const companyQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

const setMappingSchema = z.object({
  companyId: z.string().uuid().optional(),
  channelType: z.enum(['lark', 'desktop']),
  channelIdentifier: z.string().trim().min(1).max(255),
  agentDefinitionId: z.string().cuid(),
});

const removeMappingSchema = z.object({
  companyId: z.string().uuid().optional(),
  channelType: z.string().trim().min(1).max(64),
  channelIdentifier: z.string().trim().min(1).max(255),
});

const resolveScopedCompanyId = (req: ScopedAdminRequest): string => {
  if (req.companyScope?.companyId) {
    return req.companyScope.companyId;
  }
  throw new HttpException(401, 'Company scope required');
};

const enforceCompanyScope = (req: ScopedAdminRequest, _res: Response, next: () => void) => {
  const session = req.adminSession;
  if (!session) {
    throw new HttpException(401, 'Admin session required');
  }

  const rawBody = req.body as { companyId?: unknown } | undefined;
  const requestedCompanyId =
    (typeof req.query.companyId === 'string' ? req.query.companyId : undefined)
    ?? (typeof rawBody?.companyId === 'string' ? rawBody.companyId : undefined);

  if (session.role === 'COMPANY_ADMIN') {
    if (!session.companyId) {
      throw new HttpException(403, 'Company-admin session is missing company scope');
    }
    if (requestedCompanyId && requestedCompanyId !== session.companyId) {
      throw new HttpException(403, 'Company-admin can only access their assigned company scope');
    }
    req.companyScope = { companyId: session.companyId };
    return next();
  }

  if (!requestedCompanyId) {
    throw new HttpException(400, 'companyId is required for super-admin agent routes');
  }

  req.companyScope = { companyId: requestedCompanyId };
  return next();
};

const router = Router();

router.use(requireAdminSession());
router.use(requireAdminRole('SUPER_ADMIN', 'COMPANY_ADMIN'));
router.use(enforceCompanyScope);

router.get('/agents', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  companyQuerySchema.parse(req.query);
  const data = await agentDefinitionService.listAgents(resolveScopedCompanyId(req));
  return res.json(ApiResponse.success(data, 'Agents loaded'));
}));

router.post('/agents', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  const payload = createAgentSchema.parse(req.body ?? {});
  const data = await agentDefinitionService.createAgent({
    companyId: resolveScopedCompanyId(req),
    name: payload.name,
    description: payload.description,
    systemPrompt: payload.systemPrompt,
    isRootAgent: payload.isRootAgent,
    toolIds: payload.toolIds,
    modelId: payload.modelId ?? undefined,
    provider: payload.provider ?? undefined,
    parentId: payload.parentId,
  });
  return res.status(201).json(ApiResponse.success(data, 'Agent created'));
}));

router.get('/agents/tools/registry', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  companyQuerySchema.parse(req.query);
  const data = await prisma.registeredTool.findMany({
    where: {
      deprecated: false,
    },
    orderBy: [
      { category: 'asc' },
      { name: 'asc' },
    ],
  });
  return res.json(ApiResponse.success(data, 'Registered tools loaded'));
}));

router.get('/agents/models/catalog', asyncHandler(async (_req: ScopedAdminRequest, res: Response) => {
  const data = AI_MODEL_CATALOG.filter((entry) =>
    (entry.provider === 'openai' || entry.provider === 'google')
      && (entry.preview !== true || entry.modelId.startsWith('gemini-3')),
  );
  return res.json(ApiResponse.success(data, 'Model catalog loaded'));
}));

router.get('/agents/:id', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  companyQuerySchema.parse(req.query);
  const data = await agentDefinitionService.getAgent(req.params.id, resolveScopedCompanyId(req));
  return res.json(ApiResponse.success(data, 'Agent loaded'));
}));

router.put('/agents/:id', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  const payload = updateAgentSchema.parse(req.body ?? {});
  const data = await agentDefinitionService.updateAgent(
    req.params.id,
    resolveScopedCompanyId(req),
    payload,
  );
  return res.json(ApiResponse.success(data, 'Agent updated'));
}));

router.delete('/agents/:id', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  companyQuerySchema.parse(req.query);
  await agentDefinitionService.deleteAgent(req.params.id, resolveScopedCompanyId(req));
  return res.json(ApiResponse.success({ deleted: true }, 'Agent deleted'));
}));

router.post('/agents/:id/toggle', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  companyQuerySchema.parse(req.query);
  const data = await agentDefinitionService.toggleActive(req.params.id, resolveScopedCompanyId(req));
  return res.json(ApiResponse.success(data, 'Agent active status updated'));
}));

router.get('/channel-mappings', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  companyQuerySchema.parse(req.query);
  const data = await channelMappingService.listMappings(resolveScopedCompanyId(req));
  return res.json(ApiResponse.success(data, 'Channel mappings loaded'));
}));

router.post('/channel-mappings', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  const payload = setMappingSchema.parse(req.body ?? {});
  const data = await channelMappingService.setMapping({
    companyId: resolveScopedCompanyId(req),
    channelType: payload.channelType,
    channelIdentifier: payload.channelIdentifier,
    agentDefinitionId: payload.agentDefinitionId,
  });
  return res.status(201).json(ApiResponse.success(data, 'Channel mapping saved'));
}));

router.delete('/channel-mappings', asyncHandler(async (req: ScopedAdminRequest, res: Response) => {
  const payload = removeMappingSchema.parse(req.body ?? {});
  await channelMappingService.removeMapping(
    resolveScopedCompanyId(req),
    payload.channelType,
    payload.channelIdentifier,
  );
  return res.json(ApiResponse.success({ deleted: true }, 'Channel mapping removed'));
}));

export default router;
