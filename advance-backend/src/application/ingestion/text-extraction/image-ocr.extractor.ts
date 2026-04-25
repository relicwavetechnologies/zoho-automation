import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

/**
 * Extracts text from an image buffer using Gemini Flash Lite via Vercel AI SDK.
 * Returns OCR text and a concise caption for search embedding.
 */
export async function extractImageText(
  buf: Buffer,
  mimeType: string,
  geminiApiKey: string,
): Promise<{ ocrText: string; caption: string }> {
  const google = createGoogleGenerativeAI({ apiKey: geminiApiKey });
  const model  = google('gemini-3.1-flash-lite-preview');

  const { text: raw } = await generateText({
    model,
    maxOutputTokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'You are a document digitizer.',
              'First, transcribe ALL text visible in this image verbatim (OCR).',
              'Then, on a new line starting with "CAPTION:", write a 1-2 sentence description of the image for search indexing.',
              'Format:\nOCR:\n<transcribed text>\nCAPTION:\n<description>',
            ].join(' '),
          },
          {
            type: 'image',
            image: `data:${mimeType};base64,${buf.toString('base64')}`,
          },
        ],
      },
    ],
  });

  const ocrMatch     = raw.match(/OCR:\s*([\s\S]*?)(?=CAPTION:|$)/i);
  const captionMatch = raw.match(/CAPTION:\s*([\s\S]*?)$/i);

  return {
    ocrText: (ocrMatch?.[1] ?? '').trim(),
    caption: (captionMatch?.[1] ?? '').trim() || raw.trim(),
  };
}
