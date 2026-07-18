import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { createDeepSeek } from '@ai-sdk/deepseek';
import express from 'express';
import type { PrismaClient as PrismaClientType } from '../src/generated/prisma';
import type { Logger } from '../src/shared/logger';
import { ManagerTeachMediaProcessor } from '../src/application/persona-learning/manager-teach-media.processor';
import type {
  ManagerTeachFrameOcr,
  ManagerTeachMediaExtractor,
  ManagerTeachTranscript,
  ManagerTeachTranscriber,
} from '../src/application/persona-learning/manager-teach-media.types';
import { ManagerPersonaRevisionService } from '../src/application/persona-learning/manager-persona-revision.service';
import { DeepSeekManagerTeachPersonaExtractor } from '../src/application/persona-learning/manager-teach-persona.extractor';
import { ManagerTeachPersonaProcessor } from '../src/application/persona-learning/manager-teach-persona.processor';
import { ManagerTeachQueue } from '../src/application/persona-learning/manager-teach.queue';
import { ManagerTeachService, type ManagerTeachSessionView } from '../src/application/persona-learning/manager-teach.service';
import { ManagerTeachWorker } from '../src/application/persona-learning/manager-teach.worker';
import { createManagerTeachRoutes } from '../src/http/desktop/manager-teach.routes';
import { OpenRouterManagerTeachFrameOcr } from '../src/infrastructure/ai/ocr/openrouter-manager-teach.ocr';
import { OpenAiManagerTeachTranscriber } from '../src/infrastructure/ai/transcription/openai-manager-teach.transcriber';
import { PeepshowManagerTeachExtractor } from '../src/infrastructure/media/peepshow-manager-teach.extractor';

const JWT_SECRET = 'manager-teach-isolated-smoke-secret';
const TERMINAL_STATUSES = new Set<ManagerTeachSessionView['status']>([
  'persona_updated',
  'no_learning',
  'failed',
  'cancelled',
]);
const NARRATION = [
  'Whenever we prepare the weekly status report, always put current risks first,',
  'before achievements and next steps.',
  'This is how I want every weekly report structured.',
].join(' ');

interface ManagedProcess {
  readonly name: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly tail: () => string;
}

interface Observations {
  extractedFrames: number;
  extractedAudio: boolean;
  ocrCalls: number;
  ocrModel: string | null;
  ocrText: string;
  transcript: ManagerTeachTranscript | null;
  personaCalls: number;
  proposedChanges: number;
}

const logger: Logger = {
  debug: () => {},
  info: (event, data) => {
    if (event === 'manager-teach.worker.started') return;
    process.stdout.write(`  ${event}${data?.status ? `: ${String(data.status)}` : ''}\n`);
  },
  warn: (event, data) => process.stderr.write(`  WARN ${event}: ${safeMessage(data?.error)}\n`),
  error: (event, data) => process.stderr.write(`  ERROR ${event}: ${safeMessage(data?.error)}\n`),
  child: () => logger,
};

