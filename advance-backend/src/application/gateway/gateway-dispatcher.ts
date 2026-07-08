import type { ToolRegistry } from '../orchestration/tools/tool-registry';
import type { PermissionService } from '../permissions/permission.service';
import type { SkillRegistry } from '../skills/skill-registry';
import type { Logger } from '../../shared/logger';
import { asCompanyId, asDepartmentId, asToolId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { PermissionResult } from '../permissions/permission.types';
import type { ToolExecutor } from './tool-executor';
import { mediaImageOcrPayloadSchema, type MediaOcrService } from './media-ocr.service';
import type { ConnectionRegistryPort } from '../connections/connection-registry.port';
import type {
  GatewayMemberContext,
  GatewayRequest,
  GatewayResponse,
} from './gateway.types';
import {
  gatewayFailure,
  gatewaySuccess,
  connectionsListPayloadSchema,
  isGatewayOp,
  skillsGetPayloadSchema,
  skillsSearchPayloadSchema,
  toolsInvokePayloadSchema,
} from './gateway.types';

export interface GatewayDispatcherDeps {
  readonly permissions: PermissionService;
  readonly toolRegistry: ToolRegistry;
  readonly skillRegistry: SkillRegistry;
  readonly toolExecutor: ToolExecutor;
  readonly connectionRegistry?: ConnectionRegistryPort;
  readonly mediaOcr?: MediaOcrService;
  readonly logger: Logger;
}

export class GatewayDispatcher {
  constructor(private readonly deps: GatewayDispatcherDeps) {}

  async dispatch(request: GatewayRequest, member: GatewayMemberContext): Promise<GatewayResponse> {
    if (!isGatewayOp(request.op)) {
      return gatewayFailure('unknown_op', `Unknown operation: ${request.op}`);
    }

    const departmentId = request.departmentId;

    switch (request.op) {
      case 'capabilities.get':
        return this.handleCapabilitiesGet(member, departmentId);
      case 'tools.list':
        return this.handleToolsList(member, departmentId);
      case 'skills.list':
        return this.handleSkillsList(member, departmentId);
      case 'skills.search':
        return this.handleSkillsSearch(member, departmentId, request.payload);
      case 'skills.get':
        return this.handleSkillsGet(member, departmentId, request.payload);
      case 'connections.list':
        return this.handleConnectionsList(member, departmentId, request.payload);
      case 'media.image_ocr':
        return this.handleMediaImageOcr(member, departmentId, request.payload);
      case 'tools.invoke':
        return this.handleToolsInvoke(member, departmentId, request.payload);
      default:
        return gatewayFailure('unknown_op', `Unknown operation: ${request.op}`);
    }
  }

  private async resolvePerm(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<PermissionResult | null> {
    const result = await this.deps.permissions.resolve({
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
      channel: 'desktop',
    });

    if (!result.ok) {
      return null;
    }

    return result.value;
  }

  private permissionDenied(message: string): GatewayResponse {
    return gatewayFailure('permission_denied', message);
  }

  private filterSkills(perm: PermissionResult) {
    return this.deps.skillRegistry.all().filter((skill) =>
      skill.toolIds.some((toolId) => perm.allowedToolIds.has(asToolId(toolId))),
    );
  }

  private async handleCapabilitiesGet(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<GatewayResponse> {
    const permOrError = await this.resolvePerm(member, departmentId);
    if (!permOrError) {
      return this.permissionDenied('Permission resolution failed');
    }

    const perm = permOrError;
    const allowedSkills = this.filterSkills(perm);

    return gatewaySuccess({
      user: {
        userId: member.userId,
        email: member.email,
        role: member.aiRole,
        larkOpenId: member.larkOpenId,
      },
      company: { companyId: member.companyId },
      departments: [],
      tools: [...perm.allowedToolIds].map((toolId) => ({
        toolId,
        allowedActions: [...(perm.allowedActionsByTool.get(toolId) ?? [])],
      })),
      skills: allowedSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      })),
    });
  }

  private async handleToolsList(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<GatewayResponse> {
    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    const tools = this.deps.toolRegistry
      .forRuntime(perm)
      .filter((tool) => tool.id !== 'runCommand')
      .map((tool) => ({
        id: tool.id,
        family: tool.family,
        description: tool.description,
        parameterDocs: tool.parameterDocs,
        allowedActions: [...(perm.allowedActionsByTool.get(asToolId(tool.id)) ?? [])],
      }));

    return gatewaySuccess({ tools });
  }

  private async handleSkillsList(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<GatewayResponse> {
    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    const skills = this.filterSkills(perm).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      toolIds: [...skill.toolIds],
    }));

    return gatewaySuccess({ skills });
  }

  private async handleSkillsSearch(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = skillsSearchPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid skills.search payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    const allowedSkills = this.filterSkills(perm);
    const results = this.deps.skillRegistry.search(parsed.data.query, {
      limit: parsed.data.limit ?? 3,
      skills: allowedSkills,
    });

    return gatewaySuccess({
      query: parsed.data.query,
      nextStep: 'Call skills.get with the selected skillId before invoking backend tools.',
      skills: results.map((result) => ({
        id: result.skill.id,
        name: result.skill.name,
        description: result.skill.description,
        score: result.score,
        toolIds: [...result.skill.toolIds],
      })),
    });
  }

  private async handleSkillsGet(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = skillsGetPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid skills.get payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    const skill = this.deps.skillRegistry.getById(parsed.data.skillId);
    if (!skill) {
      return gatewayFailure('bad_request', `Unknown skillId "${parsed.data.skillId}"`);
    }

    const allowed = skill.toolIds.some((toolId) =>
      perm.allowedToolIds.has(asToolId(toolId)),
    );
    if (!allowed) {
      return gatewayFailure(
        'permission_denied',
        `Skill "${skill.id}" is not available for this user`,
      );
    }

    return gatewaySuccess({
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        toolIds: [...skill.toolIds],
      },
    });
  }

  private async handleToolsInvoke(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = toolsInvokePayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid tools.invoke payload — ${issues}`);
    }

    this.deps.logger.info('gateway.tools.invoke', {
      toolId: parsed.data.toolId,
      userId: member.userId,
      companyId: member.companyId,
      departmentId: departmentId ?? null,
    });

    return this.deps.toolExecutor.invoke({
      member,
      ...(departmentId ? { departmentId } : {}),
      toolId: parsed.data.toolId,
      args: parsed.data.args,
    });
  }

  private async handleConnectionsList(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = connectionsListPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid connections.list payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    if (!this.deps.connectionRegistry) {
      return gatewayFailure('tool_error', 'Connection registry is not configured');
    }

    const provider = parsed.data.provider ?? 'google_workspace';
    const canUseGoogle = ['googleGmail', 'googleDrive', 'googleCalendar'].some((toolId) =>
      perm.allowedToolIds.has(asToolId(toolId)),
    );
    const canUseZoho = ['zohoCrm', 'zohoBooks'].some((toolId) =>
      perm.allowedToolIds.has(asToolId(toolId)),
    );
    if (provider === 'google_workspace' && !canUseGoogle) {
      return gatewaySuccess({ connections: [] });
    }
    if (provider === 'zoho' && !canUseZoho) {
      return gatewaySuccess({ connections: [] });
    }

    const result = provider === 'zoho'
      ? await this.deps.connectionRegistry.listAccessibleZohoConnections({
        companyId: member.companyId,
        userId:    member.userId,
      })
      : await this.deps.connectionRegistry.listAccessibleGoogleConnections({
      companyId: member.companyId,
      userId:    member.userId,
      });
    if (!result.ok) {
      return gatewayFailure('tool_error', result.error.message);
    }

    return gatewaySuccess({
      connections: result.value.map(connection => ({
        connectionId: connection.connectionId,
        provider:     connection.provider,
        label:        connection.label,
        accountEmail: connection.accountEmail ?? null,
        accountName:  connection.accountName ?? null,
        ownerType:    connection.ownerType,
        ownerUserId:  connection.ownerUserId ?? null,
        access:       connection.access,
        scopes:       connection.scopes,
        connectedAt:  connection.connectedAt.toISOString(),
        lastUsedAt:   connection.lastUsedAt?.toISOString() ?? null,
      })),
    });
  }

  private async handleMediaImageOcr(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = mediaImageOcrPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid media.image_ocr payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    if (!this.deps.mediaOcr) {
      return gatewayFailure('tool_error', 'Media OCR is not configured');
    }

    this.deps.logger.info('gateway.media.image_ocr', {
      userId: member.userId,
      companyId: member.companyId,
      departmentId: departmentId ?? null,
      mimeType: parsed.data.mimeType,
      fileName: parsed.data.fileName ?? null,
    });

    const result = await this.deps.mediaOcr.extractImage(parsed.data);
    return gatewaySuccess({ media: result });
  }
}
