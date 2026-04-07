import { tool } from 'ai';
import { z } from 'zod';

import { contextSearchBrokerService } from '../../../../retrieval/context-search-broker.service';
import type { ToolActionGroup } from '../../../../tools/tool-action-groups';
import type { VercelToolEnvelope, VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';
import { discoverRepositories, inspectRepository, retrieveRepositoryFile } from '../../repo-tool';

type RepoCodingRuntimeHelpers = {
  withLifecycle: (hooks: VercelRuntimeToolHooks, toolName: string, title: string, run: () => Promise<any>) => Promise<any>;
  buildEnvelope: (input: Record<string, unknown>) => any;
  getCodingActivityTitle: (operation: string) => string;
  asString: (value: unknown) => string | undefined;
  asRecord: (value: unknown) => Record<string, unknown> | null;
  asArray: <T = unknown>(value: unknown) => T[];
  createPendingDesktopRemoteApproval: (input: Record<string, unknown>) => Promise<any>;
  summarizeRemoteLocalAction: (action: RemoteDesktopLocalAction) => string;
  summarizeActionResult: (runtime: VercelRuntimeRequestContext, expectedOutputs?: string[]) => Promise<any>;
  buildRemoteLocalExecutionUnavailableEnvelope: (status: 'none' | 'ambiguous' | 'deny') => VercelToolEnvelope;
  loadDesktopWsGateway: () => any;
  resolveWorkspacePath: (runtime: VercelRuntimeRequestContext, candidate: string) => string;
  inspectWorkspace: (workspaceRoot: string, path?: string) => Promise<Array<Record<string, unknown>>>;
  readWorkspaceFiles: (runtime: VercelRuntimeRequestContext, paths: string[]) => Promise<Array<{ path: string; content: string }>>;
};

type RemoteDesktopLocalAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'run_command'; command: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string };

