import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import type { DataExportTransform } from './data-export.types';

const MAX_SCRIPT_BYTES = 20_000;
const MAX_ARGS_BYTES = 64_000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECT_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_MULTIPLIER = 10;
const PAGE_TIMEOUT_MS = 1_000;
const DIRECT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 2_000;
const MAX_PROTOCOL_BYTES = MAX_DIRECT_INPUT_BYTES + 64_000;

const SANDBOX_HELPERS = String.raw`
const currencySymbols = { USD:'$', INR:'₹', EUR:'€', GBP:'£', AUD:'A$', CAD:'C$', SGD:'S$', AED:'AED ', JPY:'¥', CHF:'CHF ' };
const formatAmount = (value, currency = 'INR') => {
  const normalized = String(currency || 'INR').trim().toUpperCase() || 'INR';
  const symbol = currencySymbols[normalized] || normalized + ' ';
  const sign = value < 0 ? '-' : '';
  const locale = normalized === 'INR' ? 'en-IN' : 'en-US';
  return sign + symbol + Math.abs(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const formatDate = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric', timeZone:'UTC' });
};
`;

const SANDBOX_RUNNER = String.raw`
const vm = require('node:vm');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let mode;
let script;
let finalizeScript;
let sandboxArgs = {};
let stateJson = '{}';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function context(values) {
  return vm.createContext({
    ...values,
    fetch: undefined,
    process: undefined,
    require: undefined,
    Buffer: undefined,
    console: undefined,
  }, {
    codeGeneration: { strings: false, wasm: false },
  });
}

const helpers = ${JSON.stringify(SANDBOX_HELPERS)};

(async () => {
  for await (const line of rl) {
    try {
      const request = JSON.parse(line);
      if (request.op === 'init') {
        mode = request.mode;
        script = request.script;
        finalizeScript = request.finalizeScript;
        sandboxArgs = request.args || {};
        stateJson = JSON.stringify(request.initialState ?? {});
        send({ ok: true, ready: true });
        continue;
      }
      if (mode === 'transform' && request.op === 'transform' && typeof script === 'string') {
        const rows = vm.runInContext(
          '(() => {' +
            '"use strict";' +
            'const rows = JSON.parse(rowsJson);' +
            'const args = JSON.parse(argsJson);' +
            'Math.random = undefined;' +
            'Object.freeze(Math);' +
            'const transform = (row, index, args) => { "use strict"; ' + script + '\n };' +
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
          context({
            rowsJson: JSON.stringify(request.rows),
            argsJson: JSON.stringify(sandboxArgs),
            startIndex: request.startIndex,
          }),
          { timeout: ${PAGE_TIMEOUT_MS}, filename: 'data-export-transform.js' },
        );
        send({ ok: true, rows });
        continue;
      }

      if (mode === 'compute' && request.op === 'accumulate' && typeof script === 'string') {
        const nextState = vm.runInContext(
          '(() => {' +
            '"use strict";' +
            helpers +
            'const rows = JSON.parse(rowsJson);' +
            'const args = JSON.parse(argsJson);' +
            'let state = JSON.parse(stateJson);' +
            'const reduce = (state, row, index, source, args) => { "use strict"; ' + script + '\n };' +
            'for (let offset = 0; offset < rows.length; offset += 1) {' +
              'state = reduce(state, rows[offset], startIndex + offset, source, args);' +
              'if (state === undefined) throw new Error("Reducer must return state");' +
            '}' +
            'return state;' +
          '})()',
          context({
            rowsJson: JSON.stringify(request.rows),
            argsJson: JSON.stringify(sandboxArgs),
            stateJson,
            startIndex: request.startIndex,
            source: request.source,
          }),
          { timeout: ${PAGE_TIMEOUT_MS}, filename: 'data-compute-reducer.js' },
        );
        stateJson = JSON.stringify(nextState);
        if (Buffer.byteLength(stateJson, 'utf8') > ${MAX_STATE_BYTES}) {
          throw new Error('Computation state exceeds the 2 MB boundary');
        }
        send({ ok: true, processed: request.rows.length, stateBytes: Buffer.byteLength(stateJson, 'utf8') });
        continue;
      }

      if (mode === 'compute' && request.op === 'finalize') {
        const result = typeof finalizeScript === 'string'
          ? vm.runInContext(
              '(() => {' +
                '"use strict";' +
                helpers +
                'const state = JSON.parse(stateJson);' +
                'const args = JSON.parse(argsJson);' +
                'const meta = JSON.parse(metaJson);' +
                'const finalize = (state, meta, args) => { "use strict"; ' + finalizeScript + '\n };' +
                'return finalize(state, meta, args);' +
              '})()',
              context({
                stateJson,
                argsJson: JSON.stringify(sandboxArgs),
                metaJson: JSON.stringify(request.meta),
              }),
              { timeout: ${DIRECT_TIMEOUT_MS}, filename: 'data-compute-finalize.js' },
            )
          : JSON.parse(stateJson);
        send({ ok: true, result });
        continue;
      }

      if (mode === 'direct' && request.op === 'execute' && typeof script === 'string') {
        const result = vm.runInContext(
          '(() => {' +
            '"use strict";' +
            helpers +
            'const data = JSON.parse(dataJson);' +
            'const args = JSON.parse(argsJson);' +
            'return (function() { "use strict"; ' + script + '\n })();' +
          '})()',
          context({
            dataJson: JSON.stringify(request.data),
            argsJson: JSON.stringify(sandboxArgs),
            schema: null,
          }),
          { timeout: ${DIRECT_TIMEOUT_MS}, filename: 'data-processor.js' },
        );
        send({ ok: true, result });
        continue;
      }

      throw new Error('Sandbox protocol is not initialized for this operation');
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
  | {
      readonly ok: true;
      readonly ready?: true;
      readonly rows?: unknown;
      readonly result?: unknown;
      readonly processed?: number;
      readonly stateBytes?: number;
    }
  | { readonly ok: false; readonly error: string };

class IsolatedSandboxProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: AsyncIterator<Buffer | string> | undefined;
  private stdoutBuffer = Buffer.alloc(0);
  private stderr = '';

  constructor(
    private readonly label: string,
    private readonly init: Readonly<Record<string, unknown>>,
  ) {}

  async request(value: unknown, timeoutMs: number): Promise<SandboxResponse> {
    await this.ensureStarted();
    return this.requestFrame(value, timeoutMs);
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
    const response = await this.requestFrame({ op: 'init', ...this.init }, START_TIMEOUT_MS);
    if (!response.ok || response.ready !== true) {
      await this.close();
      throw new Error(
        `${this.label} sandbox failed to start: ${response.ok ? 'invalid response' : response.error}`,
      );
    }
  }

  private async requestFrame(value: unknown, timeoutMs: number): Promise<SandboxResponse> {
    const child = this.child;
    if (!child || !this.stdout) throw new Error(`${this.label} sandbox is unavailable`);
    const line = `${JSON.stringify(value)}\n`;
    if (!child.stdin.write(line)) await once(child.stdin, 'drain');
    try {
      return await withTimeout(this.readResponse(), timeoutMs);
    } catch (error) {
      child.kill('SIGKILL');
      const detail = this.stderr.trim();
      throw new Error(
        `${this.label} sandbox stopped unexpectedly${detail ? `: ${detail.slice(0, 300)}` : ''}`,
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
        if (!isSandboxResponse(parsed)) throw new Error(`${this.label} sandbox returned an invalid response`);
        return parsed;
      }
      const next = await this.stdout!.next();
      if (next.done) throw new Error(`${this.label} sandbox exited before responding`);
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      if (this.stdoutBuffer.length > MAX_PROTOCOL_BYTES) {
        throw new Error(`${this.label} sandbox response exceeded the protocol boundary`);
      }
    }
  }
}

export class DataExportTransformSandbox {
  private readonly sandbox: IsolatedSandboxProcess | undefined;

  constructor(private readonly transform?: DataExportTransform) {
    if (!transform) return;
    if (Buffer.byteLength(transform.script, 'utf8') > MAX_SCRIPT_BYTES) {
      throw new Error('Data export transform script exceeds 20 KB');
    }
    const argsJson = JSON.stringify(transform.args ?? {});
    if (Buffer.byteLength(argsJson, 'utf8') > MAX_ARGS_BYTES) {
      throw new Error('Data export transform arguments exceed 64 KB');
    }
    this.sandbox = new IsolatedSandboxProcess('Data export transform', {
      mode: 'transform',
      script: transform.script,
      args: transform.args ?? {},
    });
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
    const response = await this.sandbox!.request({
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
    await this.sandbox?.close();
  }
}

export interface DataComputeProgram {
  readonly initialState?: unknown;
  readonly reduce: string;
  readonly finalize?: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export class DataComputeSandbox {
  private readonly sandbox: IsolatedSandboxProcess;

  constructor(program: DataComputeProgram) {
    assertScriptSize(program.reduce, 'Data computation reducer');
    if (program.finalize) assertScriptSize(program.finalize, 'Data computation finalizer');
    assertJsonSize(program.args ?? {}, MAX_ARGS_BYTES, 'Data computation arguments exceed 64 KB');
    assertJsonSize(program.initialState ?? {}, MAX_STATE_BYTES, 'Initial computation state exceeds 2 MB');
    this.sandbox = new IsolatedSandboxProcess('Data computation', {
      mode: 'compute',
      script: program.reduce,
      ...(program.finalize ? { finalizeScript: program.finalize } : {}),
      initialState: program.initialState ?? {},
      args: program.args ?? {},
    });
  }

  async accumulatePage(
    rows: readonly Record<string, unknown>[],
    source: string,
    startIndex: number,
  ): Promise<void> {
    assertJsonSize(rows, MAX_PAGE_BYTES, 'Data computation source page exceeds the 8 MB boundary');
    const response = await this.sandbox.request({
      op: 'accumulate',
      rows,
      source,
      startIndex,
    }, PAGE_TIMEOUT_MS + 500);
    if (!response.ok) {
      throw new Error(`Data computation reducer failed: ${response.error}`);
    }
  }

  async finalize(meta: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await this.sandbox.request({ op: 'finalize', meta }, DIRECT_TIMEOUT_MS + 500);
    if (!response.ok) throw new Error(`Data computation finalizer failed: ${response.error}`);
    assertJsonSize(response.result, MAX_RESULT_BYTES, 'Data computation result exceeds the 2 MB boundary');
    return cloneJson(response.result);
  }

  async close(): Promise<void> {
    await this.sandbox.close();
  }
}

export async function executeDataProgram(
  data: unknown,
  script: string,
  args?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  assertScriptSize(script, 'Data processor script');
  assertJsonSize(data, MAX_DIRECT_INPUT_BYTES, 'Input data exceeds the 10 MB boundary');
  assertJsonSize(args ?? {}, MAX_ARGS_BYTES, 'Data processor arguments exceed 64 KB');
  const sandbox = new IsolatedSandboxProcess('Data processor', {
    mode: 'direct',
    script,
    args: args ?? {},
  });
  try {
    const response = await sandbox.request({ op: 'execute', data }, DIRECT_TIMEOUT_MS + 500);
    if (!response.ok) throw new Error(`Data processor script failed: ${response.error}`);
    assertJsonSize(response.result, MAX_RESULT_BYTES, 'Data processor result exceeds the 2 MB boundary');
    return cloneJson(response.result);
  } finally {
    await sandbox.close();
  }
}

function assertScriptSize(script: string, label: string): void {
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new Error(`${label} exceeds 20 KB`);
  }
}

function assertJsonSize(value: unknown, limit: number, message: string): void {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error(`${message}: value is not JSON-serializable`);
  }
  if (json === undefined) {
    throw new Error(`${message}: value is not JSON-serializable`);
  }
  if (Buffer.byteLength(json, 'utf8') > limit) {
    throw new Error(message);
  }
}

function cloneJson(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('undefined');
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error('Sandbox returned a non-serializable value');
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
  const nodeArgs = ['--permission', '--disable-proto=throw', '-e', SANDBOX_RUNNER];
  // GitHub-hosted runners forbid user namespaces. Keep the weaker launcher
  // impossible outside an explicitly opted-in test process.
  if (
    process.env['NODE_ENV'] === 'test'
    && process.env['DATA_EXPORT_UNISOLATED_TEST_MODE'] === 'true'
  ) {
    return { command: process.execPath, args: nodeArgs };
  }
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
    ? value['ready'] === true
      || Object.prototype.hasOwnProperty.call(value, 'rows')
      || Object.prototype.hasOwnProperty.call(value, 'result')
      || typeof value['processed'] === 'number'
    : typeof value['error'] === 'string';
}
