import type { Turn } from '../../../domain/conversation/turn';

/**
 * Masks verbose tool result content in older assistant turns.
 * Turns within `verbatimCount` from the end keep full tool data.
 * Older turns have their [Execution] output lines replaced with
 * one-line descriptors while preserving the [Reply] section.
 */
export function maskToolResults(
  turns: readonly Turn[],
  verbatimCount: number,
): Turn[] {
  return turns.map((turn, index) => {
    const distanceFromEnd = turns.length - 1 - index;
    if (distanceFromEnd < verbatimCount) return turn;
    if (turn.role !== 'assistant') return turn;
    if (!turn.content.includes('[Execution]')) return turn;

    const masked = maskExecutionBlock(turn.content);
    if (masked === turn.content) return turn;
    return { ...turn, content: masked };
  });
}

function maskExecutionBlock(content: string): string {
  const execStart = content.indexOf('[Execution]');
  if (execStart < 0) return content;

  const replyStart = content.indexOf('\n\n[Reply]', execStart);
  const execSection = replyStart >= 0
    ? content.slice(execStart + '[Execution]'.length, replyStart)
    : content.slice(execStart + '[Execution]'.length);
  const replySection = replyStart >= 0
    ? content.slice(replyStart)
    : '';

  const maskedLines = maskExecutionLines(execSection);
  return `[Execution]\n${maskedLines}${replySection}`;
}

function maskExecutionLines(execText: string): string {
  const lines = execText.split('\n');
  const result: string[] = [];
  let currentToolLine = '';

  for (const line of lines) {
    if (/^\d+\.\s/.test(line)) {
      if (currentToolLine) {
        result.push(maskSingleToolLine(currentToolLine));
      }
      currentToolLine = line;
    } else if (currentToolLine && /^\s{2,}/.test(line)) {
      currentToolLine += '\n' + line;
    } else if (line.trim()) {
      if (currentToolLine) {
        result.push(maskSingleToolLine(currentToolLine));
        currentToolLine = '';
      }
      result.push(line);
    }
  }
  if (currentToolLine) {
    result.push(maskSingleToolLine(currentToolLine));
  }

  return result.join('\n');
}

function maskSingleToolLine(fullLine: string): string {
  const headerMatch = fullLine.match(/^(\d+\.\s+\S+)\s*→\s*(success|error):\s*(.*)/s);
  if (!headerMatch) return truncateLine(fullLine, 120);

  const [, prefix, status, output] = headerMatch;
  const descriptor = extractDescriptor(output!);
  return `${prefix} → ${status}: ${descriptor}`;
}

function extractDescriptor(output: string): string {
  const flat = output.replace(/\s+/g, ' ').trim();

  const countMatch = flat.match(
    /(?:listed|found|fetched|returned|showing)\s+(\d+)\s+(invoices?|bills?|contacts?|expenses?|payments?|tasks?|deals?|leads?|records?|items?|entries)/i,
  );
  if (countMatch) {
    const amountMatch = flat.match(/(?:total|sum|amount|balance)[:\s]*₹?\s?[\d,]+(?:\.\d+)?/i);
    const amount = amountMatch ? `, ${amountMatch[0].trim()}` : '';
    return `${countMatch[0]}${amount}`;
  }

  const createdMatch = flat.match(
    /(?:created|sent|updated|deleted|voided|recorded)\s+(?:invoice|bill|task|deal|lead|contact|email|message|event|payment)\b[^.]{0,80}/i,
  );
  if (createdMatch) return truncateLine(createdMatch[0], 100);

  const errorMatch = flat.match(/^error:\s*/i);
  if (errorMatch) return truncateLine(flat, 150);

  return truncateLine(flat, 100);
}

function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 3)}...`;
}
