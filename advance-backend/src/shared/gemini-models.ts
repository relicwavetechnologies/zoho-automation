/**
 * Canonical Gemini model IDs for advance-backend.
 * gemini-3.1-flash-lite-preview was shut down 2026-05-25 — use GA flash-lite instead.
 */
export const GEMINI_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite';

/** @deprecated Preview endpoint removed; migrate callers to GEMINI_FLASH_LITE_MODEL */
export const GEMINI_FLASH_LITE_PREVIEW_MODEL = 'gemini-3.1-flash-lite-preview';

/** Vision / OCR / lightweight grading — tries GA first, then stable fallbacks. */
export const GEMINI_VISION_MODEL_FALLBACKS = [
  GEMINI_FLASH_LITE_MODEL,
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
] as const;
