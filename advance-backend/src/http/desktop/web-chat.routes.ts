import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import type { WebRunEvent, WebRunService } from '../../application/runtime/web-run.service';
import { WebRunBusyError, type WebRunRegistry } from '../../application/runtime/web-run-registry';
import { intakeUploads, type UploadTranscriber } from '../../application/runtime/upload-intake';
import type { WebThreadRepoPort } from '../../infrastructure/persistence/web-thread.repository';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { RunContext } from '../../domain/orchestration/run-context';
import {
  DEFAULT_MODEL,
  PROXY_MODELS,
  RUNTIME_REASONING_EFFORTS,
  specFor,
  supportsReasoningEffort,
} from '../../application/observability/pricing';

/**
 * Divo, driven from the browser.
 *
 * Two halves. The **run** routes are level-1 parity: ask, watch, stop, hand over
 * a file — anything a person does in a Lark DM, against the same run behind it.
 * The **thread** routes are what makes that a place rather than an event: a
 * conversation has an id, the id is in the URL, and it is still there tomorrow.
 *
 * The thread half exists because the run half was built as though a conversation
 * were a single request. It was not: a person asks, walks away, comes back, asks
 * again, and opens a second conversation alongside the first. Every one of those
 * was impossible while the thread id was a variable in a React component.
 *
 * Not here, on purpose: group chats. Lark does those and does them well; the
 * web is one person at a desk. See `plans/divo-one-soul-two-surfaces.md`.
 */

/** Well under the 60s an idle connection is usually reclaimed at. */
const HEARTBEAT_MS = 15_000;

/**
 * A thread id is minted by the browser and asserted here.
 *
 * Client-minted so that opening a new conversation costs no round trip — the
 * URL is correct from the first keystroke, and the thread comes into being when
 * something is actually said in it. Constrained to a shape rather than trusted:
 * it becomes a database key and appears in a URL, so it may not be a sentence.
 */
const threadIdSchema = z.string().regex(/^web_[A-Za-z0-9-]{8,64}$/, 'malformed thread id');

const askSchema = z.object({
  threadId: threadIdSchema,
  text: z.string().min(1).max(20_000),
  model: z.enum(PROXY_MODELS).optional(),
  reasoningEffort: z.enum(RUNTIME_REASONING_EFFORTS).optional(),
});

const renameSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export function createWebChatRoutes(deps: {
  readonly webRuns: WebRunService;
  readonly registry: WebRunRegistry;
  readonly threads: WebThreadRepoPort;
  readonly logger: Logger;
  readonly maxUploadBytes: number;
  /**
   * Turns an uploaded recording into text. Optional because it is optional in
   * the deployment: without a transcription key Lark refuses voice notes too,
   * and the web says the same thing rather than pretending to have listened.
   */
  readonly transcriber?: UploadTranscriber;
}) {
  const router = Router();
  const log = deps.logger.child({ service: 'web-chat-routes' });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 4, fileSize: deps.maxUploadBytes },
  });

  /* ── Threads ─────────────────────────────────────────────
     The conversation as an object: list them, read one back, rename it, throw
     it away. Retention is the reader's decision and never a timer — see the
     retention note in `plans/divo-one-soul-two-surfaces.md`. */

  router.get('/threads', async (_req, res) => {
    const identity = identityFrom(res);
    if (!identity) return unauthenticated(res);
    const listed = await deps.threads.list({
      companyId: String(identity.runContext.companyId),
      userId: identity.userId,
    });
    if (!listed.ok) {
      log.error('web_chat.threads.list_failed', { error: String(listed.error) });
      res.status(500).json({ ok: false, error: 'threads_unavailable' });
      return;
    }
    // A thread whose run is still going is marked here rather than inferred by
    // the reader from timestamps, which cannot tell "working" from "finished a
    // second ago".
    const running = new Set(deps.registry.activeFor(identity.userId).map(run => run.threadId));
    res.json({
      ok: true,
      threads: listed.value.map(thread => ({ ...thread, running: running.has(thread.threadId) })),
    });
  });

  router.get('/threads/:threadId', async (req, res) => {
    const identity = identityFrom(res);
    if (!identity) return unauthenticated(res);
    const threadId = threadIdSchema.safeParse(req.params['threadId']);
    if (!threadId.success) {
      res.status(400).json({ ok: false, error: 'invalid_thread_id' });
      return;
    }
    /* The oldest turn the reader already has. Anything unparseable is treated
       as absent rather than rejected: the worst a junk cursor can do is return
       the newest page, which is the same thing a first open asks for. */
    const before = Number(req.query['before']);
    const found = await deps.threads.get({
      companyId: String(identity.runContext.companyId),
      userId: identity.userId,
      threadId: threadId.data,
      ...(Number.isSafeInteger(before) && before > 0 ? { before } : {}),
    });
    if (!found.ok) {
      log.error('web_chat.threads.get_failed', { error: String(found.error) });
      res.status(500).json({ ok: false, error: 'threads_unavailable' });
      return;
    }
    // A thread nobody has spoken into yet is not an error. The browser navigates
    // to its id the moment it is minted, and answering 404 there would make an
    // empty new conversation look like a broken link.
    const active = deps.registry.find(identity.userId, threadId.data);
    res.json({
      ok: true,
      thread: found.value ?? {
        threadId: threadId.data,
        title: 'New chat',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        preview: '',
        messageCount: 0,
        turns: [],
        hasEarlier: false,
      },
      ...(active && !active.settled
        ? {
          running: {
            runId: active.runId,
            prompt: active.prompt,
            attachments: active.attachments,
            startedAt: active.startedAt,
          },
        }
        : {}),
    });
  });

  router.patch('/threads/:threadId', async (req, res) => {
    const identity = identityFrom(res);
    if (!identity) return unauthenticated(res);
    const threadId = threadIdSchema.safeParse(req.params['threadId']);
    const body = renameSchema.safeParse(req.body);
    if (!threadId.success || !body.success) {
      res.status(400).json({ ok: false, error: 'invalid_request' });
      return;
    }
    const renamed = await deps.threads.rename({
      companyId: String(identity.runContext.companyId),
      userId: identity.userId,
      threadId: threadId.data,
      title: body.data.title,
    });
    if (!renamed.ok) {
      log.error('web_chat.threads.rename_failed', { error: String(renamed.error) });
      res.status(500).json({ ok: false, error: 'threads_unavailable' });
      return;
    }
    if (!renamed.value) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/threads/:threadId', async (req, res) => {
    const identity = identityFrom(res);
    if (!identity) return unauthenticated(res);
    const threadId = threadIdSchema.safeParse(req.params['threadId']);
    if (!threadId.success) {
      res.status(400).json({ ok: false, error: 'invalid_thread_id' });
      return;
    }
    // Stopped first. Deleting the conversation a run is still writing into
    // would leave the run working towards a place that no longer exists.
    deps.registry.stop(identity.userId, threadId.data);
    const removed = await deps.threads.remove({
      companyId: String(identity.runContext.companyId),
      userId: identity.userId,
      threadId: threadId.data,
    });
    if (!removed.ok) {
      log.error('web_chat.threads.delete_failed', { error: String(removed.error) });
      res.status(500).json({ ok: false, error: 'threads_unavailable' });
      return;
    }
    if (!removed.value) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  /* ── Runs ────────────────────────────────────────────────
     Starting a run and watching one are separate things now. The run belongs to
     the registry; a request here is only ever a view onto it, which is why
     closing this connection does nothing to the work. */

  /**
   * Ask, and watch the work happen.
   *
   * Multipart rather than JSON so a file travels with the ask it belongs to.
   * A separate upload endpoint would have had to park the file somewhere
   * between two requests, which is state nobody needs: on Lark the file and the
   * message arrive together, and they should here too.
   */
  router.post('/runs', (req, res) => {
    upload.array('files', 4)(req, res, error => {
      if (error) {
        const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
        res.status(tooLarge ? 413 : 400).json({
          ok: false,
          error: tooLarge ? 'file_too_large' : 'invalid_upload',
        });
        return;
      }
      void startRun(req, res);
    });
  });

  const startRun = async (req: Request, res: Response): Promise<void> => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid_request', message: parsed.error.issues[0]?.message });
      return;
    }
    const identity = identityFrom(res);
    if (!identity) return unauthenticated(res);

    const { threadId, text } = parsed.data;
    const selectedModel = parsed.data.model ?? DEFAULT_MODEL;
    const selectedEffort = parsed.data.reasoningEffort
      ?? specFor(selectedModel).defaultReasoningEffort;
    if (!supportsReasoningEffort(selectedModel, selectedEffort)) {
      res.status(400).json({ ok: false, error: 'invalid_reasoning_effort' });
      return;
    }
    // Old clients that send neither field retain the channel default. Once a
    // client names either half, make the pair explicit so no layer can silently
    // substitute a different value.
    const modelSelection = parsed.data.model || parsed.data.reasoningEffort
      ? { model: selectedModel, reasoningEffort: selectedEffort }
      : undefined;
    const runId = randomUUID();
    const controller = new AbortController();

    // Every file is classified before any of it reaches the container, and the
    // outcome is always visible to the model — a transcript, a named refusal,
    // or a real path. Silently staging whatever arrived is what let the browser
    // accept files a Lark DM refuses. See `upload-intake`.
    const intake = await intakeUploads({
      files: (req.files as Express.Multer.File[] | undefined) ?? [],
      text,
      ...(deps.transcriber ? { transcriber: deps.transcriber } : {}),
      logger: log,
      abortSignal: controller.signal,
    });
    const attachments = intake.attachments;

    try {
      deps.registry.start({
        runId,
        threadId,
        userId: identity.userId,
        // What the person typed, not what the run was given. The prompt is
        // echoed back into the thread and the rail, and a reader seeing their
        // own message quoted with a transcript and two refusals stapled to the
        // front of it would not recognise it as theirs.
        prompt: text,
        attachments: intake.manifest,
        controller,
        events: deps.webRuns.run({
          runContext: identity.runContext,
          threadId,
          text: intake.text,
          userExternalId: identity.userId,
          sessionId: identity.sessionId,
          ...(modelSelection ? { modelSelection } : {}),
          ...(attachments.length ? { attachments } : {}),
          // What the thread shows back afterwards: their words, and every file
          // they handed over — including the ones nothing could be done with.
          ask: { text, attachments: intake.manifest },
          abortSignal: controller.signal,
        }),
      });
    } catch (error) {
      if (error instanceof WebRunBusyError) {
        res.status(409).json({ ok: false, error: error.code, message: error.message });
        return;
      }
      throw error;
    }

    await streamRun(res, identity.userId, threadId, runId);
  };

  /**
   * Watch a run already going.
   *
   * The route a reader comes back to. Same frames, same order, from wherever
   * the run has reached — a reload or a second tab is a new view, never a new
   * run. 204 when there is nothing going on, so the browser can ask this on
   * every thread open without inventing a run that does not exist.
   */
  router.get('/runs/:threadId/stream', async (req, res) => {
    const identity = identityFrom(res);
    if (!identity) return unauthenticated(res);
    const threadId = threadIdSchema.safeParse(req.params['threadId']);
    if (!threadId.success) {
      res.status(400).json({ ok: false, error: 'invalid_thread_id' });
      return;
    }
    const active = deps.registry.find(identity.userId, threadId.data);
    if (!active) {
      res.status(204).end();
      return;
    }
    await streamRun(res, identity.userId, threadId.data, active.runId);
  });

  /**
   * Stop a run that is still going.
   *
   * A separate route rather than "close the connection", because the point of
   * stopping is to hear what happened: the runtime answers "Stopped. I did not
   * continue this request." and that reply arrives down every open view.
   */
  router.post('/runs/:threadId/stop', (req: Request, res: Response) => {
    const identity = identityFrom(res);
    if (!identity) return unauthenticated(res);
    const threadId = threadIdSchema.safeParse(req.params['threadId']);
    if (!threadId.success) {
      res.status(400).json({ ok: false, error: 'invalid_thread_id' });
      return;
    }
    if (!deps.registry.stop(identity.userId, threadId.data)) {
      res.status(404).json({ ok: false, error: 'not_running' });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * One view onto a run, as SSE.
   *
   * The connection closing is not the run's business — no abort is wired to it.
   * That single line used to be the reason a reader who switched tab came back
   * to nothing.
   */
  const streamRun = async (
    res: Response,
    userId: string,
    threadId: string,
    runId: string,
  ): Promise<void> => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    // Proxies that buffer will hold the whole stream until the run ends, which
    // turns a live work log into a single delayed dump.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    if (!await send(res, 'open', { runId, threadId })) return;

    // A run can work for minutes without producing a frame worth showing, and an
    // idle connection is what a proxy or a laptop sleeping reclaims first. A
    // comment costs nothing, is ignored by every SSE reader, and keeps the
    // connection provably alive.
    let open = true;
    let heartbeatInFlight = false;
    res.on('close', () => { open = false; });
    const heartbeat = setInterval(() => {
      if (!open || heartbeatInFlight) return;
      heartbeatInFlight = true;
      void writeFrame(res, ': keep-alive\n\n').finally(() => { heartbeatInFlight = false; });
    }, HEARTBEAT_MS);

    try {
      for await (const event of deps.registry.attach(userId, threadId)) {
        if (!open) break;
        if (!await send(res, event.type, event)) break;
      }
    } catch (error) {
      log.error('web_chat.stream_failed', { error: String(error), runId });
      if (open) {
        await send(res, 'error', {
          type: 'error',
          code: 'stream_failed',
          message: 'Divo hit a temporary problem while finishing this request. Please try again.',
        });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  };

  return router;
}

function unauthenticated(res: Response): void {
  res.status(401).json({ ok: false, error: 'unauthenticated' });
}

function identityFrom(
  res: Response,
): { userId: string; sessionId: string; runContext: RunContext } | null {
  const companyId = res.locals['companyId'] as string | undefined;
  const userId = res.locals['userId'] as string | undefined;
  const aiRole = res.locals['aiRole'] as string | undefined;
  // The session the caller authenticated with. The runtime needs it by name: a
  // web run carries no Lark open id, which is the only other way to find one.
  const sessionId = res.locals['sessionId'] as string | undefined;
  if (!companyId || !userId || !aiRole || !sessionId) return null;
  const departmentId = res.locals['runtimeDepartmentId'] as string | null | undefined;
  return {
    userId,
    sessionId,
    runContext: {
      companyId: asCompanyId(companyId),
      userId: asUserId(userId),
      companyRole: asCompanyRoleSlug(aiRole),
      channel: 'web',
      ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
      ...(res.locals['email'] ? { requesterEmail: String(res.locals['email']) } : {}),
    },
  };
}

/**
 * One SSE frame.
 *
 * Named events rather than a single `message` channel: the browser can then
 * attach a listener per event type, and a reader tailing the stream by hand can
 * see what each frame is without parsing it.
 */
function send(res: Response, event: string, data: unknown): Promise<boolean> {
  return writeFrame(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Stop pulling from the registry while Node's socket buffer is full. */
function writeFrame(res: Response, frame: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(frame)) return Promise.resolve(true);
  return new Promise(resolve => {
    const cleanup = (): void => {
      res.off('drain', drained);
      res.off('close', closed);
      res.off('error', closed);
    };
    const drained = (): void => { cleanup(); resolve(true); };
    const closed = (): void => { cleanup(); resolve(false); };
    res.once('drain', drained);
    res.once('close', closed);
    res.once('error', closed);
  });
}

export type { WebRunEvent };
