import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { ClamAvKnowledgeFileScanner } from '../../src/infrastructure/knowledge/clamav-knowledge-file.scanner.ts';

describe('ClamAvKnowledgeFileScanner', () => {
  it('streams bytes with INSTREAM framing and accepts only an explicit clean verdict', async () => {
    const observed: Buffer[] = [];
    const server = createServer(socket => {
      let replied = false;
      socket.on('data', chunk => {
        observed.push(chunk);
        const request = Buffer.concat(observed);
        if (!replied && request.length >= 4 && request.subarray(-4).equals(Buffer.alloc(4))) {
          replied = true;
          socket.end('stream: OK\0');
        }
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    try {
      const address = server.address();
      assert.equal(typeof address, 'object');
      const scanner = new ClamAvKnowledgeFileScanner({
        host: '127.0.0.1',
        port: typeof address === 'object' && address ? address.port : 0,
        timeoutMs: 1_000,
      });
      const result = await scanner.scan({
        buffer: Buffer.from('safe bytes'),
        fileName: 'safe.txt',
        mimeType: 'text/plain',
        signal: AbortSignal.timeout(1_000),
      });
      assert.equal(result.status, 'clean');
      const request = Buffer.concat(observed);
      assert.equal(request.subarray(0, 'zINSTREAM\0'.length).toString(), 'zINSTREAM\0');
      assert.equal(request.subarray(-4).equals(Buffer.alloc(4)), true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('returns the bounded threat name for an infected verdict', async () => {
    const server = createServer(socket => {
      socket.once('data', () => socket.end('stream: Eicar-Signature FOUND\0'));
    });
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    try {
      const address = server.address();
      const scanner = new ClamAvKnowledgeFileScanner({
        host: '127.0.0.1',
        port: typeof address === 'object' && address ? address.port : 0,
        timeoutMs: 1_000,
      });
      const result = await scanner.scan({
        buffer: Buffer.from('test'),
        fileName: 'test.txt',
        mimeType: 'text/plain',
        signal: AbortSignal.timeout(1_000),
      });
      assert.deepEqual(result, {
        status: 'infected',
        provider: 'clamav',
        threat: 'Eicar-Signature',
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