async function main(): Promise<void> {
  requireConfiguration(['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY']);
  if (process.platform !== 'darwin') {
    throw new Error('The synthetic narrated recording currently requires macOS /usr/bin/say');
  }

  const root = await mkdtemp(join(tmpdir(), 'divo-manager-teach-smoke-'));
  const pgData = join(root, 'postgres');
  const redisData = join(root, 'redis');
  const uploadDir = join(root, 'uploads');
  const videoPath = join(root, 'weekly-status-teaching.mp4');
  const narrationPath = join(root, 'narration.aiff');
  await Promise.all([mkdir(redisData), mkdir(uploadDir)]);

  let postgres: ManagedProcess | undefined;
  let redis: ManagedProcess | undefined;
  let prisma: PrismaClientType | undefined;
  let queue: ManagerTeachQueue | undefined;
  let worker: ManagerTeachWorker | undefined;
  let server: Server | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      if (server) await closeServer(server).catch(() => undefined);
      await worker?.close().catch(() => undefined);
      await queue?.close().catch(() => undefined);
      await prisma?.$disconnect().catch(() => undefined);
      await stopProcess(redis);
      await stopProcess(postgres);
      await rm(root, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  const handleInterrupt = () => {
    process.stderr.write('\nCleaning isolated Teach smoke environment\n');
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);

  try {
    process.stdout.write('Preparing isolated services\n');
    const postgresPort = await freePort();
    const redisPort = await freePort();
    await runCommand('initdb', [
      '-D', pgData,
      '-A', 'trust',
      '-U', 'postgres',
      '--no-locale',
      '--encoding=UTF8',
    ]);
    postgres = startProcess('postgres', [
      '-D', pgData,
      '-p', String(postgresPort),
      '-h', '127.0.0.1',
      '-c', 'unix_socket_directories=',
      '-F',
    ], 'PostgreSQL');
    redis = startProcess('redis-server', [
      '--port', String(redisPort),
      '--bind', '127.0.0.1',
      '--protected-mode', 'yes',
      '--save', '',
      '--appendonly', 'no',
      '--dir', redisData,
    ], 'Redis');
    await Promise.all([
      waitForPort(postgresPort, postgres),
      waitForPort(redisPort, redis),
    ]);

    const databaseUrl = `postgresql://postgres@127.0.0.1:${postgresPort}/postgres?schema=public`;
    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    process.env.DATABASE_URL = databaseUrl;
    const prismaPackageDir = dirname(require.resolve('prisma/package.json'));
    // The repository migration history starts from an already-provisioned
    // baseline and cannot bootstrap a blank database. This disposable smoke
    // database therefore receives the current schema directly; production
    // migration deployment remains a separate concern.
    await runCommand(
      process.execPath,
      [join(prismaPackageDir, 'build', 'index.js'), 'db', 'push', '--skip-generate'],
      { ...process.env, DATABASE_URL: databaseUrl },
    );
    process.stdout.write('  ephemeral database schema: PASS\n');

    const { PrismaClient } = await import('../src/generated/prisma');
    prisma = new PrismaClient();
    const identity = await seedManager(prisma);
    await createSyntheticRecording(narrationPath, videoPath);
    const video = await stat(videoPath);
    process.stdout.write(`  synthetic recording: PASS (${video.size} bytes)\n`);

    const observations: Observations = {
      extractedFrames: 0,
      extractedAudio: false,
      ocrCalls: 0,
      ocrModel: null,
      ocrText: '',
      transcript: null,
      personaCalls: 0,
      proposedChanges: 0,
    };
    const extractor = observeMediaExtractor(new PeepshowManagerTeachExtractor({
      maxFrames: 4,
      minFrames: 2,
      width: 1_000,
      sceneThreshold: 0.12,
      timeoutMs: 5 * 60_000,
    }), observations);
    const ocr = observeOcr(new OpenRouterManagerTeachFrameOcr({
      apiKey: process.env.OPENROUTER_API_KEY!,
      model: process.env.MANAGER_TEACH_OCR_MODEL?.trim() || 'qwen/qwen3-vl-32b-instruct',
    }), observations);
    const transcriber = observeTranscriber(new OpenAiManagerTeachTranscriber({
      apiKey: process.env.OPENAI_API_KEY!,
      model: process.env.MANAGER_TEACH_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe',
      chunkSeconds: 300,
      requestTimeoutMs: 120_000,
    }), observations);
    const mediaProcessor = new ManagerTeachMediaProcessor({
      extractor,
      ocr,
      transcriber,
      logger,
      ocrConcurrency: 2,
      transcriptionModel: process.env.MANAGER_TEACH_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe',
    });
    const modelId = process.env.MANAGER_TEACH_PERSONA_MODEL?.trim() || 'deepseek-v4-pro';
    const deepSeek = createDeepSeek({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      ...(process.env.DEEPSEEK_BASE_URL?.trim()
        ? { baseURL: process.env.DEEPSEEK_BASE_URL.trim() }
        : {}),
    });
    const basePersonaExtractor = new DeepSeekManagerTeachPersonaExtractor(
      deepSeek(modelId),
      modelId,
      300_000,
    );
    const personaExtractor = {
      provider: basePersonaExtractor.provider,
      modelId: basePersonaExtractor.modelId,
      extract: async (input: Parameters<typeof basePersonaExtractor.extract>[0]) => {
        observations.personaCalls += 1;
        const patch = await basePersonaExtractor.extract(input);
        observations.proposedChanges = patch.changes.length;
        return patch;
      },
    };
    const personaProcessor = new ManagerTeachPersonaProcessor({
      prisma,
      extractor: personaExtractor,
      logger,
      minConfidence: 0.9,
      maxEvidenceBytes: 5 * 1_024 * 1_024,
      maxInputChars: 800_000,
    });
    const queueName = `manager-teach-smoke-${randomUUID()}`;
    queue = new ManagerTeachQueue(redisUrl, queueName);
    const service = new ManagerTeachService({
      prisma,
      queue,
      logger,
      mediaProcessor,
      personaProcessor,
      maxVideoBytes: 100 * 1_024 * 1_024,
      rawRetentionHours: 1,
    });
    const revisions = new ManagerPersonaRevisionService({ prisma, logger });
    worker = new ManagerTeachWorker({
      redisUrl,
      queueName,
      service,
      logger,
      concurrency: 1,
    });
    worker.start();

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/desktop/teach', createManagerTeachRoutes({
      prisma,
      memberJwtSecret: JWT_SECRET,
      logger,
      service,
      revisions,
      uploadDir,
      maxVideoBytes: 100 * 1_024 * 1_024,
    }));
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/api/desktop/teach`;
    const token = signMemberToken(identity);

    process.stdout.write('Running real Teach pipeline\n');
    const created = await requestJson<{ data: ManagerTeachSessionView }>(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        departmentId: identity.departmentId,
        source: 'upload',
        originalFileName: 'weekly-status-teaching.mp4',
        mimeType: 'video/mp4',
        fileSize: video.size,
      }),
    });
    const videoBytes = await readFile(videoPath);
    await requestJson<{ data: ManagerTeachSessionView }>(`${baseUrl}/sessions/${created.data.id}/video`, {
      method: 'PUT',
      headers: authHeaders(token, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(videoBytes.byteLength),
      }),
      body: new Uint8Array(videoBytes),
    });
    const completed = await pollSession(baseUrl, created.data.id, token, 10 * 60_000);
    assert.equal(
      completed.status,
      'persona_updated',
      `Teach finished with ${completed.status}: ${safeMessage(completed.lastError)}`,
    );
    assert(completed.appliedChangeCount > 0, 'Teach did not apply a persona change');
    assert(observations.extractedFrames > 0, 'Peepshow returned no frames');
    assert(observations.extractedAudio, 'Peepshow returned no audio');
    assert(observations.ocrCalls > 0, 'Qwen OCR was not called');
    assert.match(observations.ocrText, /weekly|risk/i, 'OCR did not recognize the synthetic report');
    assert(observations.transcript, 'OpenAI transcription was not called');
    assert.match(observations.transcript.text, /weekly|risk/i, 'STT did not recognize the narrated workflow');
    assert.equal(observations.personaCalls, 1, 'DeepSeek persona synthesis should run once');
    assert(observations.proposedChanges > 0, 'DeepSeek proposed no persona change');

    const tree = await prisma.managerPersonaTree.findUnique({
      where: {
        companyId_managerId_departmentId: {
          companyId: identity.companyId,
          managerId: identity.userId,
          departmentId: identity.departmentId,
        },
      },
      include: { nodes: true, revisions: true },
    });
    assert(tree, 'Persona tree was not created');
    assert(tree.nodes.some(node => /risk/i.test(node.instruction)), 'Persona did not preserve risks-first guidance');
    assert.equal(tree.revisions.length, 1, 'Teach should create one Undo snapshot');
    await waitForArtifactsDeleted(prisma, created.data.id, 30_000);

    const undo = await requestJson<{
      data: { treeId: string; revision: number; restoredFromRevision: number; remainingUndos: number };
    }>(`${baseUrl}/persona/${identity.departmentId}/undo`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    assert.equal(undo.data.remainingUndos, 0);
    const afterUndo = await prisma.managerPersonaTree.findUnique({
      where: { id: tree.id },
      include: { nodes: true, revisions: true },
    });
    assert(afterUndo, 'Persona tree disappeared after Undo');
    assert.equal(afterUndo.nodes.length, 0, 'Undo did not restore the empty persona');
    assert.equal(afterUndo.revisions.length, 0, 'Undo snapshot was not consumed');

    process.stdout.write('\nManager Teach end-to-end smoke: PASS\n');
    process.stdout.write(`  Peepshow frames: ${observations.extractedFrames}\n`);
    process.stdout.write(`  Qwen OCR calls: ${observations.ocrCalls} (${observations.ocrModel})\n`);
    process.stdout.write(`  OpenAI transcript segments: ${observations.transcript.segments.length}\n`);
    process.stdout.write(`  DeepSeek proposed/applied: ${observations.proposedChanges}/${completed.appliedChangeCount}\n`);
    process.stdout.write('  Raw/evidence cleanup: PASS\n');
    process.stdout.write('  Persona Undo: PASS\n');
  } catch (error) {
    if (postgres) process.stderr.write(`\nPostgreSQL tail:\n${postgres.tail()}\n`);
    if (redis) process.stderr.write(`\nRedis tail:\n${redis.tail()}\n`);
    throw error;
  } finally {
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleInterrupt);
    await cleanup();
  }
}

async function seedManager(prisma: PrismaClientType) {
  const companyId = randomUUID();
  const userId = randomUUID();
  const departmentId = randomUUID();
  const roleId = randomUUID();
  const sessionId = randomUUID();
  await prisma.company.create({ data: { id: companyId, name: 'Divo Teach Smoke Company' } });
  await prisma.user.create({
    data: { id: userId, email: `teach-smoke-${randomUUID()}@example.test`, password: 'not-used-in-smoke' },
  });
  await prisma.adminMembership.create({
    data: { userId, companyId, role: 'MEMBER', isActive: true },
  });
  await prisma.department.create({
    data: { id: departmentId, companyId, name: 'Operations', slug: 'operations' },
  });
  await prisma.departmentRole.create({
    data: { id: roleId, departmentId, name: 'Manager', slug: 'MANAGER', isSystem: true },
  });
  await prisma.departmentMembership.create({
    data: { departmentId, userId, roleId, status: 'active' },
  });
  await prisma.memberSession.create({
    data: {
      sessionId,
      userId,
      companyId,
      role: 'MEMBER',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  return { companyId, userId, departmentId, sessionId };
}

async function createSyntheticRecording(audioPath: string, videoPath: string): Promise<void> {
  await runCommand('/usr/bin/say', [
    '-v', 'Samantha',
    '-r', '150',
    '-o', audioPath,
    NARRATION,
  ]);
  const svgPath = join(dirname(videoPath), 'weekly-status-screen.svg');
  const pngPath = join(dirname(videoPath), 'weekly-status-screen.png');
  await writeFile(svgPath, `
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#e9eaec"/>
  <rect x="55" y="45" width="1170" height="630" rx="18" fill="#ffffff"/>
  <g font-family="Helvetica, Arial, sans-serif">
    <text x="105" y="145" fill="#111111" font-size="48" font-weight="700">WEEKLY STATUS REPORT</text>
    <text x="105" y="240" fill="#b42318" font-size="42" font-weight="700">RISKS</text>
    <text x="135" y="305" fill="#333333" font-size="32">1. Delivery dependency</text>
    <text x="105" y="420" fill="#067647" font-size="38" font-weight="700">ACHIEVEMENTS</text>
    <text x="105" y="545" fill="#175cd3" font-size="38" font-weight="700">NEXT STEPS</text>
  </g>
