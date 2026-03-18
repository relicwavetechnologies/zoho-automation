import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import {
  departmentService,
  type DepartmentAdminSession,
} from '../../company/departments/department.service';
import { skillService } from '../../company/skills/skill.service';

const listDepartmentsQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

const createDepartmentSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
});

const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const updateDepartmentConfigSchema = z.object({
  systemPrompt: z.string().max(20000),
  skillsMarkdown: z.string().max(40000),
  isActive: z.boolean().optional(),
});

const createRoleSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(120),
  isDefault: z.boolean().optional(),
});

const upsertMembershipSchema = z.object({
  userId: z.string().uuid().optional(),
  channelIdentityId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const searchCandidatesQuerySchema = z.object({
  query: z.string().min(1).max(200),
});

const updateRolePermissionSchema = z.object({
  allowed: z.boolean(),
});

const updateUserOverrideSchema = z.object({
  allowed: z.boolean(),
});

const upsertSkillSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120).optional(),
  summary: z.string().max(300).optional(),
  markdown: z.string().min(1).max(40000),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

class AdminDepartmentsController extends BaseController {
  private readSession(req: Request): DepartmentAdminSession {
    const session = (req as Request & { adminSession?: DepartmentAdminSession }).adminSession;
    if (!session) {
      throw new Error('Admin session required');
    }
    return session;
  }

  list = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const query = listDepartmentsQuerySchema.parse(req.query);
    const result = await departmentService.listAdminDepartments(session, query.companyId);
    return res.json(ApiResponse.success(result, 'Departments loaded'));
  };

  detail = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await departmentService.getAdminDepartmentDetail(session, req.params.departmentId);
    return res.json(ApiResponse.success(result, 'Department detail loaded'));
  };

  create = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = createDepartmentSchema.parse(req.body);
    const result = await departmentService.createDepartment(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Department created'));
  };

  update = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = updateDepartmentSchema.parse(req.body);
    const result = await departmentService.updateDepartment(session, req.params.departmentId, payload);
    return res.json(ApiResponse.success(result, 'Department updated'));
  };

  archive = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await departmentService.archiveDepartment(session, req.params.departmentId);
    return res.json(ApiResponse.success(result, 'Department archived'));
  };

  updateConfig = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = updateDepartmentConfigSchema.parse(req.body);
    const result = await departmentService.updateDepartmentConfig(session, req.params.departmentId, payload);
    return res.json(ApiResponse.success(result, 'Department configuration updated'));
  };

  createRole = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = createRoleSchema.parse(req.body);
    const result = await departmentService.createDepartmentRole(session, req.params.departmentId, payload);
    return res.status(201).json(ApiResponse.success(result, 'Department role created'));
  };

  updateRole = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = updateRoleSchema.parse(req.body);
    const result = await departmentService.updateDepartmentRoleSettings(
      session,
      req.params.departmentId,
      req.params.roleId,
      payload,
    );
    return res.json(ApiResponse.success(result, 'Department role updated'));
  };

  deleteRole = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await departmentService.deleteDepartmentRole(
      session,
      req.params.departmentId,
      req.params.roleId,
    );
    return res.json(ApiResponse.success(result, 'Department role deleted'));
  };

  upsertMembership = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = upsertMembershipSchema.parse(req.body);
    const result = await departmentService.upsertDepartmentMembership(session, req.params.departmentId, payload);
    return res.json(ApiResponse.success(result, 'Department membership saved'));
  };

  searchCandidates = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const query = searchCandidatesQuerySchema.parse(req.query);
    const result = await departmentService.searchDepartmentCandidates(session, req.params.departmentId, query.query);
    return res.json(ApiResponse.success(result, 'Department candidates loaded'));
  };

  removeMembership = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await departmentService.removeDepartmentMembership(
      session,
      req.params.departmentId,
      req.params.userId,
    );
    return res.json(ApiResponse.success(result, 'Department membership removed'));
  };

  updateRolePermission = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = updateRolePermissionSchema.parse(req.body);
    const result = await departmentService.updateDepartmentRolePermission(
      session,
      req.params.departmentId,
      req.params.roleId,
      req.params.toolId,
      req.params.actionGroup,
      payload.allowed,
    );
    return res.json(ApiResponse.success(result, 'Department role permission updated'));
  };

  updateUserOverride = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = updateUserOverrideSchema.parse(req.body);
    const result = await departmentService.updateDepartmentUserOverride(
      session,
      req.params.departmentId,
      req.params.userId,
      req.params.toolId,
      req.params.actionGroup,
      payload.allowed,
    );
    return res.json(ApiResponse.success(result, 'Department user override updated'));
  };

  createSkill = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = upsertSkillSchema.parse(req.body);
    const result = await skillService.createDepartmentSkill(session, req.params.departmentId, payload);
    return res.status(201).json(ApiResponse.success(result, 'Department skill created'));
  };

  updateSkill = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const payload = upsertSkillSchema.parse(req.body);
    const result = await skillService.updateDepartmentSkill(
      session,
      req.params.departmentId,
      req.params.skillId,
      payload,
    );
    return res.json(ApiResponse.success(result, 'Department skill updated'));
  };

  archiveSkill = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await skillService.archiveDepartmentSkill(
      session,
      req.params.departmentId,
      req.params.skillId,
    );
    return res.json(ApiResponse.success(result, 'Department skill archived'));
  };
}

export const adminDepartmentsController = new AdminDepartmentsController();
