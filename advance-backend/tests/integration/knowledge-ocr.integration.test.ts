import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { OpenRouterKnowledgeOcr } from '../../src/infrastructure/knowledge/openrouter-knowledge.ocr.ts';

const execFileAsync = promisify(execFile);
const apiKey = process.env['OPENROUTER_API_KEY']?.trim();
const model = process.env['VISION_OCR_MODEL']?.trim() || 'qwen/qwen3-vl-32b-instruct';
const enabled = process.env['RUN_OCR_INTEGRATION'] === '1' && Boolean(apiKey && model);

test('real governed OCR extracts retrieval text from a generated image', {
  skip: !enabled ? 'Set RUN_OCR_INTEGRATION=1, OPENROUTER_API_KEY, and VISION_OCR_MODEL to run.' : false,
  timeout: 60_000,
}, async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'divo-ocr-integration-'));
  const imagePath = join(workDir, 'procedure.png');
  try {
    await execFileAsync('magick', [
      '-size', '1200x300',
      'xc:white',
      '-font', '/System/Library/Fonts/Supplemental/Arial.ttf',
      '-fill', 'black',
      '-pointsize', '48',
      '-gravity', 'center',
      '-annotate', '+0+0', 'DOC OCR A91C\nRollback before Owners',
      imagePath,
    ]);
    const ocr = new OpenRouterKnowledgeOcr({
      apiKey: apiKey!,
      model: model!,
      providerOrder: process.env['OPENROUTER_PROVIDER_ORDER'],
    });
    const result = await ocr.extract({
      image: await readFile(imagePath),
      mimeType: 'image/png',
      signal: AbortSignal.timeout(45_000),
    });
    const extracted = `${result.caption}\n${result.text}`;
    assert.match(extracted, /rollback/i);
    assert.match(extracted, /owners/i);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
