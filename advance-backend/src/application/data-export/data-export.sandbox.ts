import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import type { DataExportTransform } from './data-export.types';

const MAX_SCRIPT_BYTES = 20_000;
const MAX_ARGS_BYTES = 64_000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_MULTIPLIER = 10;
const PAGE_TIMEOUT_MS = 1_000;
const START_TIMEOUT_MS = 2_000;
const MAX_PROTOCOL_BYTES = MAX_PAGE_BYTES + 64_000;

const TRANSFORM_RUNNER = String.raw`
const vm = require('node:vm');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let transformScript;
let transformArgs = {};

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

(async () => {
  for await (const line of rl) {
    try {
      const request = JSON.parse(line);
      if (request.op === 'init') {
        transformScript = request.script;
        transformArgs = request.args || {};
        send({ ok: true, ready: true });
        continue;
      }
      if (request.op !== 'transform' || typeof transformScript !== 'string') {
        throw new Error('Transform sandbox protocol is not initialized');
      }
      const context = vm.createContext({
        rowsJson: JSON.stringify(request.rows),
        argsJson: JSON.stringify(transformArgs),
        startIndex: request.startIndex,
        Date: undefined,
        fetch: undefined,
        process: undefined,
        require: undefined,
        Buffer: undefined,
        console: undefined,
      }, {
        codeGeneration: { strings: false, wasm: false },
      });
      const rows = vm.runInContext(
        '(() => {' +
          '"use strict";' +
          'const rows = JSON.parse(rowsJson);' +
          'const args = JSON.parse(argsJson);' +
          'Math.random = undefined;' +
          'Object.freeze(Math);' +
          'const transform = (row, index, args) => { "use strict"; ' + transformScript + '\n };' +
          'const output = [];' +
          'for (let offset = 0; offset < rows.length; offset += 1) {' +
            'const value = transform(rows[offset], startIndex + offset, args);' +
            'if (value === null || value === undefined) continue;' +
            'if (Array.isArray(value)) output.push(...value); else output.push(value);' +
            'if (output.length > rows.length * ${MAX_OUTPUT_MULTIPLIER}) {' +
              'throw new Error("Transform expanded a page by more than ${MAX_OUTPUT_MULTIPLIER}x");' +
            '}' +
          '}' +
          'return output;' +
        '})()',
        context,
        { timeout: ${PAGE_TIMEOUT_MS}, filename: 'data-export-transform.js' },
      );
      send({ ok: true, rows });
    } catch (error) {
      send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
})().catch((error) => {
  send({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
`;

type SandboxResponse =
  | { readonly ok: true; readonly ready?: true; readonly rows?: unknown }
  | { readonly ok: false; readonly error: string };

export class DataExportTransformSandbox {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: AsyncIterator<Buffer | string> | undefined;
  private stdoutBuffer = Buffer.alloc(0);
  private stderr = '';

  constructor(private readonly transform?: DataExportTransform) {
    if (!transform) return;
    if (Buffer.byteLength(transform.script, 'utf8') > MAX_SCRIPT_BYTES) {
      throw new Error('Data export transform script exceeds 20 KB');
    }
    const argsJson = JSON.stringify(transform.args ?? {});
    if (Buffer.byteLength(argsJson, 'utf8') > MAX_ARGS_BYTES) {
      throw new Error('Data export transform arguments exceed 64 KB');
    }
  }

