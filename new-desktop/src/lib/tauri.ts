/**
 * Thin wrapper over @tauri-apps/* APIs with a graceful fallback when running
 * outside of Tauri (e.g. plain `pnpm dev` in a browser tab for design work).
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { open } = await import('@tauri-apps/plugin-shell');
  await open(url);
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) {
    // Pure browser preview — return a synthetic path
    return '~/Documents/divo-workspace';
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false });
  if (Array.isArray(selected)) return selected[0] ?? null;
  return selected ?? null;
}

export interface LocalExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

/** Ask the Tauri process to terminate a running command by its callId. */
export async function killLocalCommand(callId: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('kill_command', { callId });
}

/**
 * Run a shell command on the user's machine via the Tauri (Rust) process and
 * stream output chunks through `onChunk`. Resolves with the final result.
 * Outside Tauri (browser design preview) it's a no-op stub.
 */
export async function runLocalCommand(
  callId: string,
  command: string,
  cwd: string | null,
  timeoutMs: number | undefined,
  onChunk: (data: string, stream: 'stdout' | 'stderr') => void,
): Promise<LocalExecResult> {
  if (!isTauri) {
    onChunk(`$ ${command}\n(terminal only runs inside the Divo desktop app)\n`, 'stdout');
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false, cancelled: false };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');

  const unlisten = await listen<{ callId: string; data: string; stream: 'stdout' | 'stderr' }>(
    'terminal://output',
    (event) => {
      if (event.payload.callId === callId) onChunk(event.payload.data, event.payload.stream);
    },
  );

  try {
    return await invoke<LocalExecResult>('run_command', {
      callId,
      command,
      cwd: cwd && cwd.length > 0 ? cwd : null,
      timeoutMs: timeoutMs ?? null,
    });
  } finally {
    unlisten();
  }
}

export interface DeepLinkPayload {
  url: string;
}

/**
 * Subscribe to incoming deep-link events (e.g. divo://auth/callback?code=...&state=...).
 * Returns an unsubscribe function.
 */
export async function onDeepLink(
  handler: (p: DeepLinkPayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
  const unlisten = await onOpenUrl((urls) => {
    for (const url of urls) handler({ url });
  });
  return unlisten;
}

export const tauri = { isTauri, openExternal, pickFolder, onDeepLink };
