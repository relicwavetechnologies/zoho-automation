import type { RequestContext } from '@mastra/core/di';

import { searchAgentTool } from '../../company/integrations/mastra/tools/search-agent.tool';
import { zohoAgentTool } from '../../company/integrations/mastra/tools/zoho-agent.tool';
import { outreachAgentTool } from '../../company/integrations/mastra/tools/outreach-agent.tool';
import { larkTaskAgentTool } from '../../company/integrations/mastra/tools/lark-task-agent.tool';
import { larkBaseAgentTool } from '../../company/integrations/mastra/tools/lark-base-agent.tool';
import { larkCalendarAgentTool } from '../../company/integrations/mastra/tools/lark-calendar-agent.tool';
import { larkMeetingAgentTool } from '../../company/integrations/mastra/tools/lark-meeting-agent.tool';
import { larkApprovalAgentTool } from '../../company/integrations/mastra/tools/lark-approval-agent.tool';
import { larkDocAgentTool } from '../../company/integrations/mastra/tools/lark-doc-agent.tool';
import type { ControllerRuntimeState, WorkerCapability, WorkerInvocation, WorkerObservation } from '../../company/orchestration/controller-runtime';
import { runRepoWorker, type RepoWorkerInput } from './repo-worker';
import type { ActionResultPayload, DesktopAction } from './desktop-controller.types';

const WORKER_TOOL_BY_KEY: Record<string, { execute: (input: Record<string, unknown>, context: { requestContext: RequestContext<Record<string, unknown>> }) => Promise<unknown> }> = {
  search: searchAgentTool as any,
  zoho: zohoAgentTool as any,
  outreach: outreachAgentTool as any,
  larkTask: larkTaskAgentTool as any,
  larkBase: larkBaseAgentTool as any,
  larkCalendar: larkCalendarAgentTool as any,
  larkMeeting: larkMeetingAgentTool as any,
  larkApproval: larkApprovalAgentTool as any,
  larkDoc: larkDocAgentTool as any,
};

type CitationSummary = {
  id: string;
  title: string;
  url?: string;
};

const extractToolCitations = (resultSummary?: string): CitationSummary[] => {
  if (!resultSummary) return [];
  try {
    const parsed = JSON.parse(resultSummary) as { type?: string; sources?: Array<{ title?: string; url?: string }> };
    if (parsed?.type === 'structured_search' && Array.isArray(parsed.sources)) {
      return parsed.sources
        .filter((item) => item && (item.title || item.url))
        .map((item, index) => ({
          id: `${item.url ?? item.title ?? 'source'}-${index}`,
          title: item.title ?? item.url ?? `Source ${index + 1}`,
          url: item.url,
        }));
    }
  } catch {
    // Ignore malformed structured payloads.
  }
  return [];
};

