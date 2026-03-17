import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';

import config from '../src/config';

async function main(): Promise<void> {
  const apiKey = config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY or GOOGLE_API_KEY');
  }

  const google = createGoogleGenerativeAI({ apiKey });

  const result = streamText({
    model: google('gemini-3.1-flash-lite-preview'),
    prompt: 'A farmer has chickens and rabbits. There are 35 heads and 94 legs. Solve it carefully.',
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'high',
        },
      },
    },
  });

  let sawReasoning = false;
  let reasoningChars = 0;
  let reasoningDeltas = 0;

  for await (const part of result.fullStream) {
    if (part.type === 'reasoning-start') {
      sawReasoning = true;
      console.log('REASONING_START');
      continue;
    }

    if (part.type === 'reasoning-delta') {
      sawReasoning = true;
      reasoningDeltas += 1;
      reasoningChars += part.text.length;
      console.log(`REASONING_DELTA(${part.text.length}): ${JSON.stringify(part.text)}`);
      continue;
    }

    if (part.type === 'reasoning-end') {
      console.log('REASONING_END');
      continue;
    }

    if (part.type === 'text-delta') {
      process.stdout.write(part.text);
    }
  }

  console.log('\n');
  console.log(JSON.stringify({
    sawReasoning,
    reasoningDeltas,
    reasoningChars,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
