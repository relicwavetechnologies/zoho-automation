import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { auditService } from '../audit/audit.service';
import { createAssignmentSchema, revokeAssignmentSchema } from './dto/assignment.dto';
import { updatePermissionSchema } from './dto/update-permission.dto';
import { RbacService, rbacService } from './rbac.service';

class RbacController extends BaseController {
  constructor(private readonly service: RbacService = rbacService) {
    super();
  }

  listActions = async (_req: Request, res: Response) =>
    res.json(
      ApiResponse.success(
        [
          'rbac.permissions.read',
          'rbac.permissions.write',
          'rbac.assignments.write',
          'onboarding.manage',
          'audit.read',
          'system.controls.write',
        ],
        'RBAC actions loaded',
      ),
    );

  listPermissions = async (_req: Request, res: Response) => {
    const result = await this.service.resolvePermissionMatrix();
    return res.json(ApiResponse.success(result, 'Permission matrix loaded'));
  };

  updatePermission = async (req: Request, res: Response) => {
    const payload = updatePermissionSchema.parse(req.body);
    const updatedBy =
      (req as Request & { adminSession?: { userId: string } }).adminSession?.userId ?? 'unknown';

    const result = await this.service.updatePermission(payload, updatedBy);
    await auditService.recordLog({
      actorId: updatedBy,
      action: 'admin.rbac.permission_update',
      outcome: 'success',
      metadata: payload,
    });
    return res.json(ApiResponse.success(result, 'Permission updated'));
  };

  listAssignments = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const result = await this.service.listAssignments(companyId);
    return res.json(ApiResponse.success(result, 'Role assignments loaded'));
  };

  createAssignment = async (req: Request, res: Response) => {
    const payload = createAssignmentSchema.parse(req.body);
    const actor =
      (req as Request & { adminSession?: { userId: string } }).adminSession?.userId ?? 'unknown';
    const result = await this.service.createAssignment(payload);
    await auditService.recordLog({
      actorId: actor,
      companyId: payload.companyId,
      action: 'admin.rbac.assignment_create',
      outcome: 'success',
      metadata: payload,
    });
    return res.status(201).json(ApiResponse.success(result, 'Role assignment created'));
  };

  revokeAssignment = async (req: Request, res: Response) => {
    const payload = revokeAssignmentSchema.parse(req.body);
    const actor =
      (req as Request & { adminSession?: { userId: string } }).adminSession?.userId ?? 'unknown';
    const result = await this.service.revokeAssignment(payload.assignmentId);
    await auditService.recordLog({
      actorId: actor,
      action: 'admin.rbac.assignment_revoke',
      outcome: 'success',
      metadata: payload,
    });
    return res.json(ApiResponse.success(result, 'Role assignment revoked'));
  };
}

export const rbacController = new RbacController();
