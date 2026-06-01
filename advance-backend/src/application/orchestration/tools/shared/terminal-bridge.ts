/**
 * Terminal bridge registry — connects the channel-agnostic `runCommand` tool to
 * a channel that can host a USER-FACING terminal (currently: desktop only).
 *
 * Execution happens on the *client's* machine (the Tauri Rust process), not on
 * the backend. The backend tool simply sends an exec request to the client over
 * the WebSocket and awaits the result. The desktop adapter implements this
 * round-trip and registers itself under the chatId for the duration of a run.
 */

export interface TerminalExecRequest {
  readonly callId: string;
  readonly command: string;
  /** Suggested working directory (the thread's workspace path). Client may override. */
  readonly cwd: string;
  /** Whether the model asked for network access — the client gate surfaces it. */
  readonly net: boolean;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly status: 'completed' | 'declined' | 'blocked' | 'unavailable';
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly timedOut?: boolean;
  /** Human/LLM-facing note — carries the "declined by user" message, etc. */
  readonly message?: string;
}

/**
 * Implemented by a channel that can run a command on the user's machine.
 * `execute` sends the request to the client and resolves when the client
 * reports back (run → result, or decline). `resolveResult` is called by the
 * gateway when the client's `terminal.exec.result` message arrives.
 */
export interface TerminalBridge {
  execute(req: TerminalExecRequest): Promise<ExecResult>;
  resolveResult(callId: string, result: ExecResult): void;
}

class TerminalRegistry {
  private readonly bridges = new Map<string, TerminalBridge>();

  register(chatId: string, bridge: TerminalBridge): void {
    this.bridges.set(chatId, bridge);
  }

  unregister(chatId: string): void {
    this.bridges.delete(chatId);
  }

  get(chatId: string): TerminalBridge | undefined {
    return this.bridges.get(chatId);
  }
}

/** Process-wide singleton. */
export const terminalRegistry = new TerminalRegistry();
