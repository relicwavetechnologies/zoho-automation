import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { fileUploadController, multerUpload } from './file-upload.controller';

const router = Router();

router.use(requireMemberSession());

// Upload a file (PDF, DOCX, image, txt)
router.post(
  '/upload',
  multerUpload.single('file'),
  asyncHandler(fileUploadController.upload),
);

// List files for company
router.get('/', asyncHandler(fileUploadController.listFiles));

// Update access policy (allowedRoles) for a file
router.patch('/:fileAssetId/policy', asyncHandler(fileUploadController.updatePolicy));

// Delete a file and its vectors
router.delete('/:fileAssetId', asyncHandler(fileUploadController.deleteFile));

// Retry ingestion pipeline
router.post('/:fileAssetId/retry', asyncHandler(fileUploadController.retryIngestion));
router.post('/:fileAssetId/share', asyncHandler(fileUploadController.shareFile));

export default router;
