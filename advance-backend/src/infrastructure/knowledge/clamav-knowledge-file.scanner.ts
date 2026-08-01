import { createConnection } from 'node:net';
import type {
  KnowledgeFileThreatScanner,
  KnowledgeThreatScanResult,
} from '../../application/knowledge/knowledge-file-threat-scanner';

const COMMAND = Buffer.from('zINSTREAM\0');
const TERMINATOR = Buffer.alloc(4);
const CHUNK_BYTES = 64 * 1_024;
const MAX_REPLY_BYTES = 16 * 1_024;

/** ClamAV INSTREAM client. The daemon must be reachable only on a private network. */
export class ClamAvKnowledgeFileScanner implements KnowledgeFileThreatScanner {
  constructor(private readonly options: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
  }) {}

  async scan(input: {
    readonly buffer: Buffer;
    readonly fileName: string;
    readonly mimeType: string;
    readonly signal: AbortSignal;
  }): Promise<KnowledgeThreatScanResult> {
    input.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      const reply: Buffer[] = [];
      let replyBytes = 0;
      let settled = false;

      const finish = (result: KnowledgeThreatScanResult | Error) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', abort);
        socket.destroy();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const abort = () => finish(new Error('Knowledge malware scan was cancelled.'));
      input.signal.addEventListener('abort', abort, { once: true });
      socket.setTimeout(this.options.timeoutMs);
      socket.once('timeout', () => finish(new Error('Knowledge malware scanner timed out.')));
      socket.once('error', error => finish(new Error('Knowledge malware scanner is unavailable.', { cause: error })));
      socket.on('data', chunk => {
        replyBytes += chunk.length;
        if (replyBytes > MAX_REPLY_BYTES) {
          finish(new Error('Knowledge malware scanner returned an oversized response.'));
          return;
        }
        reply.push(chunk);
        const response = Buffer.concat(reply).toString('utf8');
        const terminator = response.indexOf('\0');
        if (terminator >= 0) finish(parseReply(response.slice(0, terminator)));
      });
      socket.once('close', () => {
        if (settled) return;
        const response = Buffer.concat(reply).toString('utf8').replace(/\0+$/, '');
        finish(response ? parseReply(response) : new Error('Knowledge malware scanner returned no verdict.'));
      });
      socket.once('connect', () => {
        socket.write(COMMAND);
        for (let offset = 0; offset < input.buffer.length; offset += CHUNK_BYTES) {
          const chunk = input.buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, input.buffer.length));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.length);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(TERMINATOR);
      });
    });
  }
}

function parseReply(value: string): KnowledgeThreatScanResult | Error {
  const response = value.trim();
  if (/^stream: OK$/i.test(response)) {
    return { status: 'clean', provider: 'clamav' };
  }
  const infected = /^stream: (.+) FOUND$/i.exec(response);
  if (infected?.[1]) {
    return { status: 'infected', provider: 'clamav', threat: infected[1].trim().slice(0, 500) };
  }
  return new Error(`Knowledge malware scanner did not return a clean verdict: ${response.slice(0, 500)}`);
}
