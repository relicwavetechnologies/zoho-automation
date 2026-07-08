import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractImageTextWithProvider } from '../../src/application/ingestion/text-extraction/image-ocr.extractor.ts';

describe('extractImageTextWithProvider', () => {
  it('calls OpenRouter Scout with image input and parses structured OCR JSON', async () => {
    let requestBody: any;
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ocrText: 'Total: $42',
                caption: 'A receipt screenshot.',
                uiElements: ['Total label'],
                confidence: 0.91,
                warnings: ['small text'],
              }),
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await extractImageTextWithProvider(
      Buffer.from('image-bytes'),
      'image/png',
      {
        provider: 'openrouter',
        openrouterApiKey: 'test-key',
        visionModel: 'meta-llama/llama-4-scout',
        openrouterProviderOrder: 'Groq',
        fetchImpl,
      },
    );

    assert.equal(requestBody.model, 'meta-llama/llama-4-scout');
    assert.deepEqual(requestBody.provider, { order: ['Groq'], allow_fallbacks: true });
    assert.equal(requestBody.messages[0].content[1].type, 'image_url');
    assert.equal(result.ocrText, 'Total: $42');
    assert.equal(result.caption, 'A receipt screenshot.');
    assert.deepEqual(result.uiElements, ['Total label']);
    assert.equal(result.provider, 'openrouter');
  });

  it('fails fast when OpenRouter is selected without an API key', async () => {
    await assert.rejects(
      () => extractImageTextWithProvider(Buffer.from('x'), 'image/png', {
        provider: 'openrouter',
        openrouterApiKey: '',
      }),
      /OpenRouter image OCR is not configured/,
    );
  });
});
