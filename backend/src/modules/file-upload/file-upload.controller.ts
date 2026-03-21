import { Request, Response } from 'express';
import multer from 'multer';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { fileUploadService } from './file-upload.service';
import config from '../../config';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { knowledgeShareService } from '../../company/knowledge-share/knowledge-share.service';
import { prisma } from '../../utils/prisma';
import { orangeDebug } from '../../utils/orange-debug';

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

// multer: store in memory, enforce max file size server-side
export const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.DOC_UPLOAD_MAX_MB * 1024 * 1024 },
});

class FileUploadController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const s = (req as MemberRequest).memberSession;
    if (!s) throw new HttpException(401, 'Member session required');
    return s;
  }

  /**
   * POST /api/member/files/upload
   * Multipart form fields:
   *   - file: the actual file (required)
   *   - allowedRoles: comma-separated role slugs, e.g. "HR,ADMIN" (optional, defaults to uploader's role)
   */
  upload = async (req: Request, res: Response): Promise<void> => {
    const session = this.session(req);
    const requesterAiRole = session.aiRole ?? session.role;

    if (!req.file) {
      throw new HttpException(400, 'No file provided');
    }

    const rawRoles = typeof req.body?.allowedRoles === 'string'
      ? req.body.allowedRoles.split(',').map((r: string) => r.trim()).filter(Boolean)
      : [];

    // Default: file is accessible only to uploader's role and above
    const allowedRoles = rawRoles.length > 0 ? rawRoles : [requesterAiRole ?? 'MEMBER'];

    const result = await fileUploadService.upload({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      fileName: req.file.originalname,
      sizeBytes: req.file.size,
      companyId: session.companyId,
      uploaderUserId: session.userId,
      uploaderChannel: 'desktop',
      allowedRoles,
    });

    res.json(ApiResponse.success(result, 'File uploaded and queued for ingestion'));
  };

  /**
   * GET /api/member/files
   * List all file assets for the company
   */
  listFiles = async (req: Request, res: Response): Promise<void> => {
    const session = this.session(req);
    const requesterAiRole = session.aiRole ?? session.role;
    const isAdmin = ['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(requesterAiRole);
    orangeDebug('file.drawer.request', {
      sessionUserId: session.userId,
      companyId: session.companyId,
      requesterAiRole,
      authProvider: session.authProvider,
      larkOpenId: session.larkOpenId ?? null,
      larkUserId: session.larkUserId ?? null,
      isAdmin,
    });
    const files = await fileUploadService.listVisibleFiles({
      companyId: session.companyId,
      requesterUserId: session.userId,
      requesterAiRole,
      isAdmin,
    });
    const conversationKeys = files.map((file) => `file:${file.id}`);
    const shareRows = conversationKeys.length > 0
      ? await prisma.vectorShareRequest.findMany({
        where: {
          companyId: session.companyId,
          conversationKey: { in: conversationKeys },
        },
        orderBy: { createdAt: 'desc' },
      })
      : [];
    const latestShareByConversationKey = new Map<string, { status: string; summary?: string }>();
    for (const row of shareRows) {
      if (latestShareByConversationKey.has(row.conversationKey)) continue;
      let summary: string | undefined;
      try {
        const meta = row.reason ? JSON.parse(row.reason) as { summary?: string } : null;
        summary = typeof meta?.summary === 'string' ? meta.summary : undefined;
      } catch {
        summary = undefined;
      }
      latestShareByConversationKey.set(row.conversationKey, {
        status: row.status,
        summary,
      });
    }
    const canShare = await toolPermissionService.isAllowed(
      session.companyId,
      'share_chat_vectors',
      requesterAiRole,
    );
    res.json(ApiResponse.success({
      files: files.map((file) => {
        const share = latestShareByConversationKey.get(`file:${file.id}`);
        return {
          ...file,
          shareStatus: share?.status,
          shareSummary: share?.summary,
          sharedCompanyWide: share ? ['approved', 'auto_shared', 'shared_notified', 'already_shared'].includes(share.status) : false,
        };
      }),
      canShare,
    }, 'Files retrieved'));
  };

  /**
   * PATCH /api/member/files/:fileAssetId/policy
   * Update access policy for a file (allowedRoles: string[])
   */
  updatePolicy = async (req: Request, res: Response): Promise<void> => {
    const session = this.session(req);
    const { fileAssetId } = req.params;
    const { allowedRoles } = req.body;

    if (!Array.isArray(allowedRoles) || allowedRoles.some((r: unknown) => typeof r !== 'string')) {
      throw new HttpException(400, 'allowedRoles must be an array of strings');
    }

    await fileUploadService.updateAccessPolicy({
      fileAssetId,
      companyId: session.companyId,
      allowedRoles,
      updatedBy: session.userId,
    });

    res.json(ApiResponse.success({ fileAssetId, allowedRoles }, 'Access policy updated'));
  };

  /**
   * DELETE /api/member/files/:fileAssetId
   * Delete file from Cloudinary + Postgres + Qdrant vectors
   */
  deleteFile = async (req: Request, res: Response): Promise<void> => {
    const session = this.session(req);
    const { fileAssetId } = req.params;
    await fileUploadService.deleteFile(fileAssetId, session.companyId);
    res.json(ApiResponse.success({ fileAssetId }, 'File deleted'));
  };

  /**
   * POST /api/member/files/:fileAssetId/retry
   * Fetch the failed file from cloudinary and run it back through the pipeline
   */
  retryIngestion = async (req: Request, res: Response): Promise<void> => {
    const session = this.session(req);
    const { fileAssetId } = req.params;
    const result = await fileUploadService.retryIngestion(fileAssetId, session.companyId);
    res.json(
      ApiResponse.success(
        { fileAssetId, ...result },
        result.alreadyDone ? 'File is already indexed' : 'Ingestion retry initiated',
      ),
    );
  };

  /**
   * POST /api/member/files/:fileAssetId/share
   * Runs the same share-access + classification pipeline used by Lark chat sharing.
   */
  shareFile = async (req: Request, res: Response): Promise<void> => {
    const session = this.session(req);
    const requesterAiRole = session.aiRole ?? session.role;
    const { fileAssetId } = req.params;
    const hasAccess = await toolPermissionService.isAllowed(
      session.companyId,
      'share_chat_vectors',
      requesterAiRole,
    );
    if (!hasAccess) {
      throw new HttpException(403, 'Your role is not allowed to share knowledge.');
    }

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
        ? req.body.reason.trim()
        : undefined;

    const result = await knowledgeShareService.requestFileShare({
      companyId: session.companyId,
      requesterUserId: session.userId,
      requesterAiRole,
      fileAssetId,
      humanReason: reason,
    });

    res.json(ApiResponse.success(result, 'File share request processed'));
  };
}

export const fileUploadController = new FileUploadController();