</svg>
  `.trim(), 'utf8');
  await runCommand('/usr/bin/sips', ['-s', 'format', 'png', svgPath, '--out', pngPath]);
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', '15', '-i', pngPath,
    '-i', audioPath,
    '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    videoPath,
  ]);
}

function observeMediaExtractor(
  delegate: ManagerTeachMediaExtractor,
  observations: Observations,
): ManagerTeachMediaExtractor {
  return {
    extract: async input => {
      const result = await delegate.extract(input);
      observations.extractedFrames = result.frames.length;
      observations.extractedAudio = Boolean(result.audio?.path && !result.audio.skippedReason);
      return result;
    },
  };
}

function observeOcr(delegate: ManagerTeachFrameOcr, observations: Observations): ManagerTeachFrameOcr {
  return {
    extract: async framePath => {
      observations.ocrCalls += 1;
      try {
        const result = await delegate.extract(framePath);
        observations.ocrModel = result.model;
        observations.ocrText += `\n${result.ocrText}`;
        return result;
      } catch (error) {
        process.stderr.write(`  Qwen OCR provider error: ${safeMessage(error)}\n`);
        throw error;
      }
    },
  };
}

function observeTranscriber(
  delegate: ManagerTeachTranscriber,
  observations: Observations,
): ManagerTeachTranscriber {
  return {
    transcribe: async input => {
      const result = await delegate.transcribe(input);
      observations.transcript = result;
      return result;
    },
  };
}

async function pollSession(
  baseUrl: string,
  sessionId: string,
  token: string,
  timeoutMs: number,
): Promise<ManagerTeachSessionView> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const response = await requestJson<{ data: ManagerTeachSessionView }>(`${baseUrl}/sessions/${sessionId}`, {
      headers: authHeaders(token),
    });
    if (response.data.status !== lastStatus) {
      lastStatus = response.data.status;
      process.stdout.write(`  session: ${response.data.status} (${response.data.progress}%)\n`);
    }
    if (TERMINAL_STATUSES.has(response.data.status)) return response.data;
    await delay(1_000);
  }
  throw new Error(`Teach session did not complete within ${Math.round(timeoutMs / 1_000)} seconds`);
}

async function waitForArtifactsDeleted(prisma: PrismaClientType, sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const available = await prisma.managerTeachArtifact.count({
      where: { sessionId, status: 'available' },
    });
    if (available === 0) return;
    await delay(250);
  }
  throw new Error('Teach artifacts were not cleaned after persona synthesis');
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 1_000)}`);
  }
  return JSON.parse(text) as T;
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function signMemberToken(identity: {
  sessionId: string;
  userId: string;
  companyId: string;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    ...identity,
    role: 'MEMBER',
    exp: Math.floor(Date.now() / 1_000) + 60 * 60,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function startProcess(command: string, args: readonly string[], name: string): ManagedProcess {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-20_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return { name, child, tail: () => output.trim() };
}

async function stopProcess(processHandle: ManagedProcess | undefined): Promise<void> {
  if (!processHandle || processHandle.child.exitCode !== null) return;
  const exited = once(processHandle.child, 'exit');
  processHandle.child.kill('SIGTERM');
  const timedOut = delay(5_000).then(() => 'timeout' as const);
  if (await Promise.race([exited.then(() => 'exit' as const), timedOut]) === 'timeout') {
    processHandle.child.kill('SIGKILL');
    await once(processHandle.child, 'exit').catch(() => undefined);
  }
}

async function waitForPort(port: number, processHandle: ManagedProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null) {
      throw new Error(`${processHandle.name} exited during startup: ${processHandle.tail()}`);
    }
    if (await canConnect(port)) return;
    await delay(100);
  }
  throw new Error(`${processHandle.name} did not listen on port ${port}: ${processHandle.tail()}`);
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(250);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-20_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${output.trim()}`));
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function requireConfiguration(names: readonly string[]): void {
  const missing = names.filter(name => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
}

function safeMessage(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').slice(0, 1_000);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  process.stderr.write(`\nManager Teach end-to-end smoke: FAIL\n${safeMessage(error)}\n`);
  process.exitCode = 1;
});