export const DESKTOP_WORKER_CAPABILITIES: WorkerCapability[] = [
  {
    workerKey: 'repo',
    description: 'Discover GitHub repositories, inspect them, and retrieve grounded files',
    actionKinds: ['DISCOVER_CANDIDATES', 'INSPECT_CANDIDATE', 'RETRIEVE_ARTIFACT', 'VERIFY_OUTPUT'],
    domains: ['repository', 'github', 'code'],
    artifactTypes: ['repository_candidate', 'repository_file_candidate', 'repository_file'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['non_empty_content', 'source_citation'],
  },
  {
    workerKey: 'search',
    description: 'Run grounded web and documentation research',
    actionKinds: ['DISCOVER_CANDIDATES', 'QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['research', 'docs', 'web'],
    artifactTypes: ['citation'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['source_citation'],
  },
  {
    workerKey: 'zoho',
    description: 'Query grounded Zoho entities and operations',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['zoho'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'outreach',
    description: 'Query grounded outreach publisher data',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['outreach'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'larkTask',
    description: 'Query Lark task data',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['lark'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'larkBase',
    description: 'Query Lark Base data',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['lark'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'larkCalendar',
    description: 'Query Lark calendar data',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['lark'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'larkMeeting',
    description: 'Query Lark meeting data',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['lark'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'larkApproval',
    description: 'Query Lark approval data',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['lark'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'larkDoc',
    description: 'Query Lark docs',
    actionKinds: ['QUERY_REMOTE_SYSTEM', 'VERIFY_OUTPUT'],
    domains: ['lark'],
    artifactTypes: ['remote_entity'],
    canMutateWorkspace: false,
    requiresApproval: false,
    verificationHints: ['entity_evidence'],
  },
  {
    workerKey: 'workspace',
    description: 'Perform local workspace mutations through approval-gated actions',
    actionKinds: ['MUTATE_WORKSPACE', 'VERIFY_OUTPUT'],
    domains: ['workspace'],
    artifactTypes: ['workspace_file'],
    canMutateWorkspace: true,
    requiresApproval: true,
    verificationHints: ['workspace_path', 'workspace_content'],
  },
  {
    workerKey: 'terminal',
    description: 'Run local terminal commands through approval-gated execution',
    actionKinds: ['EXECUTE_COMMAND', 'VERIFY_OUTPUT'],
    domains: ['terminal'],
    artifactTypes: ['terminal_result'],
    canMutateWorkspace: true,
    requiresApproval: true,
    verificationHints: ['terminal_exit', 'terminal_output'],
  },
];

const basenameOf = (value: string): string => {
  const parts = value.split('/');
  return parts[parts.length - 1] ?? value;
};

const inferOutputPath = (state: ControllerRuntimeState<DesktopAction>): string => {
  const workspaceOutput = state.objective.requestedOutputs.find((output) => output.kind === 'workspace_mutation');
  const explicitPath = typeof workspaceOutput?.metadata?.targetPath === 'string' ? workspaceOutput.metadata.targetPath : '';
  if (explicitPath.trim()) return explicitPath.trim();

  const repositoryFile = state.observations
    .flatMap((observation) => observation.artifacts)
    .find((artifact) => artifact.type === 'repository_file');
  const filePath = typeof repositoryFile?.metadata?.filePath === 'string' ? repositoryFile.metadata.filePath : repositoryFile?.title;
  return filePath ? basenameOf(filePath) : 'fetched-file.txt';
};

export const buildDesktopLocalAction = (
  state: ControllerRuntimeState<DesktopAction>,
  kind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND',
): DesktopAction | null => {
  if (kind === 'EXECUTE_COMMAND') {
    const terminalOutput = state.objective.requestedOutputs.find((output) => output.kind === 'terminal_result');
    const commandHint = typeof terminalOutput?.metadata?.commandHint === 'string'
      ? terminalOutput.metadata.commandHint
      : state.userRequest;
    return { kind: 'run_command', command: commandHint };
  }

  const retrieved = state.observations.find((observation) =>
    observation.workerKey === 'repo' && observation.actionKind === 'RETRIEVE_ARTIFACT' && observation.ok);
  const raw = retrieved?.rawOutput && typeof retrieved.rawOutput === 'object'
    ? retrieved.rawOutput as { artifact?: { content?: string } }
    : null;
  const content = raw?.artifact?.content;
  if (!content) return null;
  return {
    kind: 'write_file',
    path: inferOutputPath(state),
    content,
  };
};

export const actionResultToObservation = (result: ActionResultPayload): WorkerObservation => {
  if (result.kind === 'run_command') {
    const details = result.details ?? {};
    const exitCode = typeof details.exitCode === 'number' || details.exitCode === null ? details.exitCode : undefined;
    return {
      ok: result.ok,
      workerKey: 'terminal',
      actionKind: 'EXECUTE_COMMAND',
      summary: result.summary,
      entities: [],
      facts: [result.summary],
      artifacts: [],
      citations: [],
      rawOutput: {
        kind: result.kind,
        summary: result.summary,
        exitCode,
        stdout: typeof details.stdout === 'string' ? details.stdout : undefined,
        stderr: typeof details.stderr === 'string' ? details.stderr : undefined,
        durationMs: typeof details.durationMs === 'number' ? details.durationMs : undefined,
        signal: typeof details.signal === 'string' ? details.signal : undefined,
      },
      retryHint: result.ok ? undefined : 'Review the command result and switch strategy if it produced no new evidence.',
      verificationHints: ['terminal_exit', 'terminal_output'],
    };
  }

  const path = typeof result.details?.path === 'string' ? result.details.path : undefined;
  return {
    ok: result.ok,
    workerKey: 'workspace',
    actionKind: 'MUTATE_WORKSPACE',
    summary: result.summary,
    entities: path ? [{ type: 'workspace_path', id: path, title: path }] : [],
    facts: [result.summary],
    artifacts: path ? [{ type: 'workspace_file', id: path, title: path, metadata: { path } }] : [],
    citations: [],
    rawOutput: {
      kind: result.kind,
      summary: result.summary,
      path,
      ...(result.details ?? {}),
    },
    retryHint: result.ok ? undefined : 'Review the workspace result before retrying the same mutation.',
    verificationHints: ['workspace_path', 'workspace_content'],
  };
};

const normalizeRepoObservation = (result: Awaited<ReturnType<typeof runRepoWorker>>): WorkerObservation => {
  const citations = result.ok && result.actionKind === 'RETRIEVE_ARTIFACT'
    ? [{ id: result.artifact.htmlUrl, title: result.artifact.path, url: result.artifact.htmlUrl }]
    : [];
  const rawOutput = result.ok && result.actionKind === 'RETRIEVE_ARTIFACT'
    ? result
    : result;
  return {
    ok: result.ok,
    workerKey: 'repo',
    actionKind: result.actionKind,
    summary: result.summary,
    entities: result.ok ? result.entities : [],
    facts: result.ok ? result.facts : [result.summary],
    artifacts: result.ok
      ? result.artifacts
        .filter((artifact): artifact is NonNullable<typeof artifact> & { id: string } => typeof artifact.id === 'string' && artifact.id.length > 0)
        .map((artifact) => ({
          id: artifact.id,
          type: artifact.type,
          ...(artifact.title ? { title: artifact.title } : {}),
          ...(artifact.url ? { url: artifact.url } : {}),
          ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
        }))
      : [],
    citations,
    rawOutput,
    blockingReason: !result.ok && 'blockingQuestion' in result ? result.blockingQuestion : undefined,
    retryHint: !result.ok && 'retryHint' in result ? result.retryHint : undefined,
    verificationHints: ['non_empty_content', 'source_citation'],
  };
};

const normalizeToolObservation = (workerKey: string, actionKind: WorkerObservation['actionKind'], result: unknown): WorkerObservation => {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const summary = typeof record.summary === 'string'
    ? record.summary
    : typeof record.answer === 'string'
      ? record.answer
      : typeof record.error === 'string'
        ? record.error
        : JSON.stringify(result);
  const citations = workerKey === 'search'
    ? extractToolCitations(typeof record.summary === 'string' ? record.summary : typeof record.answer === 'string' ? record.answer : undefined)
    : [];
  const ok = record.success === false
    ? false
    : typeof record.error !== 'string'
      && !/failed|error|not permitted/i.test(summary);
  return {
    ok,
    workerKey,
    actionKind,
    summary,
    entities: [],
    facts: [summary],
    artifacts: [],
    citations,
    rawOutput: result,
    blockingReason: /which|what|provide|share|missing|\?/.test(summary.toLowerCase()) ? summary : undefined,
    retryHint: ok ? undefined : 'Inspect the worker result and switch strategy if it did not add evidence.',
    verificationHints: workerKey === 'search' ? ['source_citation'] : ['entity_evidence'],
  };
};

export const executeDesktopWorker = async (input: {
  invocation: WorkerInvocation;
  requestContext: RequestContext<Record<string, unknown>>;
}): Promise<WorkerObservation> => {
  if (input.invocation.workerKey === 'repo') {
    const repoInput = input.invocation.input as RepoWorkerInput;
    return normalizeRepoObservation(await runRepoWorker(repoInput));
  }

  const tool = WORKER_TOOL_BY_KEY[input.invocation.workerKey];
  if (!tool) {
    return {
      ok: false,
      workerKey: input.invocation.workerKey,
      actionKind: input.invocation.actionKind,
      summary: `Worker "${input.invocation.workerKey}" is not available in the desktop runtime.`,
      entities: [],
      facts: [],
      artifacts: [],
      citations: [],
      rawOutput: { workerKey: input.invocation.workerKey },
      verificationHints: [],
    };
  }

  const result = await tool.execute(
    {
      query: typeof input.invocation.input.query === 'string'
        ? input.invocation.input.query
        : typeof input.invocation.input.prompt === 'string'
          ? input.invocation.input.prompt
          : '',
    },
    { requestContext: input.requestContext },
  );
  return normalizeToolObservation(input.invocation.workerKey, input.invocation.actionKind, result);
};
