import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const AGENT_SEAT_SESSION_VERSION = 1 as const;
export const AGENT_SEAT_DEFAULT_SESSION_PATH = join('.agent-seat', 'session.json');
export const AGENT_SEAT_MAX_HISTORY = 50;

export interface AgentSeatHistoryEntry {
  readonly turn: number;
  readonly at: string;
  readonly kind: 'invoke' | 'gateway' | 'note';
  readonly toolId?: string;
  readonly op?: string;
  readonly request?: unknown;
  readonly response?: unknown;
  readonly note?: string;
}

export interface AgentSeatSession {
  readonly version: typeof AGENT_SEAT_SESSION_VERSION;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly userSelector: string;
  readonly userId: string;
  readonly companyId: string;
  readonly departmentId?: string;
  readonly larkOpenId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly aiRole: string;
  readonly larkTenantKey: string;
  readonly chatId: string;
  readonly runtimeRunId: string;
  readonly runtimeThreadId: string;
  readonly turn: number;
  readonly traceId: string;
  readonly history: readonly AgentSeatHistoryEntry[];
  readonly notes: readonly string[];
}

export function defaultSessionPath(cwd = process.cwd()): string {
  return join(cwd, AGENT_SEAT_DEFAULT_SESSION_PATH);
}

export async function loadAgentSeatSession(
  path = defaultSessionPath(),
): Promise<AgentSeatSession> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as AgentSeatSession;
  if (parsed.version !== AGENT_SEAT_SESSION_VERSION) {
    throw new Error(`Unsupported agent-seat session version: ${String(parsed.version)}`);
  }
  return parsed;
}

export async function saveAgentSeatSession(
  session: AgentSeatSession,
  path = defaultSessionPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export function appendHistory(
  session: AgentSeatSession,
  entry: Omit<AgentSeatHistoryEntry, 'turn' | 'at'>,
): AgentSeatSession {
  const history = [
    ...session.history,
    {
      turn: session.turn,
      at: new Date().toISOString(),
      ...entry,
    },
  ].slice(-AGENT_SEAT_MAX_HISTORY);
  return { ...session, history };
}
