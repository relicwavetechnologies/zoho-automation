import { promises as fs } from 'fs';
import path from 'path';

const LATEST_AGENT_RUN_LOG_PATH = path.resolve(__dirname, '../../latest-agent-run.log');

let writeQueue: Promise<void> = Promise.resolve();

const formatEntry = (input: {
  event: string;
  runId: string;
  payload: unknown;
}): string => {
  const header = [
    `=== ${new Date().toISOString()} :: ${input.event} :: run=${input.runId} ===`,
  ].join('\n');
  let body = '';
  try {
    body = JSON.stringify(input.payload, null, 2);
  } catch (error) {
    body = JSON.stringify({
      serializationError: error instanceof Error ? error.message : 'unknown_error',
    }, null, 2);
  }
  return `${header}\n${body}\n\n`;
};

const enqueueWrite = (operation: () => Promise<void>): Promise<void> => {
  writeQueue = writeQueue
    .then(operation)
    .catch(() => undefined);
  return writeQueue;
};

export const resetLatestAgentRunLog = async (runId: string, payload: unknown): Promise<void> =>
  enqueueWrite(async () => {
    await fs.writeFile(
      LATEST_AGENT_RUN_LOG_PATH,
      formatEntry({ event: 'run.start', runId, payload }),
      'utf8',
    );
  });

export const appendLatestAgentRunLog = async (
  runId: string,
  event: string,
  payload: unknown,
): Promise<void> =>
  enqueueWrite(async () => {
    await fs.appendFile(
      LATEST_AGENT_RUN_LOG_PATH,
      formatEntry({ event, runId, payload }),
      'utf8',
    );
  });

export const getLatestAgentRunLogPath = (): string => LATEST_AGENT_RUN_LOG_PATH;
