import { promises as fs } from 'fs';
import path from 'path';

import type { VercelRuntimeRequestContext, VercelToolEnvelope } from '../../types';

export type RemoteDesktopLocalAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string };

export const summarizeRemoteLocalAction = (action: RemoteDesktopLocalAction): string => {
  switch (action.kind) {
    case 'run_command':
      return `Run shell command: ${action.command}`;
    case 'write_file':
      return `Write file: ${action.path}`;
    case 'mkdir':
      return `Create directory: ${action.path}`;
    case 'delete_path':
      return `Delete path: ${action.path}`;
    case 'read_file':
      return `Read file: ${action.path}`;
    case 'list_files':
      return `Inspect workspace${action.path ? ` in ${action.path}` : ''}`;
    default:
      return 'Run local desktop action';
  }
};

export const buildRemoteLocalExecutionUnavailableEnvelope = (
  status: 'none' | 'ambiguous' | 'deny',
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope,
): VercelToolEnvelope => {
  if (status === 'none') {
    return buildEnvelope({
      success: false,
      summary: 'No active desktop workspace is available for local execution.',
      errorKind: 'missing_input',
      retryable: true,
      userAction:
        'Open Divo Desktop, select the target workspace, and keep it connected before retrying.',
    });
  }
  if (status === 'ambiguous') {
    return buildEnvelope({
      success: false,
      summary: 'Multiple desktop workspaces are online; remote execution target is ambiguous.',
      errorKind: 'validation',
      retryable: true,
      userAction: 'Keep exactly one eligible desktop workspace connected before retrying.',
    });
  }
  return buildEnvelope({
    success: false,
    summary: 'This desktop workspace policy denies the requested local action.',
    errorKind: 'permission',
    retryable: false,
  });
};

export const resolveWorkspacePath = (
  runtime: VercelRuntimeRequestContext,
  candidate: string,
): string => {
  const workspaceRoot = runtime.workspace?.path ?? '.';
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.join(workspaceRoot, candidate);
};

export const inspectWorkspace = async (workspaceRoot: string, targetPath?: string) => {
  const directoryPath = targetPath?.trim()
    ? path.resolve(workspaceRoot, targetPath.trim())
    : workspaceRoot;
  const relativePath = path.relative(workspaceRoot, directoryPath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error('Requested inspect path escapes the active workspace');
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries.slice(0, 50).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  }));
};

export const getCodingActivityTitle = (operation: string): string => {
  switch (operation) {
    case 'inspectWorkspace':
      return 'Inspecting workspace files';
    case 'readFiles':
      return 'Reading workspace files';
    case 'verifyResult':
      return 'Verifying local command results';
    case 'runCommand':
    case 'planCommand':
      return 'Planning shell command';
    case 'runScript':
    case 'runScriptPlan':
      return 'Planning script execution';
    case 'writeFile':
    case 'writeFilePlan':
      return 'Planning file write';
    case 'createDirectory':
    case 'mkdirPlan':
      return 'Planning directory creation';
    case 'deletePath':
    case 'deletePathPlan':
      return 'Planning path deletion';
    default:
      return 'Running local coding action';
  }
};

export const readWorkspaceFiles = async (
  runtime: VercelRuntimeRequestContext,
  paths: string[],
): Promise<Array<{ path: string; content: string }>> => {
  const items = await Promise.all(
    paths.map(async (filePath) => {
      const absolutePath = resolveWorkspacePath(runtime, filePath);
      const content = await fs.readFile(absolutePath, 'utf8');
      return {
        path: filePath,
        content,
      };
    }),
  );
  return items;
};

export const summarizeActionResult = (
  runtime: VercelRuntimeRequestContext,
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope,
  expectedOutputs?: string[],
): VercelToolEnvelope => {
  const latest = runtime.latestActionResult;
  if (!latest) {
    return buildEnvelope({
      success: false,
      summary: 'No local action result is available to verify yet.',
      errorKind: 'missing_input',
      retryable: false,
    });
  }

  return buildEnvelope({
    success: latest.ok,
    summary: latest.summary,
    keyData: {
      actionKind: latest.kind,
      expectedOutputs: expectedOutputs ?? [],
    },
    fullPayload: {
      latestActionResult: latest,
    },
    ...(latest.ok ? {} : { errorKind: 'api_failure', retryable: true }),
  });
};
