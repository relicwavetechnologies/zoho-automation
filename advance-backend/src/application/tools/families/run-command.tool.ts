import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { ok } from '../../../shared/result';
import { ToolError } from '../../../shared/errors';
import { asToolId } from '../../../shared/ids';
import { terminalRegistry } from '../../../infrastructure/channels/desktop/terminal-bridge';

const Schema = z.object({
  command: z.string().min(1).describe('The shell command to run, e.g. "which lark" or "npm test"'),
  withInternetAccess: z.boolean().optional().describe('Set true only if the command needs the network'),
  timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('Hard timeout in ms (default 120000)'),
});
type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  status: z.enum(['completed', 'declined', 'blocked', 'unavailable']),
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().optional(),
  timedOut: z.boolean().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

/** Never run these — hard block on the backend before the request even reaches the client. */
const HARD_BLOCK: RegExp[] = [
  /rm\s+-[rf]{1,2}\s+\/(?:\s|$|\*)/, // rm -rf /
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, // fork bomb
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/(sd|nvme|disk)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
];

export const createRunCommandTool = (): Tool<Args, Res> => ({
  id: asToolId('runCommand'),
  family: 'execution',
  actionGroups: new Set(['execute']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description:
    'Run a shell command on the USER\'s machine (their desktop), streaming live terminal output. ' +
    'Use this to inspect the user\'s local environment — check if a CLI is installed, read files, run tests, git status, etc. ' +
    'Every run is gated: the user must approve it in the desktop app before it executes, so propose the exact command. ' +
    'Only available in the Divo desktop app (not in Lark).',
  parameterDocs:
    '- command: the exact shell command (runs via /bin/sh on the user\'s machine)\n' +
    '- withInternetAccess: set true only if the command needs the network\n' +
    '- timeoutMs: optional hard timeout, default 120s',
  permissionCheck() {
    // Terminal execution is NOT governed by company/department RBAC — it runs on
    // the user's own machine and every command requires the user's explicit
    // Run/Decline approval. The genuine gates live in execute(): the tool is only
    // reachable on the desktop channel (bridge presence), each command is
    // user-approved, and catastrophic commands are hard-blocked. So this always
    // allows at the RBAC layer.
    return ok('execute');
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const chatId = String(ctx.runContext.chatId ?? '');
    const bridge = terminalRegistry.get(chatId);
    if (!bridge) {
      return ok({
        status: 'unavailable',
        message: 'Terminal execution is only available in the Divo desktop app. Ask the user to run the command there.',
      });
    }

    const command = args.command.trim();

    // Backend-side hard block (defense in depth; the client enforces too).
    if (HARD_BLOCK.some(re => re.test(command))) {
      ctx.logger.warn('run_command.blocked', { command });
      return ok({
        status: 'blocked',
        message: `Refused to run "${command}" — it matches a hard safety block (destructive system command). Do not retry.`,
      });
    }

    const cwd = readWorkspacePath(ctx) ?? '';
    const net = !!args.withInternetAccess;
    const callId = `term-${randomUUID()}`;

    ctx.onProgress?.('Waiting for you to approve a command…');

    // Hand off to the user's machine. The client shows the Run/Decline gate,
    // executes locally on approval, streams output to its own terminal, and
    // reports the result back here.
    const result = await bridge.execute({
      callId,
      command,
      cwd,
      net,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    });

    ctx.logger.info('run_command.result', { command, status: result.status, exitCode: result.exitCode });
    return ok(result);
  },
});

function readWorkspacePath(ctx: ToolExecutionContext): string | undefined {
  const wp = (ctx.runContext as { workspacePath?: unknown }).workspacePath;
  return typeof wp === 'string' && wp.length > 0 ? wp : undefined;
}
