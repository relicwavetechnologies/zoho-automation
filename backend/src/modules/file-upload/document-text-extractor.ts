import { logger } from '../../utils/logger';
import config from '../../config';

export const normalizeExtractedText = (rawText: string, maxWords = config.DOC_EXTRACT_MAX_WORDS): string => {
  const trimmed = rawText.trim();
  if (!trimmed) return '';

  const words = trimmed.split(/\s+/);
  return words.length > maxWords
    ? words.slice(0, maxWords).join(' ')
    : trimmed;
};

export const extractTextFromBuffer = async (
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> => {
  if (mimeType === 'application/pdf') {
    // pdf-parse v2 is class-based; v1-style pdf(buffer) no longer works.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse') as {
      PDFParse: new (input: { data: Buffer }) => { getText: () => Promise<{ text: string }>; destroy: () => Promise<void> | void };
    };
    const parser = new PDFParse({ data: buffer });
    try {
      const data = await parser.getText();
      return data.text ?? '';
    } finally {
      await parser.destroy();
    }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mimeType === 'application/msword'
  ) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return buffer.toString('utf-8');
  }

  if (mimeType.startsWith('image/')) {
    const base64 = buffer.toString('base64');
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('document.ingestion.image.no_openai_key', { mimeType });
      return '';
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract all readable text from this image. Return only the extracted text, no commentary.',
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }

  logger.warn('document.ingestion.unsupported_mime', { mimeType, fileName });
  return '';
};
