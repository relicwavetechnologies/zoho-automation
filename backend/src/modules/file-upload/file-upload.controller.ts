import { Request, Response } from 'express';
import multer from 'multer';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { fileUploadService } from './file-upload.service';
import config from '../../config';

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

    if (!req.file) {
      throw new HttpException(400, 'No file provided');
    }

    const rawRoles = typeof req.body?.allowedRoles === 'string'
      ? req.body.allowedRoles.split(',').map((r: string) => r.trim()).filter(Boolean)
      : [];

    // Default: file is accessible only to uploader's role and above
    const allowedRoles = rawRoles.length > 0 ? rawRoles : [session.role ?? 'MEMBER'];

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
    const files = await fileUploadService.listFiles(session.companyId);
    res.json(ApiResponse.success(files, 'Files retrieved'));
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
}

export const fileUploadController = new FileUploadController();
