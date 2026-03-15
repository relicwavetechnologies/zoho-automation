#!/usr/bin/env node

const path = require('path');
const crypto = require('crypto');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const DEFAULT_MESSAGE = 'Use daily-stuff for today and tell me what you need from me before you start.';

const args = process.argv.slice(2);

const readArg = (name) => {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
};

const hasFlag = (name) => args.includes(name);

const trimInline = (value, limit = 180) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).trimEnd()}...`;
};

const fail = (message, details) => {
  console.error(`[desktop-langgraph-debug] ${message}`);
  if (details !== undefined) {
    console.error(JSON.stringify(details, null, 2));
  }
  process.exit(1);
};

const info = (message, details) => {
  console.log(`[desktop-langgraph-debug] ${message}`);
  if (details !== undefined) {
    console.log(JSON.stringify(details, null, 2));
  }
};

const parseJsonBody = async (res) => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const fetchThreadPage = async ({ token, threadId, limit = 12 }) => {
  const response = await fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}?limit=${limit}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    fail('Failed to load thread history', {
      status: response.status,
      body: await parseJsonBody(response),
    });
  }

  const body = await response.json();
  return body?.data ?? body;
};

const clearThreadHistory = async ({ token, threadId }) => {
  const response = await fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}/history`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok && response.status !== 204) {
    fail('Failed to clear thread history', {
      status: response.status,
      body: await parseJsonBody(response),
    });
  }
};

const summarizeMessageMetadata = (message) => {
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const progressEvents = Array.isArray(metadata.progressEvents) ? metadata.progressEvents.length : 0;
  const contentBlocks = Array.isArray(metadata.contentBlocks) ? metadata.contentBlocks.length : 0;
  const hasProfile = Boolean(metadata.controllerProfile);
  const hasSnapshot = Boolean(metadata.controllerStateSnapshot);
  const hasObservations = Array.isArray(metadata.controllerObservations) && metadata.controllerObservations.length > 0;
  return {
    id: message?.id,
    role: message?.role,
    contentPreview: trimInline(message?.content ?? '', 140),
    progressEvents,
    contentBlocks,
    hasProfile,
    hasSnapshot,
    hasObservations,
  };
};

const ensureThreadId = async ({ token, threadId }) => {
  if (threadId) return threadId;

  const response = await fetch(`${BACKEND_URL}/api/desktop/threads`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ preferredEngine: 'langgraph' }),
  });

  if (!response.ok) {
    fail('Failed to create desktop thread', {
      status: response.status,
      body: await parseJsonBody(response),
    });
  }

  const body = await response.json();
  const createdThreadId = body?.id || body?.data?.id;
  if (!createdThreadId) {
    fail('Thread create response did not include an id', body);
  }
  return createdThreadId;
};

const summarizeEvent = (event) => {
  if (!event || typeof event !== 'object') return trimInline(event);
  if (event.type === 'activity' || event.type === 'activity_done') {
    return trimInline(`${event.data?.label || event.data?.name || event.type}${event.data?.resultSummary ? ` :: ${event.data.resultSummary}` : ''}`);
  }
  if (event.type === 'progress') {
    const data = event.data || {};
    return trimInline(`${data.type}${data.workerKey ? ` ${data.workerKey}` : ''}${data.actionKind ? `/${data.actionKind}` : ''}${data.summary ? ` :: ${data.summary}` : ''}${data.reason ? ` :: ${data.reason}` : ''}`);
  }
  if (event.type === 'text' || event.type === 'error' || event.type === 'thinking') {
    return trimInline(event.data);
  }
  if (event.type === 'done') {
    return 'done';
  }
  if (event.type === 'action') {
    return trimInline(JSON.stringify(event.data));
  }
  return trimInline(JSON.stringify(event.data));
};