  async transformPage(
    rows: readonly Record<string, unknown>[],
    startIndex: number,
  ): Promise<Record<string, unknown>[]> {
    if (!this.transform) return rows.map(cloneRow);
    const rowsJson = JSON.stringify(rows);
    if (Buffer.byteLength(rowsJson, 'utf8') > MAX_PAGE_BYTES) {
      throw new Error('Data export source page exceeds the 8 MB sandbox boundary');
    }
    await this.ensureStarted();
    const response = await this.request({
      op: 'transform',
      rows: JSON.parse(rowsJson),
      startIndex,
    }, PAGE_TIMEOUT_MS + 500);
    if (!response.ok) throw new Error(`Data export transform failed: ${response.error}`);

    let serialized: unknown;
    try {
      serialized = JSON.parse(JSON.stringify(response.rows));
    } catch {
      throw new Error('Data export transform returned a non-serializable value');
    }
    if (!Array.isArray(serialized) || serialized.some((row) => !isRecord(row))) {
      throw new Error('Data export transform must return objects, arrays of objects, or null');
    }
    if (serialized.length > rows.length * MAX_OUTPUT_MULTIPLIER) {
      throw new Error(`Data export transform expanded a page by more than ${MAX_OUTPUT_MULTIPLIER}x`);
    }
    if (Buffer.byteLength(JSON.stringify(serialized), 'utf8') > MAX_PAGE_BYTES) {
      throw new Error('Data export transformed page exceeds the 8 MB output boundary');
    }
    return serialized as Record<string, unknown>[];
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.stdout = undefined;
    this.stdoutBuffer = Buffer.alloc(0);
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    const exited = once(child, 'exit').then(() => undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), 500);
    timer.unref?.();
    await exited.catch(() => undefined);
    clearTimeout(timer);
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    const launch = sandboxLaunch();
    const child = spawn(launch.command, launch.args, {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stdout = child.stdout[Symbol.asyncIterator]();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.stderr.length < 8_000) this.stderr += chunk.slice(0, 8_000 - this.stderr.length);
    });
    const response = await this.request({
      op: 'init',
      script: this.transform!.script,
      args: this.transform!.args ?? {},
    }, START_TIMEOUT_MS);
    if (!response.ok || response.ready !== true) {
      await this.close();
      throw new Error(`Data export transform sandbox failed to start: ${response.ok ? 'invalid response' : response.error}`);
    }
  }

  private async request(value: unknown, timeoutMs: number): Promise<SandboxResponse> {
    const child = this.child;
    if (!child || !this.stdout) throw new Error('Data export transform sandbox is unavailable');
    const line = `${JSON.stringify(value)}\n`;
    if (!child.stdin.write(line)) await once(child.stdin, 'drain');
    try {
      return await withTimeout(this.readResponse(), timeoutMs);
    } catch (error) {
      child.kill('SIGKILL');
      const detail = this.stderr.trim();
      throw new Error(
        `Data export transform sandbox stopped unexpectedly${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        { cause: error },
      );
    }
  }

  private async readResponse(): Promise<SandboxResponse> {
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline >= 0) {
        const frame = this.stdoutBuffer.subarray(0, newline).toString('utf8');
        this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
        const parsed = JSON.parse(frame) as unknown;
        if (!isSandboxResponse(parsed)) throw new Error('Transform sandbox returned an invalid response');
        return parsed;
      }
      const next = await this.stdout!.next();
      if (next.done) throw new Error('Transform sandbox exited before responding');
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      if (this.stdoutBuffer.length > MAX_PROTOCOL_BYTES) {
        throw new Error('Transform sandbox response exceeded the 8 MB boundary');
      }
    }
  }
}

export async function transformExportPage(
  rows: readonly Record<string, unknown>[],
  transform: DataExportTransform | undefined,
  startIndex: number,
): Promise<Record<string, unknown>[]> {
  const sandbox = new DataExportTransformSandbox(transform);
  try {
    return await sandbox.transformPage(rows, startIndex);
  } finally {
    await sandbox.close();
  }
}

function sandboxLaunch(): { readonly command: string; readonly args: readonly string[] } {
  const nodeArgs = ['--permission', '--disable-proto=throw', '-e', TRANSFORM_RUNNER];
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const nodeDirectory = sandboxProfileLiteral(dirname(process.execPath));
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(deny file-write*)',
      '(deny file-read* (subpath "/Users") (subpath "/Volumes"))',
      `(allow file-read* (subpath "${nodeDirectory}"))`,
    ].join(' ');
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, process.execPath, ...nodeArgs],
    };
  }
  if (process.platform === 'linux') {
    const bwrap = firstExisting(['/usr/bin/bwrap', '/bin/bwrap']);
    if (bwrap) {
      return {
        command: bwrap,
        args: ['--unshare-net', '--die-with-parent', '--new-session', '--ro-bind', '/', '/', process.execPath, ...nodeArgs],
      };
    }
    const unshare = firstExisting(['/usr/bin/unshare', '/bin/unshare']);
    if (unshare) {
      return {
        command: unshare,
        args: ['--user', '--map-root-user', '--net', '--', process.execPath, ...nodeArgs],
      };
    }
  }
  throw new Error('No supported network-isolated transform sandbox is installed on this host');
}

function firstExisting(paths: readonly string[]): string | undefined {
  return paths.find(existsSync);
}

function sandboxProfileLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Transform sandbox timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cloneRow(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSandboxResponse(value: unknown): value is SandboxResponse {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return false;
  return value['ok']
    ? value['ready'] === true || Object.prototype.hasOwnProperty.call(value, 'rows')
    : typeof value['error'] === 'string';
}