export const buildRepoCodingRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: RepoCodingRuntimeHelpers,
): Record<string, any> => {
  const {
    withLifecycle,
    buildEnvelope,
    getCodingActivityTitle,
    asString,
    asRecord,
    asArray,
    createPendingDesktopRemoteApproval,
    summarizeRemoteLocalAction,
    summarizeActionResult,
    buildRemoteLocalExecutionUnavailableEnvelope,
    loadDesktopWsGateway,
    resolveWorkspacePath,
    inspectWorkspace,
    readWorkspaceFiles,
  } = helpers;

  const tools = {
    skillSearch: tool({
      description:
        'Compatibility shim for skill retrieval. Prefer contextSearch with sources.skills=true for all new retrieval.',
      inputSchema: z.object({
        operation: z.enum(['searchSkills', 'readSkill']),
        query: z.string().optional(),
        skillId: z.string().optional(),
        skillSlug: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (input) =>
        withLifecycle(
          hooks,
          'skillSearch',
          input.operation === 'readSkill' ? 'Reading skill guide' : 'Searching skill library',
          async () => {
            if (input.operation === 'searchSkills') {
              if (!input.query?.trim()) {
                return buildEnvelope({
                  success: false,
                  summary: 'Skill search requires a query.',
                  errorKind: 'missing_input',
                  retryable: false,
                });
              }
              const result = await contextSearchBrokerService.search({
                runtime,
                query: input.query.trim(),
                limit: input.limit,
                sources: {
                  personalHistory: false,
                  files: false,
                  larkContacts: false,
                  zohoCrmContext: false,
                  workspace: false,
                  web: false,
                  skills: true,
                },
              });
              const citations = contextSearchBrokerService.toVercelCitationsFromSearch(result);
              return buildEnvelope({
                success: true,
                summary:
                  result.results.length > 0
                    ? `Found ${result.results.length} relevant skill${result.results.length === 1 ? '' : 's'}.`
                    : 'No relevant skills matched the request.',
                keyData: {
                  resultCount: result.results.length,
                  chunkRefs: result.nextFetchRefs,
                  resolvedEntities: result.resolvedEntities,
                },
                fullPayload: {
                  results: result.results,
                  matches: result.matches,
                  resolvedEntities: result.resolvedEntities,
                  sourceCoverage: result.sourceCoverage,
                  citations: result.citations,
                  nextFetchRefs: result.nextFetchRefs,
                  searchSummary: result.searchSummary,
                },
                citations,
              });
            }

            if (!input.skillId && !input.skillSlug) {
              return buildEnvelope({
                success: false,
                summary: 'Reading a skill requires skillId or skillSlug.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }

            const fetched = await contextSearchBrokerService.fetch({
              runtime,
              chunkRef: `skills:skill:${input.skillId ?? input.skillSlug}:0`,
            });
            if (!fetched?.text.trim()) {
              return buildEnvelope({
                success: false,
                summary:
                  'The requested skill was not found in the visible global or department skill scope.',
                errorKind: 'validation',
                retryable: false,
              });
            }

            return buildEnvelope({
              success: true,
              summary: `Loaded skill "${input.skillId ?? input.skillSlug}".`,
              keyData: {
                resolvedEntities: fetched.resolvedEntities,
              },
              fullPayload: {
                text: fetched.text,
                resolvedEntities: fetched.resolvedEntities,
              },
            });
          },
        ),
    }),

    repo: tool({
      description:
        'Remote GitHub repository discovery and file retrieval. Do not use for the local open workspace.',
      inputSchema: z.object({
        operation: z.enum(['discoverRepositories', 'inspectRepository', 'retrieveFile']),
        repoQuery: z.string().optional(),
        repoRef: z.string().optional(),
        targetFilePath: z.string().optional(),
        targetFileName: z.string().optional(),
        filePath: z.string().optional(),
        requireRoot: z.boolean().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'repo', 'Inspecting GitHub repositories', async () => {
          if (input.operation === 'discoverRepositories') {
            if (!input.repoQuery?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'Repository discovery requires repoQuery.',
                errorKind: 'missing_input',
              });
            }
            const repositories = await discoverRepositories({
              repoQuery: input.repoQuery,
              targetFileName: input.targetFileName,
            });
            if (repositories.length === 0) {
              return buildEnvelope({
                success: false,
                summary: `I could not resolve the repository "${input.repoQuery}".`,
                errorKind: 'validation',
                retryable: true,
                userAction: 'Provide the exact repository URL or owner/repo name.',
              });
            }
            return buildEnvelope({
              success: true,
              summary: `Found ${repositories.length} matching GitHub repositories.`,
              keyData: {
                repo: repositories[0],
                files: [],
              },
              fullPayload: { repositories },
              citations: repositories.map((repo, index) => ({
                id: `repo-${index + 1}`,
                title: repo.fullName,
                url: repo.htmlUrl,
                kind: 'repository',
                sourceType: 'github',
                sourceId: repo.fullName,
              })),
            });
          }

          if (!input.repoRef?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'Repository inspection requires repoRef.',
              errorKind: 'missing_input',
            });
          }

          if (input.operation === 'inspectRepository') {
            const result = await inspectRepository({
              repoRef: input.repoRef,
              targetFilePath: input.targetFilePath,
              targetFileName: input.targetFileName,
              requireRoot: input.requireRoot,
            });
            return buildEnvelope({
              success: true,
              summary: `Resolved ${result.repo.fullName} and inspected ${result.tree.length} entries.`,
              keyData: {
                repo: result.repo,
                files: result.matches.map((entry) => entry.path),
              },
              fullPayload: result,
              citations: [
                {
                  id: result.repo.fullName,
                  title: result.repo.fullName,
                  url: result.repo.htmlUrl,
                  kind: 'repository',
                  sourceType: 'github',
                  sourceId: result.repo.fullName,
                },
              ],
            });
          }

          const artifact = await retrieveRepositoryFile({
            repoRef: input.repoRef,
            filePath: input.filePath,
            targetFilePath: input.targetFilePath,
            targetFileName: input.targetFileName,
            requireRoot: input.requireRoot,
          });
          return buildEnvelope({
            success: true,
            summary: `Retrieved ${artifact.path} from ${artifact.repo.fullName}.`,
            keyData: {
              repo: artifact.repo,
              files: [artifact.path],
            },
            fullPayload: {
              artifact,
            },
            citations: [
              {
                id: `${artifact.repo.fullName}:${artifact.path}`,
                title: artifact.path,
                url: artifact.htmlUrl,
                kind: 'file',
                sourceType: 'github',
                sourceId: artifact.repo.fullName,
              },
            ],
          });
        }),
    }),

    coding: tool({
      description:
        "Primary executable local coding tool for the active workspace. Use this for real local workspace work, not as the first step for uploaded/company document retrieval. If the request is about uploaded files or internal company docs, use the internal document tools first. When a workspace is connected, ambiguous file and folder requests refer to LOCAL files by default, not Google Drive or other cloud integrations, unless the user explicitly names a cloud service. These operations execute through workspace policy and approval when needed; they are not suggestion-only plans. The terminal path is the universal local-workspace executor: if a task can be done with shell commands in the active workspace, use runCommand with the exact command. Use inspectWorkspace to list files in the workspace root or a specific subdirectory, readFiles to read exact files, writeFile when you already have the full target path and exact file content, createDirectory to create directories, deletePath to remove files or folders, and runCommand when you need an exact terminal command such as moving, renaming, organizing files, running Python, tests, shell utilities, git, package installs, or multi-file operations. To inspect a folder, call inspectWorkspace with that exact folder path. Never infer a subdirectory's contents from the root listing. Use verifyResult after an approved local action finishes, and verify destructive or mutating actions before reporting success. Legacy aliases like planCommand, runScriptPlan, runScript, writeFilePlan, mkdirPlan, and deletePathPlan are still accepted. Do not call writeFile without contentPlan.path and contentPlan.content. Do not call runCommand without an exact command.",
      inputSchema: z.discriminatedUnion('operation', [
        z.object({
          operation: z.literal('inspectWorkspace'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().optional(),
        }),
        z.object({
          operation: z.literal('readFiles'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          paths: z.array(z.string()).min(1),
        }),
        z.object({
          operation: z.literal('runCommand'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('planCommand'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('runScript'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('runScriptPlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('writeFile'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          contentPlan: z.object({
            path: z.string().min(1),
            content: z.string().min(1),
          }),
        }),
        z.object({
          operation: z.literal('writeFilePlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          contentPlan: z.object({
            path: z.string().min(1),
            content: z.string().min(1),
          }),
        }),
        z.object({
          operation: z.literal('createDirectory'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('mkdirPlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('deletePath'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('deletePathPlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('verifyResult'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          expectedOutputs: z.array(z.string()).optional(),
        }),
      ]),
      execute: async (input) =>
        withLifecycle(hooks, 'coding', getCodingActivityTitle(input.operation), async () => {
          const workspaceRoot = input.workspaceRoot?.trim() || runtime.workspace?.path;
          if (!workspaceRoot) {
            return buildEnvelope({
              success: false,
              summary: 'No open workspace is available for local coding actions.',
              errorKind: 'missing_input',
            });
          }

          const executeLarkRemoteLocalAction = async (
            action: RemoteDesktopLocalAction,
            actionGroup: ToolActionGroup,
            successSummary: string,
          ): Promise<VercelToolEnvelope> => {
            const gateway = loadDesktopWsGateway();
            const policy = gateway.getPolicyDecision(runtime.userId, runtime.companyId, action);
            if (
              policy.status === 'none' ||
              policy.status === 'ambiguous' ||
              policy.status === 'deny'
            ) {
              return buildRemoteLocalExecutionUnavailableEnvelope(policy.status);
            }
            if (policy.status === 'ask') {
              return createPendingDesktopRemoteApproval({
                runtime,
                action,
                actionGroup,
                operation: input.operation,
                summary: summarizeRemoteLocalAction(action),
                explanation: input.objective,
              });
            }

            const result = await gateway.dispatchRemoteLocalAction({
              userId: runtime.userId,
              companyId: runtime.companyId,
              action,
              reason: input.objective,
            });
            return buildEnvelope({
              success: result.ok,
              summary: result.ok ? successSummary : result.summary,
              keyData: {
                workspaceRoot: policy.session?.activeWorkspace?.path ?? workspaceRoot,
                actionKind: action.kind,
              },
              fullPayload: {
                action,
                result,
              },
              ...(result.ok ? {} : { errorKind: 'api_failure', retryable: true }),
            });
          };

          if (runtime.channel === 'lark') {
            if (input.operation === 'inspectWorkspace') {
              const result = await executeLarkRemoteLocalAction(
                { kind: 'list_files', ...(input.path?.trim() ? { path: input.path.trim() } : {}) },
                'read',
                `Inspected workspace entries in ${input.path?.trim() ? input.path.trim() : workspaceRoot}.`,
              );
              if (!result.success) {
                return result;
              }
              const payload = asRecord(result.fullPayload?.result?.payload);
              const items = asArray(payload?.items)
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry));
              const resolvedPath = asString(payload?.path) ?? workspaceRoot;
              return buildEnvelope({
                success: true,
                summary: `Inspected ${items.length} workspace entries in ${resolvedPath}.`,
                keyData: {
                  workspaceRoot: resolvedPath,
                  files: items,
                },
                fullPayload: { items },
              });
            }

            if (input.operation === 'readFiles') {
              const files: Array<{ path: string; content: string }> = [];
              for (const filePath of input.paths) {
                const result = await executeLarkRemoteLocalAction(
                  { kind: 'read_file', path: filePath },
                  'read',
                  `Read workspace file ${filePath}.`,
                );
                if (!result.success) {
                  return result;
                }
                const payload = asRecord(result.fullPayload?.result?.payload);
                const content = asString(payload?.content);
                const resolvedPath = asString(payload?.path) ?? filePath;
                if (content === undefined) {
                  return buildEnvelope({
                    success: false,
                    summary: `Remote desktop read succeeded but returned no file content for ${filePath}.`,
                    errorKind: 'api_failure',
                    retryable: true,
                  });
                }
                files.push({
                  path: resolvedPath,
                  content,
                });
              }
              return buildEnvelope({
                success: true,
                summary: `Read ${files.length} workspace file(s).`,
                keyData: {
                  workspaceRoot,
                  files: files.map((item) => item.path),
                },
                fullPayload: { files },
              });
            }

            if (input.operation === 'verifyResult') {
              return summarizeActionResult(runtime, input.expectedOutputs);
            }

            if (
              input.operation === 'runCommand' ||
              input.operation === 'planCommand' ||
              input.operation === 'runScript' ||
              input.operation === 'runScriptPlan'
            ) {
              return executeLarkRemoteLocalAction(
                { kind: 'run_command', command: input.command.trim() },
                'execute',
                `Executed shell command: ${input.command.trim()}`,
              );
            }

            if (input.operation === 'writeFile' || input.operation === 'writeFilePlan') {
              return executeLarkRemoteLocalAction(
                {
                  kind: 'write_file',
                  path: input.contentPlan.path,
                  content: input.contentPlan.content,
                },
                'write',
                `Wrote file ${input.contentPlan.path}.`,
              );
            }

            if (input.operation === 'createDirectory' || input.operation === 'mkdirPlan') {
              return executeLarkRemoteLocalAction(
                { kind: 'mkdir', path: input.path },
                'write',
                `Created directory ${input.path}.`,
              );
            }

            if (input.operation === 'deletePath' || input.operation === 'deletePathPlan') {
              return executeLarkRemoteLocalAction(
                { kind: 'delete_path', path: input.path },
                'delete',
                `Deleted ${input.path}.`,
              );
            }
          }

          if (input.operation === 'inspectWorkspace') {
            const items = await inspectWorkspace(workspaceRoot, input.path?.trim());
            const inspectedPath = input.path?.trim()
              ? resolveWorkspacePath(runtime, input.path.trim())
              : workspaceRoot;
            return buildEnvelope({
              success: true,
              summary: `Inspected ${items.length} workspace entries in ${inspectedPath}.`,
              keyData: {
                workspaceRoot: inspectedPath,
                files: items,
              },
              fullPayload: { items },
            });
          }

          if (input.operation === 'readFiles') {
            const items = await readWorkspaceFiles(runtime, input.paths);
            return buildEnvelope({
              success: true,
              summary: `Read ${items.length} workspace file(s).`,
              keyData: {
                workspaceRoot,
                files: items.map((item) => item.path),
              },
              fullPayload: { files: items },
            });
          }

          if (input.operation === 'verifyResult') {
            return summarizeActionResult(runtime, input.expectedOutputs);
          }

          if (
            input.operation === 'runCommand' ||
            input.operation === 'planCommand' ||
            input.operation === 'runScript' ||
            input.operation === 'runScriptPlan'
          ) {
            const command = input.command.trim();
            return buildEnvelope({
              success: true,
              summary: `Proposed shell command: ${command}`,
              keyData: { workspaceRoot },
              pendingApprovalAction: {
                kind: 'run_command',
                command,
                cwd: workspaceRoot,
                explanation: input.objective,
              },
            });
          }

          if (input.operation === 'writeFile' || input.operation === 'writeFilePlan') {
            const targetPath = input.contentPlan.path;
            const content = input.contentPlan.content;
            return buildEnvelope({
              success: true,
              summary: `Proposed file write: ${targetPath}`,
              keyData: { workspaceRoot },
              pendingApprovalAction: {
                kind: 'write_file',
                path: targetPath,
                content,
                explanation: input.objective,
              },
            });
          }

          if (input.operation === 'createDirectory' || input.operation === 'mkdirPlan') {
            const targetPath = input.path;
            return buildEnvelope({
              success: true,
              summary: `Proposed directory creation: ${targetPath}`,
              keyData: { workspaceRoot },
              pendingApprovalAction: {
                kind: 'create_directory',
                path: targetPath,
                explanation: input.objective,
              },
            });
          }

          if (input.operation === 'deletePath' || input.operation === 'deletePathPlan') {
            const targetPath = input.path;
            return buildEnvelope({
              success: true,
              summary: `Proposed path deletion: ${targetPath}`,
              keyData: { workspaceRoot },
              pendingApprovalAction: {
                kind: 'delete_path',
                path: targetPath,
                explanation: input.objective,
              },
            });
          }

          return buildEnvelope({
            success: false,
            summary: `Unsupported coding operation: ${input.operation}`,
            errorKind: 'unsupported',
            retryable: false,
          });
        }),
    }),

  };

  return tools;
};