const runStreamTurn = async ({ token, threadId, message, mode, timeoutMs, companyId, workspacePath, workspaceName }) => {
  const executionId = crypto.randomUUID();

  info('Starting stream debug run', {
    backendUrl: BACKEND_URL,
    threadId,
    executionId,
    mode,
    message,
  });

  const response = await fetch(`${BACKEND_URL}/api/desktop/chat/${threadId}/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      message,
      mode,
      engine: 'langgraph',
      executionId,
      ...(companyId ? { companyId } : {}),
      ...(workspacePath ? { workspace: { name: workspaceName || 'workspace', path: workspacePath } } : {}),
    }),
  });

  if (!response.ok || !response.body) {
    fail('Stream request failed', {
      status: response.status,
      body: await parseJsonBody(response),
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false;
  let lastEventAt = Date.now();
  let eventCount = 0;
  let terminalType = null;
  let terminalText = null;
  const events = [];

  const timeoutHandle = setInterval(() => {
    if (Date.now() - lastEventAt > timeoutMs) {
      console.error(`[desktop-langgraph-debug] stream stalled for > ${timeoutMs}ms`);
      process.exit(2);
    }
  }, 2_000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const dataLines = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6));

        if (dataLines.length === 0) continue;
        const raw = dataLines.join('\n').trim();
        if (!raw) continue;

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          fail('Malformed SSE frame received', { raw, error: String(error) });
        }

        events.push(parsed);
        lastEventAt = Date.now();
        eventCount += 1;
        console.log(`[event ${eventCount}] ${parsed.type}: ${summarizeEvent(parsed)}`);

        if (parsed.type === 'done' || parsed.type === 'error') {
          sawTerminal = true;
        }
        if (parsed.type === 'progress') {
          const progressType = parsed?.data?.type;
          if (progressType === 'ask_user') {
            terminalType = 'ASK_USER';
            terminalText = parsed?.data?.question ?? terminalText;
          } else if (progressType === 'complete') {
            terminalType = 'COMPLETE';
            terminalText = parsed?.data?.reply ?? terminalText;
          } else if (progressType === 'fail') {
            terminalType = 'FAIL';
            terminalText = parsed?.data?.reason ?? terminalText;
          }
        }
        if (parsed.type === 'text' && typeof parsed.data === 'string') {
          terminalText = parsed.data;
        }
      }
    }
  } finally {
    clearInterval(timeoutHandle);
  }

  return {
    threadId,
    executionId,
    eventCount,
    sawTerminal,
    terminalType,
    terminalText,
    events,
  };
};

const main = async () => {
  const token = (readArg('--token') || process.env.DESKTOP_AUTH_TOKEN || '').trim();
  const threadIdArg = readArg('--thread-id');
  const message = readArg('--message') || DEFAULT_MESSAGE;
  const followUp = readArg('--follow-up');
  const mode = readArg('--mode') || 'xtreme';
  const timeoutMs = Number(readArg('--timeout-ms') || 60_000);
  const companyId = readArg('--company-id');
  const workspacePath = readArg('--workspace-path');
  const workspaceName = readArg('--workspace-name') || (workspacePath ? path.basename(workspacePath) : undefined);
  const historyLimit = Number(readArg('--history-limit') || 12);
  const interactiveFollowUp = hasFlag('--interactive-follow-up');
  const clearThreadFirst = hasFlag('--clear-thread-first');

  if (!token) {
    fail('Pass --token or set DESKTOP_AUTH_TOKEN.');
  }

  const threadId = await ensureThreadId({ token, threadId: threadIdArg });
  if (clearThreadFirst) {
    info('Clearing thread history before run', { threadId });
    await clearThreadHistory({ token, threadId });
  }
  const firstTurn = await runStreamTurn({
    token,
    threadId,
    message,
    mode,
    timeoutMs,
    companyId,
    workspacePath,
    workspaceName,
  });

  if (!firstTurn.sawTerminal && !hasFlag('--allow-no-terminal')) {
    fail('Stream ended without a terminal done/error event', {
      threadId,
      executionId: firstTurn.executionId,
    });
  }

  let secondTurn = null;
  let replyText = followUp;
  if (!replyText && interactiveFollowUp && firstTurn.terminalType === 'ASK_USER') {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    replyText = await rl.question(`[desktop-langgraph-debug] Assistant asked: ${firstTurn.terminalText}\nFollow-up> `);
    await rl.close();
  }

  if (replyText && firstTurn.terminalType === 'ASK_USER') {
    info('Running follow-up turn', {
      threadId,
      replyText,
    });
    secondTurn = await runStreamTurn({
      token,
      threadId,
      message: replyText,
      mode,
      timeoutMs,
      companyId,
      workspacePath,
      workspaceName,
    });
    if (!secondTurn.sawTerminal && !hasFlag('--allow-no-terminal')) {
      fail('Follow-up stream ended without a terminal done/error event', {
        threadId,
        executionId: secondTurn.executionId,
      });
    }
  }

  const history = await fetchThreadPage({ token, threadId, limit: historyLimit });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const summarizedMessages = messages.map(summarizeMessageMetadata);

  info('Thread history check', {
    threadId,
    totalMessagesFetched: messages.length,
    messages: summarizedMessages,
  });

  const assistantMessages = messages.filter((message) => message?.role === 'assistant');
  const latestAssistant = assistantMessages[assistantMessages.length - 1];
  const previousAssistant = assistantMessages[assistantMessages.length - 2];

  info('Continuation audit', {
    firstTurn: {
      executionId: firstTurn.executionId,
      terminalType: firstTurn.terminalType,
      terminalText: trimInline(firstTurn.terminalText ?? '', 200),
      eventCount: firstTurn.eventCount,
    },
    secondTurn: secondTurn
      ? {
        executionId: secondTurn.executionId,
        terminalType: secondTurn.terminalType,
        terminalText: trimInline(secondTurn.terminalText ?? '', 200),
        eventCount: secondTurn.eventCount,
      }
      : null,
    persistedPreviousAssistant: previousAssistant ? summarizeMessageMetadata(previousAssistant) : null,
    persistedLatestAssistant: latestAssistant ? summarizeMessageMetadata(latestAssistant) : null,
  });
};

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
