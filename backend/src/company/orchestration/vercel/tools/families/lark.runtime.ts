import { tool } from 'ai';
import { z } from 'zod';

import { conversationMemoryStore } from '../../../../state/conversation';
import { logger } from '../../../../../utils/logger';
import type { ToolActionGroup } from '../../../../tools/tool-action-groups';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

type LarkRuntimeHelpers = {
  withLifecycle: (hooks: VercelRuntimeToolHooks, toolName: string, title: string, run: () => Promise<any>) => Promise<any>;
  buildEnvelope: (input: Record<string, unknown>) => any;
  buildLarkItemsEnvelope: (input: Record<string, unknown>) => any;
  ensureActionPermission: (runtime: VercelRuntimeRequestContext, toolId: string, actionGroup: ToolActionGroup) => any;
  toCanonicalToolId: (toolId: string) => string;
  uniqueDefinedStrings: (values: Array<string | undefined | null>) => string[];
  asString: (value: unknown) => string | undefined;
  asRecord: (value: unknown) => Record<string, unknown> | null;
  asArray: <T = unknown>(value: unknown) => T[];
  loadListLarkPeople: () => (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  loadResolveLarkPeople: () => (input: Record<string, unknown>) => Promise<{people: Array<Record<string, unknown>>; unresolved: string[]; ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;}>;
  createPendingRemoteApproval: (input: Record<string, unknown>) => Promise<any>;
  loadLarkMessagingService: () => { sendDirectTextMessage: (input: Record<string, unknown>) => Promise<Record<string, unknown>>; };
  withLarkTenantFallback: <T>(runtime: VercelRuntimeRequestContext, run: (auth: Record<string, unknown>) => Promise<T>) => Promise<T>;
  loadLarkTasksService: () => any;
  getLarkDefaults: (runtime: VercelRuntimeRequestContext) => Promise<any>;
  buildConversationKey: (threadId: string) => string;
  loadNormalizeLarkTimestamp: () => (value?: string, timezone?: string) => string | undefined;
  loadListLarkTaskAssignablePeople: () => (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  loadResolveLarkTaskAssignees: () => (input: Record<string, unknown>) => Promise<any>;
  loadCanonicalizeLarkPersonIds: () => (input: Record<string, unknown>) => Promise<any>;
  getLarkTimeZone: () => string;
  getLarkAuthInput: (runtime: VercelRuntimeRequestContext) => Record<string, unknown>;
  projectLarkItem: (item: Record<string, unknown>) => Record<string, unknown>;
  LARK_LARGE_RESULT_THRESHOLD: number;
  loadLarkCalendarService: () => any;
  loadLarkMeetingsService: () => any;
  loadLarkMinutesService: () => any;
  loadLarkDocsService: () => any;
};

export const buildLarkRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: LarkRuntimeHelpers,
): Record<string, any> => {
  const {
    withLifecycle,
    buildEnvelope,
    buildLarkItemsEnvelope,
    ensureActionPermission,
    toCanonicalToolId,
    uniqueDefinedStrings,
    asString,
    asRecord,
    asArray,
    loadListLarkPeople,
    loadResolveLarkPeople,
    createPendingRemoteApproval,
    loadLarkMessagingService,
    withLarkTenantFallback,
    loadLarkTasksService,
    getLarkDefaults,
    buildConversationKey,
    loadNormalizeLarkTimestamp,
    loadListLarkTaskAssignablePeople,
    loadResolveLarkTaskAssignees,
    loadCanonicalizeLarkPersonIds,
    getLarkTimeZone,
    getLarkAuthInput,
    projectLarkItem,
    LARK_LARGE_RESULT_THRESHOLD,
    loadLarkCalendarService,
    loadLarkMeetingsService,
    loadLarkMinutesService,
    loadLarkDocsService,
  } = helpers;

  const tools = {
    larkMessage: tool({
      description:
        'Lark messaging tool for teammate lookup, recipient resolution, and direct-message sends.',
      inputSchema: z.object({
        operation: z.enum(['searchUsers', 'resolveRecipients', 'sendDm']),
        query: z.string().optional(),
        recipientNames: z.array(z.string()).optional(),
        recipientOpenIds: z.array(z.string()).optional(),
        assignToMe: z.boolean().optional(),
        message: z.string().optional(),
        skipConfirmation: z.boolean().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkMessage', 'Running Lark messaging workflow', async () => {
          const formatPersonLabel = (person: Record<string, unknown>): string =>
            asString(person.displayName) ??
            asString(person.email) ??
            asString(person.externalUserId) ??
            asString(person.larkOpenId) ??
            'Unknown teammate';
          const formatPersonStableId = (person: Record<string, unknown>): string =>
            asString(person.larkOpenId) ??
            asString(person.externalUserId) ??
            asString(person.larkUserId) ??
            'unknown';
          const dedupePeople = (
            people: Array<Record<string, unknown>>,
          ): Array<Record<string, unknown>> => {
            const seen = new Set<string>();
            return people.filter((person) => {
              const key = formatPersonStableId(person);
              if (!key || seen.has(key)) {
                return false;
              }
              seen.add(key);
              return true;
            });
          };
          const allPeople = async (): Promise<Array<Record<string, unknown>>> =>
            loadListLarkPeople()({
              companyId: runtime.companyId,
              appUserId: runtime.userId,
              requestLarkOpenId: runtime.larkOpenId,
            });
          const resolvePeople = async (): Promise<{
            people: Array<Record<string, unknown>>;
            unresolved: string[];
            ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
          }> =>
            loadResolveLarkPeople()({
              companyId: runtime.companyId,
              appUserId: runtime.userId,
              requestLarkOpenId: runtime.larkOpenId,
              assigneeNames: input.recipientNames,
              assignToMe: input.assignToMe,
            });
          const findPeopleByOpenIds = async (
            recipientOpenIds: string[],
          ): Promise<Array<Record<string, unknown>>> => {
            if (recipientOpenIds.length === 0) {
              return [];
            }
            const people = await allPeople();
            const wanted = new Set(recipientOpenIds.map((value) => value.trim()).filter(Boolean));
            return people.filter((person) => wanted.has(formatPersonStableId(person)));
          };

          if (input.operation === 'searchUsers') {
            const permissionError = ensureActionPermission(runtime, toCanonicalToolId('lark-message-read'), 'read');
            if (permissionError) {
              return permissionError;
            }
            const people = await allPeople();
            const normalizedQuery = input.query?.trim().toLowerCase();
            const filtered = normalizedQuery
              ? people.filter((person) =>
                  [
                    asString(person.displayName),
                    asString(person.email),
                    asString(person.externalUserId),
                    asString(person.larkOpenId),
                    asString(person.larkUserId),
                  ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
                )
              : people;
            return buildEnvelope({
              success: true,
              summary:
                filtered.length > 0
                  ? `Found ${filtered.length} Lark teammate(s).`
                  : 'No Lark teammates matched the request.',
              keyData: {
                people: filtered,
                resultCount: filtered.length,
              },
              fullPayload: {
                people: filtered,
              },
            });
          }

          if (input.operation === 'resolveRecipients') {
            const permissionError = ensureActionPermission(runtime, toCanonicalToolId('lark-message-read'), 'read');
            if (permissionError) {
              return permissionError;
            }
            const resolved = await resolvePeople();
            return buildEnvelope({
              success: resolved.unresolved.length === 0 && resolved.ambiguous.length === 0,
              summary:
                resolved.unresolved.length === 0 && resolved.ambiguous.length === 0
                  ? `Resolved ${resolved.people.length} Lark recipient(s).`
                  : resolved.ambiguous.length > 0
                    ? `Recipient resolution is ambiguous for ${resolved.ambiguous.map((entry) => `"${entry.query}"`).join(', ')}.`
                    : `No Lark teammate matched ${resolved.unresolved.map((entry) => `"${entry}"`).join(', ')}.`,
              errorKind:
                resolved.unresolved.length > 0 || resolved.ambiguous.length > 0
                  ? 'validation'
                  : undefined,
              retryable: false,
              userAction:
                resolved.ambiguous.length > 0
                  ? 'Please tell me which teammate you mean.'
                  : resolved.unresolved.length > 0
                    ? 'Please provide a more specific teammate name, email, or Lark ID.'
                    : undefined,
              keyData: {
                resolved: resolved.people.map((person) => ({
                  label: formatPersonLabel(person),
                  openId: formatPersonStableId(person),
                })),
                ambiguous: resolved.ambiguous.map((entry) => ({
                  query: entry.query,
                  matches: entry.matches.map((person) => ({
                    label: formatPersonLabel(person),
                    openId: formatPersonStableId(person),
                  })),
                })),
                unresolved: resolved.unresolved,
              },
              fullPayload: {
                resolved,
              },
            });
          }

          const sendPermissionError = ensureActionPermission(runtime, toCanonicalToolId('lark-message-write'), 'send');
          if (sendPermissionError) {
            return sendPermissionError;
          }
          const message = input.message?.trim();
          if (!message) {
            return buildEnvelope({
              success: false,
              summary: 'Lark DM send requires a message body.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const directRecipientOpenIds = uniqueDefinedStrings(input.recipientOpenIds ?? []);
          const resolvedRecipients =
            (input.recipientNames?.length ?? 0) > 0 || input.assignToMe
              ? await resolvePeople()
              : {
                  people: [],
                  unresolved: [],
                  ambiguous: [] as Array<{
                    query: string;
                    matches: Array<Record<string, unknown>>;
                  }>,
                };
          if (resolvedRecipients.unresolved.length > 0) {
            return buildEnvelope({
              success: false,
              summary: `No Lark teammate matched ${resolvedRecipients.unresolved.map((entry) => `"${entry}"`).join(', ')}.`,
              errorKind: 'validation',
              retryable: false,
              userAction: 'Please provide a more specific teammate name, email, or Lark ID.',
            });
          }
          if (resolvedRecipients.ambiguous.length > 0) {
            const first = resolvedRecipients.ambiguous[0]!;
            const options = first.matches
              .map((person) => `${formatPersonLabel(person)} (${formatPersonStableId(person)})`)
              .join(', ');
            return buildEnvelope({
              success: false,
              summary: `"${first.query}" matched multiple Lark teammates (${options}). Please be more specific.`,
              errorKind: 'validation',
              retryable: false,
              userAction: 'Please tell me which teammate you mean.',
              keyData: {
                ambiguous: resolvedRecipients.ambiguous,
              },
            });
          }

          const directRecipients = await findPeopleByOpenIds(directRecipientOpenIds);
          const resolvedPeople = dedupePeople([...directRecipients, ...resolvedRecipients.people]);
          const recipientOpenIds = uniqueDefinedStrings([
            ...directRecipientOpenIds,
            ...resolvedPeople.map((person) => formatPersonStableId(person)),
          ]);
          if (recipientOpenIds.length === 0) {
            return buildEnvelope({
              success: false,
              summary: 'Please tell me who should receive the Lark DM.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const recipientLabels = recipientOpenIds.map((openId) => {
            const match = resolvedPeople.find((person) => formatPersonStableId(person) === openId);
            return match ? `${formatPersonLabel(match)} (${openId})` : openId;
          });
          const summary = `Approval required to send ${recipientOpenIds.length} Lark DM(s) to ${recipientLabels.join(', ')}.`;
          const preview = message.length > 180 ? `${message.slice(0, 177)}...` : message;

          if (input.skipConfirmation) {
            if (directRecipientOpenIds.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'Workflow-driven Lark DM sends require fixed recipient open IDs.',
                errorKind: 'validation',
                retryable: false,
                repairHints: {
                  recipientOpenIds:
                    'Call larkMessage with operation=resolveRecipients first to obtain openIds, then retry with recipientOpenIds populated.',
                },
              });
            }
            const larkMessagingService = loadLarkMessagingService();
            const deliveries = await Promise.all(
              recipientOpenIds.map((recipientOpenId) =>
                withLarkTenantFallback(runtime, (auth) =>
                  larkMessagingService.sendDirectTextMessage({
                    ...(auth as {
                      companyId?: string;
                      larkTenantKey?: string;
                      appUserId?: string;
                      credentialMode?: 'tenant' | 'user_linked';
                    }),
                    recipientOpenId,
                    text: message,
                  }),
                ),
              ),
            );
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Sent ${deliveries.length} Lark DM(s) to ${recipientLabels.join(', ')}.`,
              keyData: {
                recipients: recipientLabels,
              },
              fullPayload: {
                recipients: recipientLabels,
                recipientOpenIds,
                deliveries,
                preview,
              },
            });
          }

          return createPendingRemoteApproval({
            runtime,
            toolId: 'lark-message-write',
            actionGroup: 'send',
            operation: 'sendDm',
            summary,
            subject: `Send Lark DM to ${recipientLabels.join(', ')}`,
            explanation: `Send this Lark DM message: "${preview}"`,
            payload: {
              operation: 'sendDm',
              recipientOpenIds,
              recipientLabels,
              message,
              skipConfirmation: false,
            },
          });
        }),
    }),


    larkTask: tool({
      description:
        'Lark Tasks tool for personal task lookup, tasklist reads, single-task lookup, and task mutations. For personal reads, prefer listMine for "my tasks", listOpenMine for "my open tasks", list for broader tasklist reads, and current only for the latest referenced or single current task. For assignees, use assigneeMode=self or assignToMe=true for "assign to me", assigneeNames for teammate names, and assigneeIds only for canonical Lark ids.',
      inputSchema: z.object({
        operation: z.enum([
          'list',
          'listMine',
          'listOpenMine',
          'get',
          'current',
          'listTasklists',
          'listAssignableUsers',
          'create',
          'update',
          'delete',
          'complete',
          'reassign',
          'assign',
        ]),
        taskId: z.string().optional(),
        tasklistId: z.string().optional(),
        query: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        completed: z.boolean().optional(),
        onlyMine: z.boolean().optional(),
        onlyOpen: z.boolean().optional(),
        dueTs: z.string().optional(),
        assigneeMode: z.enum(['self', 'named_people', 'canonical_ids']).optional()
          .describe('Use self for "assign to me", named_people for human names, and canonical_ids only for real Lark ids.'),
        assigneeIds: z.array(z.string()).optional()
          .describe('Canonical Lark assignee ids only. Do not put natural-language values here unless they literally came from a prior tool result.'),
        assigneeNames: z.array(z.string()).optional()
          .describe('Human assignee names. Use this for teammate names, not for ids.'),
        assignToMe: z.boolean().optional()
          .describe('Use true when the task should be assigned to the current caller.'),
        extra: z.record(z.unknown()).optional(),
        customFields: z.array(z.unknown()).optional(),
        repeatRule: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkTask', 'Running Lark Tasks workflow', async () => {
          const larkTasksService = loadLarkTasksService();
          logger.info('vercel.lark.task.invoke', {
            executionId: runtime.executionId,
            threadId: runtime.threadId,
            companyId: runtime.companyId,
            userId: runtime.userId,
            operation: input.operation,
            authProvider: runtime.authProvider,
            credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
            hasLarkTenantKey: Boolean(runtime.larkTenantKey),
            hasLarkOpenId: Boolean(runtime.larkOpenId),
            hasLarkUserId: Boolean(runtime.larkUserId),
          });
          const resolveLarkTaskActionGroup = (): ToolActionGroup => {
            if (
              input.operation === 'list' ||
              input.operation === 'listMine' ||
              input.operation === 'listOpenMine' ||
              input.operation === 'get' ||
              input.operation === 'current' ||
              input.operation === 'listTasklists' ||
              input.operation === 'listAssignableUsers'
            ) {
              return 'read';
            }
            if (input.operation === 'delete') {
              return 'delete';
            }
            if (input.operation === 'create') {
              return 'create';
            }
            return 'update';
          };
          const taskPermissionError = ensureActionPermission(
            runtime,
            toCanonicalToolId('larkTask'),
            resolveLarkTaskActionGroup(),
          );
          if (taskPermissionError) {
            return taskPermissionError;
          }
          const defaults = await getLarkDefaults(runtime);
          const conversationKey = buildConversationKey(runtime.threadId);
          const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
          const normalizeLarkTimestamp = loadNormalizeLarkTimestamp();
          const isFirstPersonAssigneeAlias = (value: string): boolean =>
            ['me', 'myself', 'self'].includes(value.trim().toLowerCase());
          const normalizedAssigneeRequest = (() => {
            if (input.assigneeMode === 'self') {
              return {
                assignToMe: true,
                assigneeNames: [] as string[],
                assigneeIds: [] as string[],
              };
            }
            if (input.assigneeMode === 'named_people') {
              return {
                assignToMe: false,
                assigneeNames: (input.assigneeNames ?? []).filter((value) => value.trim().length > 0),
                assigneeIds: [] as string[],
              };
            }
            if (input.assigneeMode === 'canonical_ids') {
              const rawIds = (input.assigneeIds ?? []).filter((value) => value.trim().length > 0);
              const selfFromIds = rawIds.some((value) => isFirstPersonAssigneeAlias(value));
              return {
                assignToMe: input.assignToMe === true || selfFromIds,
                assigneeNames: [] as string[],
                assigneeIds: rawIds.filter((value) => !isFirstPersonAssigneeAlias(value)),
              };
            }

            const rawNames = (input.assigneeNames ?? []).filter((value) => value.trim().length > 0);
            const rawIds = (input.assigneeIds ?? []).filter((value) => value.trim().length > 0);
            const selfFromNames = rawNames.some((value) => isFirstPersonAssigneeAlias(value));
            const selfFromIds = rawIds.some((value) => isFirstPersonAssigneeAlias(value));

            return {
              assignToMe: input.assignToMe === true || selfFromNames || selfFromIds,
              assigneeNames: rawNames.filter((value) => !isFirstPersonAssigneeAlias(value)),
              assigneeIds: rawIds.filter((value) => !isFirstPersonAssigneeAlias(value)),
            };
          })();
          const currentIdentityTokens = uniqueDefinedStrings([
            runtime.larkOpenId,
            runtime.larkUserId,
          ]).map((value) => value.toLowerCase());
          const readObjectStrings = (value: unknown, depth = 0): string[] => {
            if (depth > 4) return [];
            if (typeof value === 'string' && value.trim()) return [value.trim()];
            if (Array.isArray(value)) {
              return value.flatMap((entry) => readObjectStrings(entry, depth + 1));
            }
            const record = asRecord(value);
            if (!record) return [];
            return Object.entries(record).flatMap(([key, entry]) => {
              const lowered = key.toLowerCase();
              if (
                lowered.includes('member') ||
                lowered.includes('assignee') ||
                lowered.includes('owner') ||
                lowered === 'id' ||
                lowered.endsWith('_id') ||
                lowered.endsWith('id') ||
                lowered.includes('open_id') ||
                lowered.includes('user_id')
              ) {
                return readObjectStrings(entry, depth + 1);
              }
              return [];
            });
          };
          const taskMatchesCurrentUser = (task: Record<string, unknown>): boolean => {
            if (currentIdentityTokens.length === 0) return false;
            const candidateValues = uniqueDefinedStrings([
              ...readObjectStrings(task).map((value) => value.toLowerCase()),
              ...readObjectStrings(asRecord(task.raw)).map((value) => value.toLowerCase()),
            ]);
            return currentIdentityTokens.some((token) => candidateValues.includes(token));
          };
          const taskHasAssignmentData = (task: Record<string, unknown>): boolean => {
            const raw = asRecord(task.raw);
            return [
              asArray(task.members),
              asArray(raw?.members),
              asArray(task.assignees),
              asArray(raw?.assignees),
            ].some((value) => value.length > 0)
              || Boolean(asRecord(task.owner))
              || Boolean(asRecord(raw?.owner))
              || Boolean(asRecord(task.assignee))
              || Boolean(asRecord(raw?.assignee));
          };
          const taskIsOpen = (task: Record<string, unknown>): boolean => {
            const completed = task.completed;
            if (typeof completed === 'boolean') {
              return !completed;
            }
            const status = asString(task.status)?.toLowerCase();
            if (!status) {
              return true;
            }
            return !['completed', 'done', 'closed'].includes(status);
          };
          const listVisibleTasks = async (
            preferredTasklistId?: string,
            options?: {
              includeAllTasklists?: boolean;
            },
          ): Promise<Array<Record<string, unknown>>> => {
            const explicitTasklistId = preferredTasklistId?.trim()
              || (options?.includeAllTasklists ? undefined : defaults?.defaultTasklistId);
            const seen = new Map<string, Record<string, unknown>>();
            const collectFromTasklist = async (tasklistId?: string) => {
              const result = await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.listTasks({
                  ...auth,
                  tasklistId,
                  pageSize: 100,
                }),
              );
              for (const item of result.items) {
                const key = asString(item.taskGuid) ?? asString(item.taskId);
                if (!key) continue;
                seen.set(key, item as unknown as Record<string, unknown>);
              }
            };

            if (explicitTasklistId) {
              await collectFromTasklist(explicitTasklistId);
              return Array.from(seen.values());
            }

            const tasklistsResult = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.listTasklists({
                ...auth,
                pageSize: 50,
              }),
            );
            const tasklistIds = uniqueDefinedStrings(
              tasklistsResult.items.map((item) => asString(item.tasklistId)),
            );
            if (tasklistIds.length === 0) {
              await collectFromTasklist(undefined);
              return Array.from(seen.values());
            }
            for (const tasklistId of tasklistIds) {
              await collectFromTasklist(tasklistId);
            }
            return Array.from(seen.values());
          };
          const hydrateTasksForCurrentUserFilter = async (
            items: Array<Record<string, unknown>>,
          ): Promise<Array<Record<string, unknown>>> => {
            const hydrated: Array<Record<string, unknown>> = [];
            for (const item of items) {
              if (taskMatchesCurrentUser(item) || taskHasAssignmentData(item)) {
                hydrated.push(item);
                continue;
              }
              const taskGuid = asString(item.taskGuid)
                ?? asString(asRecord(item.raw)?.guid)
                ?? asString(asRecord(item.raw)?.task_guid)
                ?? asString(asRecord(item.raw)?.taskGuid);
              if (!taskGuid) {
                hydrated.push(item);
                continue;
              }
              try {
                const detailed = await withLarkTenantFallback(runtime, (auth) =>
                  larkTasksService.getTask({
                    ...auth,
                    taskGuid,
                  }),
                );
                hydrated.push({
                  ...item,
                  ...detailed,
                  raw: {
                    ...(asRecord(item.raw) ?? {}),
                    ...(asRecord(detailed.raw) ?? {}),
                  },
                });
              } catch (error) {
                logger.warn('vercel.lark.task.hydrate_for_user_filter_failed', {
                  executionId: runtime.executionId,
                  companyId: runtime.companyId,
                  userId: runtime.userId,
                  taskGuid,
                  error: error instanceof Error ? error.message : 'unknown_error',
                });
                hydrated.push(item);
              }
            }
            return hydrated;
          };
          const filterVisibleTasks = (
            items: Array<Record<string, unknown>>,
            inputQuery?: string,
            options?: {
              onlyMine?: boolean;
              onlyOpen?: boolean;
            },
          ): Array<Record<string, unknown>> => {
            const normalizedQuery = inputQuery?.trim().toLowerCase();
            return items.filter((item) => {
              if (options?.onlyMine && !taskMatchesCurrentUser(item)) {
                return false;
              }
              if (options?.onlyOpen && !taskIsOpen(item)) {
                return false;
              }
              if (!normalizedQuery) {
                return true;
              }
              return `${asString(item.taskId) ?? ''} ${asString(item.summary) ?? ''}`
                .toLowerCase()
                .includes(normalizedQuery);
            });
          };
          const normalizeTaskSummary = (value?: string | null): string =>
            (value ?? '')
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
          const rememberTask = (task: Record<string, unknown>) => {
            const taskId = asString(task.taskId) ?? asString(task.task_id);
            if (!taskId) return;
            conversationMemoryStore.addLarkTask(conversationKey, {
              taskId,
              taskGuid: asString(task.taskGuid) ?? asString(task.task_guid) ?? asString(task.guid),
              summary: asString(task.summary),
              status: asString(task.status),
              url: asString(task.url),
            });
          };
          const extractTaskAssigneeIds = (task: Record<string, unknown>): string[] => {
            const readMemberId = (value: unknown): string | undefined => {
              const record = asRecord(value);
              if (!record) {
                return asString(value);
              }
              return (
                asString(record.id) ??
                asString(record.member_id) ??
                asString(record.member_open_id) ??
                asString(record.open_id) ??
                asString(record.user_id) ??
                asString(record.memberUserId) ??
                asString(record.memberOpenId) ??
                asString(record.larkOpenId) ??
                asString(record.externalUserId)
              );
            };
            const candidateCollections = [
              asArray(task.members),
              asArray(asRecord(task.raw)?.members),
              asArray(task.assignees),
              asArray(asRecord(task.raw)?.assignees),
            ];
            return uniqueDefinedStrings(
              candidateCollections.flatMap((collection) =>
                collection.map((entry) => readMemberId(entry)),
              ),
            );
          };
          const syncTaskAssignees = async (inputArgs: {
            taskGuid: string;
            desiredAssigneeIds: string[];
          }): Promise<{
            task: Record<string, unknown>;
            addedIds: string[];
            removedIds: string[];
            currentAssigneeIds: string[];
          }> => {
            const currentTask = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.getTask({
                ...auth,
                taskGuid: inputArgs.taskGuid,
              }),
            );
            const currentAssigneeIds = extractTaskAssigneeIds(currentTask);
            const desiredAssigneeIds = uniqueDefinedStrings(inputArgs.desiredAssigneeIds);
            const toAdd = desiredAssigneeIds.filter((id) => !currentAssigneeIds.includes(id));
            const toRemove = currentAssigneeIds.filter((id) => !desiredAssigneeIds.includes(id));

            if (toAdd.length > 0) {
              await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.addMembers({
                  ...auth,
                  taskGuid: inputArgs.taskGuid,
                  members: toAdd.map((id) => ({
                    id,
                    type: 'user',
                    role: 'assignee',
                  })),
                }),
              );
            }

            if (toRemove.length > 0) {
              await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.removeMembers({
                  ...auth,
                  taskGuid: inputArgs.taskGuid,
                  members: toRemove.map((id) => ({
                    id,
                    type: 'user',
                    role: 'assignee',
                  })),
                }),
              );
            }

            const refreshedTask =
              toAdd.length > 0 || toRemove.length > 0
                ? await withLarkTenantFallback(runtime, (auth) =>
                    larkTasksService.getTask({
                      ...auth,
                      taskGuid: inputArgs.taskGuid,
                    }),
                  )
                : currentTask;

            return {
              task: refreshedTask,
              addedIds: toAdd,
              removedIds: toRemove,
              currentAssigneeIds,
            };
          };
          const resolveTaskGuid = async (taskRef?: string): Promise<string | null> => {
            const trimmed = taskRef?.trim();
            if (!trimmed) {
              return latestTask?.taskGuid ?? null;
            }
            if (/^[0-9a-f]{8}-/i.test(trimmed)) {
              return trimmed;
            }
            if (latestTask && (latestTask.taskId === trimmed || latestTask.taskGuid === trimmed)) {
              return latestTask.taskGuid ?? null;
            }
            const lookup = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.listTasks({
                ...auth,
                tasklistId: input.tasklistId ?? defaults?.defaultTasklistId,
                pageSize: 100,
              }),
            );
            const match = lookup.items.find(
              (item) =>
                asString(item.taskId) === trimmed ||
                asString(item.taskGuid) === trimmed ||
                asString(item.summary)?.toLowerCase() === trimmed.toLowerCase(),
            );
            if (match) rememberTask(match);
            return match ? (asString(match.taskGuid) ?? null) : null;
          };

          if (input.operation === 'listTasklists') {
            const tasklistsResult = await larkTasksService.listTasklists({
              ...getLarkAuthInput(runtime),
              pageSize: 50,
            });
            const normalizedQuery = input.query?.trim().toLowerCase();
            const items = normalizedQuery
              ? tasklistsResult.items.filter((item) => {
                  const haystack =
                    `${asString(item.tasklistId) ?? ''} ${asString(item.summary) ?? ''}`.toLowerCase();
                  return haystack.includes(normalizedQuery);
                })
              : tasklistsResult.items;
            return buildLarkItemsEnvelope({
              summary: `Found ${items.length} Lark tasklist(s).`,
              emptySummary: 'No Lark tasklists matched the request.',
              items,
              fullPayload: {
                pageToken: tasklistsResult.pageToken,
                hasMore: tasklistsResult.hasMore,
              },
            });
          }
          if (input.operation === 'listAssignableUsers') {
            const people = await loadListLarkTaskAssignablePeople()({
              companyId: runtime.companyId,
              appUserId: runtime.userId,
              requestLarkOpenId: runtime.larkOpenId,
            });
            const normalizedQuery = input.query?.trim().toLowerCase();
            const filtered = normalizedQuery
              ? people.filter((person) => {
                  const record = asRecord(person) ?? {};
                  return [
                    asString(record.displayName),
                    asString(record.email),
                    asString(record.externalUserId),
                    asString(record.larkOpenId),
                    asString(record.larkUserId),
                  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
                })
              : people;
            const enriched = filtered.map((person) => {
              const record = asRecord(person) ?? {};
              const assigneeId = asString(record.larkOpenId) ?? asString(record.externalUserId);
              return {
                ...record,
                ...(assigneeId ? { assigneeId } : {}),
              };
            });
            return buildLarkItemsEnvelope({
              summary: `Found ${enriched.length} assignable Lark teammate(s).`,
              emptySummary: 'No assignable Lark teammates matched the request.',
              items: enriched,
              keyData: {
                people:
                  enriched.length > LARK_LARGE_RESULT_THRESHOLD
                    ? enriched.map((person) => projectLarkItem(person))
                    : enriched,
              },
              fullPayload: {
                people:
                  enriched.length > LARK_LARGE_RESULT_THRESHOLD
                    ? enriched.map((person) => projectLarkItem(person))
                    : enriched,
              },
            });
          }

          if (input.operation === 'current') {
            if (latestTask?.taskGuid) {
              const task = await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.getTask({
                  ...auth,
                  taskGuid: latestTask.taskGuid,
                }),
              );
              rememberTask(task);
              return buildEnvelope({
                success: true,
                summary: `Fetched current Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
                keyData: { task },
                fullPayload: { task },
              });
            }
            const latestVisible = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.listTasks({
                ...auth,
                tasklistId: input.tasklistId?.trim() || defaults?.defaultTasklistId,
                pageSize: 25,
              }),
            );
            const sorted = [...latestVisible.items].sort(
              (a, b) => Number(asString(b.updatedAt) ?? '0') - Number(asString(a.updatedAt) ?? '0'),
            );
            const currentTask = sorted[0];
            if (!currentTask) {
              return buildEnvelope({
                success: false,
                summary: 'No current Lark task was found.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            rememberTask(currentTask);
            return buildEnvelope({
              success: true,
              summary: `Fetched current Lark task: ${asString(currentTask.summary) ?? asString(currentTask.taskId) ?? 'task'}.`,
              keyData: { task: currentTask },
              fullPayload: { task: currentTask },
            });
          }

          if (input.operation === 'get') {
            const taskGuid = await resolveTaskGuid(input.taskId);
            if (!taskGuid) {
              return buildEnvelope({
                success: false,
                summary: `No Lark task matched "${input.taskId?.trim() ?? ''}".`,
                errorKind: 'validation',
                retryable: false,
              });
            }
            const task = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.getTask({
                ...auth,
                taskGuid,
              }),
            );
            rememberTask(task);
            return buildEnvelope({
              success: true,
              summary: `Fetched Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
              keyData: { task },
              fullPayload: { task },
            });
          }

          if (
            input.operation === 'list' ||
            input.operation === 'listMine' ||
            input.operation === 'listOpenMine'
          ) {
            const requiresCurrentUserFilter =
              input.operation === 'listMine' ||
              input.operation === 'listOpenMine' ||
              input.onlyMine;
            const visibleTasks = await listVisibleTasks(input.tasklistId, {
              includeAllTasklists: requiresCurrentUserFilter && !input.tasklistId?.trim(),
            });
            let candidateTasks = visibleTasks;
            let items = filterVisibleTasks(candidateTasks, input.query, {
              onlyMine:
                requiresCurrentUserFilter,
              onlyOpen: input.operation === 'listOpenMine' || input.onlyOpen,
            });
            if (requiresCurrentUserFilter && items.length === 0 && visibleTasks.length > 0) {
              logger.info('vercel.lark.task.hydrate_for_user_filter', {
                executionId: runtime.executionId,
                companyId: runtime.companyId,
                userId: runtime.userId,
                visibleTaskCount: visibleTasks.length,
              });
              candidateTasks = await hydrateTasksForCurrentUserFilter(visibleTasks);
              items = filterVisibleTasks(candidateTasks, input.query, {
                onlyMine: true,
                onlyOpen: input.operation === 'listOpenMine' || input.onlyOpen,
              });
            }
            items.forEach(rememberTask);
            return buildLarkItemsEnvelope({
              summary:
                input.operation === 'listOpenMine' || input.onlyOpen
                  ? `Found ${items.length} open Lark task(s) for the current user.`
                  : input.operation === 'listMine' || input.onlyMine
                    ? `Found ${items.length} Lark task(s) for the current user.`
                    : `Found ${items.length} Lark task(s).`,
              emptySummary:
                input.operation === 'listOpenMine' || input.onlyOpen
                  ? 'No open Lark tasks matched the request for the current user.'
                  : input.operation === 'listMine' || input.onlyMine
                    ? 'No Lark tasks matched the request for the current user.'
                    : 'No Lark tasks matched the request.',
              items,
              fullPayload: {
                filteredForCurrentUser:
                  input.operation === 'listMine' ||
                  input.operation === 'listOpenMine' ||
                  input.onlyMine ||
                  false,
                filteredForOpen: input.operation === 'listOpenMine' || input.onlyOpen || false,
              },
            });
          }

          const tasklistId = input.tasklistId?.trim() || defaults?.defaultTasklistId;
          const resolvedAssignees =
            normalizedAssigneeRequest.assignToMe || normalizedAssigneeRequest.assigneeNames.length > 0
              ? await loadResolveLarkTaskAssignees()({
                  companyId: runtime.companyId,
                  appUserId: runtime.userId,
                  requestLarkOpenId: runtime.larkOpenId,
                  assigneeNames: normalizedAssigneeRequest.assigneeNames,
                  assignToMe: normalizedAssigneeRequest.assignToMe,
                })
              : null;
          const canonicalizedAssigneeIds =
            normalizedAssigneeRequest.assigneeIds.length > 0
              ? await loadCanonicalizeLarkPersonIds()({
                  companyId: runtime.companyId,
                  appUserId: runtime.userId,
                  requestLarkOpenId: runtime.larkOpenId,
                  assigneeIds: normalizedAssigneeRequest.assigneeIds,
                })
              : null;
          if (resolvedAssignees?.unresolved.length) {
            return buildEnvelope({
              success: false,
              summary: `No assignable teammate matched ${resolvedAssignees.unresolved.map((value) => `"${value}"`).join(', ')}.`,
              errorKind: 'validation',
              retryable: false,
            });
          }
          if (resolvedAssignees?.ambiguous.length) {
            const first = resolvedAssignees.ambiguous[0];
            const options = first.matches
              .map(
                (person) =>
                  asString(asRecord(person)?.displayName) ??
                  asString(asRecord(person)?.email) ??
                  asString(asRecord(person)?.externalUserId),
              )
              .filter((value): value is string => Boolean(value))
              .join(', ');
            return buildEnvelope({
              success: false,
              summary: `"${first.query}" matched multiple teammates (${options}). Please be more specific.`,
              errorKind: 'validation',
              retryable: false,
            });
          }
          if (canonicalizedAssigneeIds?.unresolvedIds.length) {
            return buildEnvelope({
              success: false,
              summary: `No assignable teammate matched id ${canonicalizedAssigneeIds.unresolvedIds.map((value) => `"${value}"`).join(', ')}.`,
              errorKind: 'validation',
              retryable: false,
              repairHints: {
                assigneeMode: 'Use assigneeMode=self or assignToMe=true for "me", assigneeNames for teammate names, and assigneeIds only for canonical Lark ids.',
              },
            });
          }
          if (canonicalizedAssigneeIds?.ambiguousIds.length) {
            const first = canonicalizedAssigneeIds.ambiguousIds[0];
            const options = first.matches
              .map(
                (person) =>
                  asString(asRecord(person)?.displayName) ??
                  asString(asRecord(person)?.email) ??
                  asString(asRecord(person)?.externalUserId),
              )
              .filter((value): value is string => Boolean(value))
              .join(', ');
            return buildEnvelope({
              success: false,
              summary: `Assignee id "${first.query}" matched multiple teammates (${options}). Please be more specific.`,
              errorKind: 'validation',
              retryable: false,
              repairHints: {
                assigneeMode: 'Use assigneeMode=self or assignToMe=true for "me". Use assigneeNames for teammate names, not assigneeIds.',
              },
            });
          }
          if (input.operation === 'delete') {
            const taskGuid = await resolveTaskGuid(input.taskId);
            if (!taskGuid) {
              return buildEnvelope({
                success: false,
                summary:
                  'No current task was found in this conversation. Read or create the task first, or provide a task ID.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.deleteTask({
                ...auth,
                taskGuid,
              }),
            );
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Deleted Lark task ${input.taskId?.trim() ?? taskGuid}.`,
              keyData: { task: { taskGuid } },
            });
          }

          const resolvedMembers = (resolvedAssignees?.people ?? [])
            .map((person) => {
              const record = asRecord(person) ?? {};
              return {
                id: asString(record.larkOpenId) ?? asString(record.externalUserId),
                role: 'assignee',
                type: 'user',
              };
            })
            .filter((person) => typeof person.id === 'string');
          const desiredAssigneeIds = uniqueDefinedStrings([
            ...resolvedMembers.map((person) => person.id),
            ...(canonicalizedAssigneeIds?.resolvedIds ?? []),
          ]);
          const fallbackSelfAssigneeId = runtime.larkOpenId?.trim();
          const effectiveDesiredAssigneeIds =
            desiredAssigneeIds.length > 0
              ? desiredAssigneeIds
              : fallbackSelfAssigneeId
                ? [fallbackSelfAssigneeId]
                : [];
          const assigneeChangeRequested = effectiveDesiredAssigneeIds.length > 0;
          const effectiveDesiredAssigneeMembers = effectiveDesiredAssigneeIds.map((id) => ({
            id,
            role: 'assignee',
            type: 'user',
          }));

          const baseBody: Record<string, unknown> = {
            ...(tasklistId ? { tasklist_id: tasklistId } : {}),
            ...(input.summary ? { summary: input.summary } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(input.dueTs
              ? { due: { timestamp: normalizeLarkTimestamp(input.dueTs, getLarkTimeZone()) } }
              : {}),
            ...(input.operation === 'complete' || input.completed !== undefined
              ? {
                  completed_at:
                    input.operation === 'complete' || input.completed ? String(Date.now()) : '0',
                }
              : {}),
            ...(input.extra ? { extra: input.extra } : {}),
            ...(input.customFields ? { custom_fields: input.customFields } : {}),
            ...(input.repeatRule ? { repeat_rule: input.repeatRule } : {}),
          };

          if (input.operation === 'create') {
            if (!input.summary && input.taskId?.trim() && assigneeChangeRequested) {
              input = {
                ...input,
                operation: 'assign',
              };
            }
          }

          if (input.operation === 'create') {
            if (!input.summary) {
              return buildEnvelope({
                success: false,
                summary: 'Lark task create requires summary.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (!assigneeChangeRequested) {
              return buildEnvelope({
                success: false,
                summary:
                  'Lark task create requires an assignee. Tell me whether this task is for you or name the teammate who should own it.',
                errorKind: 'missing_input',
                retryable: false,
                userAction:
                  'Please tell me whether this task is for you or who it should be assigned to.',
              });
            }
            const requestedSummary = normalizeTaskSummary(input.summary);
            const visibleTasks = await listVisibleTasks(tasklistId);
            const existingTask = visibleTasks.find(
              (item) =>
                requestedSummary.length > 0 &&
                normalizeTaskSummary(asString(item.summary)) === requestedSummary &&
                taskIsOpen(item),
            );
            if (existingTask) {
              let task = existingTask;
              let assigneeSyncSummary: string | null = null;
              const existingTaskGuid =
                asString(existingTask.taskGuid) ??
                asString(existingTask.task_guid) ??
                asString(existingTask.guid);
              if (existingTaskGuid && assigneeChangeRequested) {
                const assigneeSync = await syncTaskAssignees({
                  taskGuid: existingTaskGuid,
                  desiredAssigneeIds: effectiveDesiredAssigneeIds,
                });
                task = assigneeSync.task;
                assigneeSyncSummary =
                  assigneeSync.addedIds.length > 0 || assigneeSync.removedIds.length > 0
                    ? `assignees +${assigneeSync.addedIds.length}/-${assigneeSync.removedIds.length}`
                    : 'assignees unchanged';
              }
              rememberTask(task);
              return buildEnvelope({
                success: true,
                confirmedAction: true,
                summary: `Reused existing Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}${assigneeSyncSummary ? ` (${assigneeSyncSummary})` : ''}.`,
                keyData: { task, deduped: true },
                fullPayload: { task, deduped: true },
              });
            }
            let task = await larkTasksService.createTask({
              ...getLarkAuthInput(runtime),
              body: {
                ...baseBody,
                ...(effectiveDesiredAssigneeMembers.length > 0 ? { members: effectiveDesiredAssigneeMembers } : {}),
              },
            });
            let assigneeSyncSummary: string | null = null;
            const createdTaskGuid =
              asString(task.taskGuid) ?? asString(task.task_guid) ?? asString(task.guid);
            if (createdTaskGuid && assigneeChangeRequested) {
              const assigneeSync = await syncTaskAssignees({
                taskGuid: createdTaskGuid,
                desiredAssigneeIds: effectiveDesiredAssigneeIds,
              });
              task = assigneeSync.task;
              assigneeSyncSummary =
                assigneeSync.addedIds.length > 0 || assigneeSync.removedIds.length > 0
                  ? `assignees +${assigneeSync.addedIds.length}/-${assigneeSync.removedIds.length}`
                  : 'assignees unchanged';
            }
            rememberTask(task);
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Created Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}${assigneeSyncSummary ? ` (${assigneeSyncSummary})` : ''}.`,
              keyData: { task },
              fullPayload: { task },
            });
          }

          const taskGuid = await resolveTaskGuid(input.taskId);
          if (!taskGuid) {
            return buildEnvelope({
              success: false,
              summary:
                'No current task was found in this conversation. Read or create the task first, or provide a task ID.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const taskPayload = Object.fromEntries(
            Object.entries(baseBody).filter(([key]) => key !== 'tasklist_id'),
          );
          const updateFields = Object.keys(taskPayload)
            .map((field) => (field === 'completed' ? 'completed_at' : field))
            .filter((field) =>
              [
                'description',
                'extra',
                'start',
                'due',
                'completed_at',
                'summary',
                'repeat_rule',
                'custom_fields',
              ].includes(field),
            );
          if (updateFields.length === 0 && !assigneeChangeRequested) {
            return buildEnvelope({
              success: false,
              summary: 'Lark task update requires at least one field to change.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          let task = await withLarkTenantFallback(runtime, (auth) =>
            larkTasksService.getTask({
              ...auth,
              taskGuid,
            }),
          );
          if (updateFields.length > 0) {
            task = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.updateTask({
                ...auth,
                taskGuid,
                body: {
                  task: taskPayload,
                  update_fields: updateFields,
                },
              }),
            );
          }
          let assigneeSyncSummary: string | null = null;
          if (assigneeChangeRequested) {
            const assigneeSync = await syncTaskAssignees({
              taskGuid,
              desiredAssigneeIds: effectiveDesiredAssigneeIds,
            });
            task = assigneeSync.task;
            assigneeSyncSummary =
              assigneeSync.addedIds.length > 0 || assigneeSync.removedIds.length > 0
                ? `assignees +${assigneeSync.addedIds.length}/-${assigneeSync.removedIds.length}`
                : 'assignees unchanged';
          }
          rememberTask(task);
          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: `${input.operation === 'reassign' || input.operation === 'assign' ? 'Reassigned' : 'Updated'} Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}${assigneeSyncSummary ? ` (${assigneeSyncSummary})` : ''}.`,
            keyData: { task },
            fullPayload: { task },
          });
        }),
    }),


    larkCalendar: tool({
      description:
        'Comprehensive Lark Calendar tool for day lookups, attendee-aware scheduling, availability checks, and event mutations.',
      inputSchema: z.object({
        operation: z.enum([
          'listCalendars',
          'listEvents',
          'getEvent',
          'createEvent',
          'updateEvent',
          'deleteEvent',
          'listAvailability',
          'scheduleMeeting',
        ]),
        calendarId: z.string().optional(),
        calendarName: z.string().optional(),
        eventId: z.string().optional(),
        dateScope: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        searchStartTime: z.string().optional(),
        searchEndTime: z.string().optional(),
        durationMinutes: z.number().int().positive().max(1440).optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        attendeeNames: z.array(z.string()).optional(),
        attendeeIds: z.array(z.string()).optional(),
        includeMe: z.boolean().optional(),
        needNotification: z.boolean().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkCalendar', 'Running Lark Calendar workflow', async () => {
          const calendarService = loadLarkCalendarService();
          const resolveLarkCalendarActionGroup = (): ToolActionGroup => {
            if (
              input.operation === 'listCalendars' ||
              input.operation === 'listEvents' ||
              input.operation === 'getEvent' ||
              input.operation === 'listAvailability'
            ) {
              return 'read';
            }
            if (input.operation === 'deleteEvent') {
              return 'delete';
            }
            if (
              input.operation === 'createEvent' ||
              input.operation === 'scheduleMeeting'
            ) {
              return 'create';
            }
            return 'update';
          };
          const calendarPermissionError = ensureActionPermission(
            runtime,
            toCanonicalToolId('larkCalendar'),
            resolveLarkCalendarActionGroup(),
          );
          if (calendarPermissionError) {
            return calendarPermissionError;
          }
          const defaults = await getLarkDefaults(runtime);
          const normalizeLarkTimestamp = loadNormalizeLarkTimestamp();
          const resolveLarkPeople = loadResolveLarkPeople();
          const timeZone = getLarkTimeZone();
          const conversationKey = buildConversationKey(runtime.threadId);
          const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
          const effectiveDateScope = input.dateScope ?? runtime.dateScope;
          const latestUserMessage = runtime.latestUserMessage?.trim() ?? '';
          const authInput = getLarkAuthInput(runtime);
          const extractAttendeeNamesFromMessage = (message: string): string[] => {
            if (!message) return [];
            const attendeeBlock =
              message.match(
                /\battendees?\s+(.+?)(?=\s*(?:$| at\b| on\b| tomorrow\b| today\b))/i,
              )?.[1] ??
              message.match(/\bwith\s+(.+?)(?=\s*(?:$| at\b| on\b| tomorrow\b| today\b))/i)?.[1] ??
              '';
            if (!attendeeBlock) return [];
            return attendeeBlock
              .split(/,|\band\b/gi)
              .map((value) => value.trim())
              .filter(
                (value) => value.length > 0 && !/^(me|myself|us|ourselves|our team)$/i.test(value),
              );
          };
          const extractCalendarSummaryFromMessage = (message: string): string | undefined => {
            if (!message) return undefined;
            const quoted = message.match(/['"]([^'"]{3,120})['"]/);
            if (quoted?.[1]) {
              return quoted[1].trim();
            }
            const titled = message.match(/(.+?)\s+is\s+the\s+title\b/i);
            if (titled?.[1]) {
              return titled[1].trim().replace(/^["']|["']$/g, '');
            }
            const summaryAfterLabel = message.match(/\btitle\s*(?:is|:)\s*([^,\n]+)/i);
            if (summaryAfterLabel?.[1]) {
              return summaryAfterLabel[1].trim().replace(/^["']|["']$/g, '');
            }
            return undefined;
          };
          const extractCalendarStartTimeFromMessage = (message: string): string | undefined => {
            if (!message) return undefined;
            const explicitAt = message.match(
              /\bat\s+([^,\n]+?)(?=\s*(?:,|attendees?\b|with\b|for\b|$))/i,
            );
            if (explicitAt?.[1]) {
              return explicitAt[1].trim();
            }
            return undefined;
          };
          const resolvedAttendeeNames = (
            input.attendeeNames?.length
              ? input.attendeeNames
              : extractAttendeeNamesFromMessage(latestUserMessage)
          )
            .map((value) => value.trim())
            .filter(Boolean);
          const resolvedIncludeMe =
            input.includeMe ??
            /\b(me|myself|us|our calendars?|our calendar)\b/i.test(latestUserMessage);
          const attendeeAwareScheduling =
            input.operation === 'scheduleMeeting' ||
            (input.operation === 'createEvent' &&
              (resolvedAttendeeNames.length > 0 || Boolean(input.attendeeIds?.length)));
          const resolvedSummary =
            input.summary?.trim() || extractCalendarSummaryFromMessage(latestUserMessage);
          const resolvedStartTimeInput =
            input.startTime ??
            (input.operation === 'createEvent' ||
            input.operation === 'scheduleMeeting' ||
            input.operation === 'listAvailability'
              ? extractCalendarStartTimeFromMessage(latestUserMessage)
              : undefined);
          const toEpochMs = (value?: string): number | null => {
            const normalized = normalizeLarkTimestamp(value, timeZone);
            if (!normalized) {
              return null;
            }
            const parsed = Number(normalized);
            return Number.isFinite(parsed) ? parsed * 1000 : null;
          };
          const toRfc3339 = (value?: string): string | null => {
            const epochMs = toEpochMs(value);
            return epochMs ? new Date(epochMs).toISOString() : null;
          };
          const getCurrentDateParts = (offsetDays = 0) => {
            const formatter = new Intl.DateTimeFormat('en-CA', {
              timeZone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            });
            const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
            const parts = formatter.formatToParts(now);
            const read = (type: string) =>
              Number(parts.find((part) => part.type === type)?.value ?? '0');
            return {
              year: read('year'),
              month: read('month'),
              day: read('day'),
            };
          };
          const toEpochSecondsFromLocalParts = (inputArgs: {
            year: number;
            month: number;
            day: number;
            hour: number;
            minute: number;
            second: number;
          }): string | undefined => normalizeLarkTimestamp(
            `${String(inputArgs.year).padStart(4, '0')}-${String(inputArgs.month).padStart(2, '0')}-${String(inputArgs.day).padStart(2, '0')} ${String(inputArgs.hour).padStart(2, '0')}:${String(inputArgs.minute).padStart(2, '0')}:${String(inputArgs.second).padStart(2, '0')}`,
            timeZone,
          );
          const resolveDateScopeRange = (
            scope?: string,
          ): { startTime?: string; endTime?: string } => {
            const normalizedScope = scope?.trim().toLowerCase();
            if (!normalizedScope) {
              return {};
            }
            const isToday = normalizedScope === 'today';
            const isTomorrow = normalizedScope === 'tomorrow';
            const isYesterday = normalizedScope === 'yesterday';
            if (!isToday && !isTomorrow && !isYesterday) {
              return {};
            }
            const offsetDays = isTomorrow ? 1 : isYesterday ? -1 : 0;
            const parts = getCurrentDateParts(offsetDays);
            return {
              startTime: toEpochSecondsFromLocalParts({
                ...parts,
                hour: 0,
                minute: 0,
                second: 0,
              }),
              endTime: toEpochSecondsFromLocalParts({
                ...parts,
                hour: 23,
                minute: 59,
                second: 59,
              }),
            };
          };
          const formatEpoch = (epochMs: number): string => new Date(epochMs).toISOString();
          const mergeBusyIntervals = (
            items: Array<{ startMs: number; endMs: number }>,
          ): Array<{ startMs: number; endMs: number }> => {
            const sorted = [...items]
              .filter(
                (item) =>
                  Number.isFinite(item.startMs) &&
                  Number.isFinite(item.endMs) &&
                  item.endMs > item.startMs,
              )
              .sort((left, right) => left.startMs - right.startMs);
            const merged: Array<{ startMs: number; endMs: number }> = [];
            for (const item of sorted) {
              const last = merged[merged.length - 1];
              if (!last || item.startMs > last.endMs) {
                merged.push({ ...item });
                continue;
              }
              last.endMs = Math.max(last.endMs, item.endMs);
            }
            return merged;
          };
          const findEarliestCommonSlot = (inputArgs: {
            windowStartMs: number;
            windowEndMs: number;
            durationMinutes: number;
            busyIntervals: Array<{ startMs: number; endMs: number }>;
          }): { startMs: number; endMs: number } | null => {
            const merged = mergeBusyIntervals(inputArgs.busyIntervals);
            const durationMs = inputArgs.durationMinutes * 60_000;
            let cursor = inputArgs.windowStartMs;
            for (const busy of merged) {
              if (busy.startMs - cursor >= durationMs) {
                return { startMs: cursor, endMs: cursor + durationMs };
              }
              cursor = Math.max(cursor, busy.endMs);
            }
            if (inputArgs.windowEndMs - cursor >= durationMs) {
              return { startMs: cursor, endMs: cursor + durationMs };
            }
            return null;
          };
          const resolveAttendees = async (): Promise<{
            people: Array<Record<string, unknown>>;
            unresolved: string[];
            ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
            desiredIds: string[];
          }> => {
            const resolved = await resolveLarkPeople({
              companyId: runtime.companyId,
              appUserId: runtime.userId,
              requestLarkOpenId: runtime.larkOpenId,
              assigneeNames: resolvedAttendeeNames,
              assignToMe: resolvedIncludeMe,
            });
            const desiredIds = uniqueDefinedStrings([
              ...resolved.people.map(
                (person) =>
                  asString(asRecord(person)?.larkOpenId) ??
                  asString(asRecord(person)?.externalUserId),
              ),
              ...(input.attendeeIds ?? []),
            ]);
            return {
              ...resolved,
              desiredIds,
            };
          };

          if (input.operation === 'listCalendars') {
            const result = await calendarService.listCalendars({
              ...authInput,
              pageSize: 50,
            });
            const normalizedQuery = input.calendarName?.trim().toLowerCase();
            const calendars = normalizedQuery
              ? result.items.filter((item) =>
                  `${asString(item.calendarId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                    .toLowerCase()
                    .includes(normalizedQuery),
                )
              : result.items;
            return buildEnvelope({
              success: true,
              summary:
                calendars.length > 0
                  ? `Found ${calendars.length} Lark calendar(s).`
                  : 'No Lark calendars matched the request.',
              keyData: { calendars },
              fullPayload: { ...result, items: calendars },
            });
          }
          let resolvedCalendarId =
            input.calendarId?.trim() || defaults?.defaultCalendarId || latestEvent?.calendarId;
          if (!resolvedCalendarId && input.calendarName?.trim()) {
            const lookup = await calendarService.listCalendars({
              ...authInput,
              pageSize: 50,
            });
            const candidates = lookup.items.filter((item) =>
              `${asString(item.calendarId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                .toLowerCase()
                .includes(input.calendarName!.trim().toLowerCase()),
            );
            if (candidates.length === 0) {
              return buildEnvelope({
                success: false,
                summary: `No Lark calendar matched "${input.calendarName}".`,
                errorKind: 'validation',
                retryable: false,
              });
            }
            if (candidates.length > 1) {
              return buildEnvelope({
                success: false,
                summary: `Multiple Lark calendars matched "${input.calendarName}". Please provide calendarId explicitly.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            resolvedCalendarId = asString(candidates[0].calendarId);
          }
          if (!resolvedCalendarId && input.operation !== 'listAvailability') {
            try {
              const primary = await calendarService.getPrimaryCalendar(authInput);
              resolvedCalendarId = asString(primary.calendarId);
            } catch {
              return buildEnvelope({
                success: false,
                summary:
                  'No default Lark calendar is configured and no primary calendar could be resolved. Provide calendarId or calendarName.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
          }
          if (input.operation === 'listEvents' || input.operation === 'getEvent') {
            const dateScopeRange =
              !input.startTime && !input.endTime
                ? resolveDateScopeRange(effectiveDateScope)
                : {};
            const result = await calendarService.listEvents({
              ...authInput,
              calendarId: resolvedCalendarId,
              pageSize: 100,
              startTime: dateScopeRange.startTime
                ?? normalizeLarkTimestamp(input.startTime, timeZone),
              endTime: dateScopeRange.endTime
                ?? normalizeLarkTimestamp(input.endTime, timeZone),
            });
            const normalizedQuery = (
              input.operation === 'getEvent'
                ? input.eventId
                : input.query
            )
              ?.trim()
              .toLowerCase();
            const events = normalizedQuery
              ? result.items.filter((item) =>
                  `${asString(item.eventId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                    .toLowerCase()
                    .includes(normalizedQuery),
                )
              : result.items;
            events.forEach((item) => {
              conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
                eventId: asString(item.eventId) ?? '',
                calendarId: resolvedCalendarId as string,
                summary: asString(item.summary),
                startTime: asString(item.startTime),
                endTime: asString(item.endTime),
                url: asString(item.url),
              });
            });
            return buildLarkItemsEnvelope({
              summary: `Found ${events.length} Lark calendar event(s).`,
              emptySummary: 'No Lark calendar events matched the request.',
              items: events,
              keyData: {
                calendar: { calendarId: resolvedCalendarId },
                event: events[0],
              },
              fullPayload: { ...result },
            });
          }
          if (input.operation === 'listAvailability' || attendeeAwareScheduling) {
            const resolvedAttendees = await resolveAttendees();
            if (resolvedAttendees.unresolved.length > 0) {
              return buildEnvelope({
                success: false,
                summary: `No Lark teammate matched ${resolvedAttendees.unresolved.map((value) => `"${value}"`).join(', ')}.`,
                errorKind: 'validation',
                retryable: false,
              });
            }
            if (resolvedAttendees.ambiguous.length > 0) {
              const first = resolvedAttendees.ambiguous[0];
              const options = first.matches
                .map(
                  (person) =>
                    asString(asRecord(person)?.displayName) ??
                    asString(asRecord(person)?.email) ??
                    asString(asRecord(person)?.externalUserId),
                )
                .filter((value): value is string => Boolean(value))
                .join(', ');
              return buildEnvelope({
                success: false,
                summary: `"${first.query}" matched multiple teammates (${options}). Please be more specific.`,
                errorKind: 'validation',
                retryable: false,
              });
            }
            if (resolvedAttendees.desiredIds.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'Please tell me who should be included in the meeting.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }

            const explicitStartRfc3339 = toRfc3339(resolvedStartTimeInput);
            const explicitEndRfc3339 = toRfc3339(input.endTime);
            const inferredDurationMinutes =
              input.durationMinutes ??
              (explicitStartRfc3339 && explicitEndRfc3339
                ? Math.max(
                    1,
                    Math.round(
                      (Date.parse(explicitEndRfc3339) - Date.parse(explicitStartRfc3339)) / 60_000,
                    ),
                  )
                : undefined);
            const defaultMeetingDurationMinutes = 30;
            const effectiveDurationMinutes =
              inferredDurationMinutes ??
              (attendeeAwareScheduling && explicitStartRfc3339
                ? defaultMeetingDurationMinutes
                : undefined);
            const inferredExactEndRfc3339 =
              !explicitEndRfc3339 && explicitStartRfc3339 && effectiveDurationMinutes
                ? new Date(
                    Date.parse(explicitStartRfc3339) + effectiveDurationMinutes * 60_000,
                  ).toISOString()
                : explicitEndRfc3339;

            const searchStartTime =
              input.searchStartTime ?? resolvedStartTimeInput ?? effectiveDateScope;
            const searchEndTime =
              input.searchEndTime ??
              input.endTime ??
              (attendeeAwareScheduling && explicitStartRfc3339
                ? (inferredExactEndRfc3339 ??
                  new Date(
                    Date.parse(explicitStartRfc3339) + defaultMeetingDurationMinutes * 60_000,
                  ).toISOString())
                : undefined);
            const searchStartRfc3339 = input.searchStartTime
              ? toRfc3339(input.searchStartTime)
              : (explicitStartRfc3339 ?? toRfc3339(searchStartTime));
            const searchEndRfc3339 = input.searchEndTime
              ? toRfc3339(input.searchEndTime)
              : (toRfc3339(searchEndTime) ?? inferredExactEndRfc3339);
            if (!searchStartRfc3339 || !searchEndRfc3339) {
              return buildEnvelope({
                success: false,
                summary:
                  input.operation === 'listAvailability'
                    ? 'Availability lookup requires searchStartTime and searchEndTime.'
                    : 'Scheduling a meeting requires a concrete start time, or a search window. Provide startTime, or searchStartTime and searchEndTime.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const windowStartMs = Date.parse(searchStartRfc3339);
            const windowEndMs = Date.parse(searchEndRfc3339);
            if (
              !Number.isFinite(windowStartMs) ||
              !Number.isFinite(windowEndMs) ||
              windowEndMs <= windowStartMs
            ) {
              return buildEnvelope({
                success: false,
                summary:
                  'The requested scheduling window is invalid. searchEndTime must be after searchStartTime.',
                errorKind: 'validation',
                retryable: false,
              });
            }

            const freebusyByPerson = await Promise.all(
              resolvedAttendees.desiredIds.map(async (userId) => {
                const busy = await withLarkTenantFallback(runtime, (auth) =>
                  calendarService.listFreebusy({
                    ...auth,
                    userId,
                    userIdType: 'open_id',
                    timeMin: searchStartRfc3339,
                    timeMax: searchEndRfc3339,
                    includeExternalCalendar: true,
                    onlyBusy: true,
                  }),
                );
                return {
                  userId,
                  busy,
                };
              }),
            );

            const busyIntervals = freebusyByPerson.flatMap((entry) =>
              entry.busy
                .map((slot) => {
                  const record = asRecord(slot) ?? {};
                  return {
                    userId: entry.userId,
                    startMs: Date.parse(
                      asString(record.startTime) ?? asString(record.start_time) ?? '',
                    ),
                    endMs: Date.parse(asString(record.endTime) ?? asString(record.end_time) ?? ''),
                  };
                })
                .filter((slot) => Number.isFinite(slot.startMs) && Number.isFinite(slot.endMs)),
            );

            const availability = freebusyByPerson.map((entry) => {
              const person = resolvedAttendees.people.find(
                (candidate) =>
                  (asString(asRecord(candidate)?.larkOpenId) ??
                    asString(asRecord(candidate)?.externalUserId)) === entry.userId,
              );
              return {
                userId: entry.userId,
                displayName:
                  asString(asRecord(person)?.displayName) ??
                  asString(asRecord(person)?.email) ??
                  entry.userId,
                busy: entry.busy,
              };
            });

            if (input.operation === 'listAvailability') {
              return buildEnvelope({
                success: true,
                summary: `Fetched availability for ${availability.length} attendee(s).`,
                keyData: {
                  availability,
                  window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
                },
                fullPayload: {
                  availability,
                  busyIntervals,
                  window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
                },
              });
            }

            const durationMinutes = effectiveDurationMinutes;
            if (!resolvedSummary) {
              return buildEnvelope({
                success: false,
                summary: 'Meeting scheduling requires a summary/title.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (!durationMinutes && !(explicitStartRfc3339 && inferredExactEndRfc3339)) {
              return buildEnvelope({
                success: false,
                summary:
                  'Meeting scheduling requires a concrete startTime, or durationMinutes plus a search window.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }

            const chosenSlot = explicitStartRfc3339
              ? {
                  startMs: Date.parse(explicitStartRfc3339),
                  endMs: Date.parse(inferredExactEndRfc3339 as string),
                }
              : findEarliestCommonSlot({
                  windowStartMs,
                  windowEndMs,
                  durationMinutes: durationMinutes as number,
                  busyIntervals,
                });

            if (!chosenSlot) {
              return buildEnvelope({
                success: false,
                summary:
                  'No common free slot was found for the requested attendees in that time window.',
                errorKind: 'validation',
                retryable: false,
                fullPayload: {
                  availability,
                  window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
                },
              });
            }

            const eventBody = {
              summary: resolvedSummary,
              ...(input.description?.trim() ? { description: input.description.trim() } : {}),
              start_time: { timestamp: String(Math.floor(chosenSlot.startMs / 1000)) },
              end_time: { timestamp: String(Math.floor(chosenSlot.endMs / 1000)) },
            };
            const event = await calendarService.createEvent({
              ...authInput,
              calendarId: resolvedCalendarId,
              body: eventBody,
            });

            const attendeesToAdd = resolvedAttendees.people
              .filter((person) => !Boolean(asRecord(person)?.isCurrentUser))
              .map((person) => ({
                type: 'user',
                attendee_id:
                  asString(asRecord(person)?.larkOpenId) ??
                  asString(asRecord(person)?.externalUserId),
              }))
              .filter((item) => typeof item.attendee_id === 'string');

            let attendeeResult: Record<string, unknown> | null = null;
            if (attendeesToAdd.length > 0 && asString(event.eventId)) {
              attendeeResult = await calendarService.addEventAttendees({
                ...authInput,
                calendarId: resolvedCalendarId,
                eventId: asString(event.eventId),
                userIdType: 'open_id',
                needNotification: input.needNotification ?? true,
                attendees: attendeesToAdd,
              });
            }

            conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
              eventId: asString(event.eventId) ?? '',
              calendarId: resolvedCalendarId,
              summary: asString(event.summary) ?? resolvedSummary,
              startTime: asString(event.startTime) ?? formatEpoch(chosenSlot.startMs),
              endTime: asString(event.endTime) ?? formatEpoch(chosenSlot.endMs),
              url: asString(event.url),
            });
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Scheduled Lark meeting "${resolvedSummary}" for ${availability.length} attendee(s).`,
              keyData: {
                event,
                scheduledStartTime: formatEpoch(chosenSlot.startMs),
                scheduledEndTime: formatEpoch(chosenSlot.endMs),
                attendees: availability,
              },
              fullPayload: {
                event,
                attendeeResult,
                attendees: availability,
                chosenSlot: {
                  startTime: formatEpoch(chosenSlot.startMs),
                  endTime: formatEpoch(chosenSlot.endMs),
                },
                window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
              },
            });
          }
          const resolvedEventId = input.eventId?.trim() || latestEvent?.eventId;
          if (
            (input.operation === 'updateEvent' || input.operation === 'deleteEvent') &&
            !resolvedEventId
          ) {
            return buildEnvelope({
              success: false,
              summary: `No current event was found in this conversation. Read or create the event first, or provide an event ID.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (input.operation === 'deleteEvent') {
            await calendarService.deleteEvent({
              ...authInput,
              calendarId: resolvedCalendarId,
              eventId: resolvedEventId as string,
            });
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Deleted Lark calendar event ${resolvedEventId as string}.`,
              keyData: { event: { eventId: resolvedEventId } },
            });
          }
          const inferredCreateStartTime = resolvedStartTimeInput ?? effectiveDateScope;
          const inferredCreateEndTime =
            input.endTime ??
            (inferredCreateStartTime && normalizeLarkTimestamp(inferredCreateStartTime, timeZone)
              ? new Date(
                  (Number(normalizeLarkTimestamp(inferredCreateStartTime, timeZone)) + 30 * 60) *
                    1000,
                ).toISOString()
              : undefined);
          if (
            input.operation === 'createEvent' &&
            (!resolvedSummary || !inferredCreateStartTime || !inferredCreateEndTime)
          ) {
            return buildEnvelope({
              success: false,
              summary: 'Lark calendar create requires summary, startTime, and endTime.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const body = {
            ...(resolvedSummary ? { summary: resolvedSummary } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(inferredCreateStartTime
              ? {
                  start_time: {
                    timestamp: normalizeLarkTimestamp(inferredCreateStartTime, timeZone),
                  },
                }
              : {}),
            ...(inferredCreateEndTime
              ? { end_time: { timestamp: normalizeLarkTimestamp(inferredCreateEndTime, timeZone) } }
              : {}),
          };
          const event =
            input.operation === 'createEvent'
              ? await calendarService.createEvent({
                  ...authInput,
                  calendarId: resolvedCalendarId,
                  body,
                })
              : await calendarService.updateEvent({
                  ...authInput,
                  calendarId: resolvedCalendarId,
                  eventId: resolvedEventId as string,
                  body,
                });
          conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
            eventId: asString(event.eventId) ?? '',
            calendarId: resolvedCalendarId,
            summary: asString(event.summary) ?? resolvedSummary,
            startTime: asString(event.startTime),
            endTime: asString(event.endTime),
            url: asString(event.url),
          });
          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: `${input.operation === 'createEvent' ? 'Created' : 'Updated'} Lark calendar event: ${asString(event.summary) ?? asString(event.eventId) ?? 'event'}.`,
            keyData: { event },
            fullPayload: { event },
          });
        }),
    }),


    larkMeeting: tool({
      description:
        'Read-only Lark meeting and minute lookup. Use calendar for day-based meeting discovery.',
      inputSchema: z.object({
        operation: z.enum(['list', 'get', 'getMinute']),
        meetingId: z.string().optional(),
        meetingNo: z.string().optional(),
        minuteToken: z.string().optional(),
        query: z.string().optional(),
        dateScope: z.string().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkMeeting', 'Running Lark Meeting workflow', async () => {
          const effectiveDateScope = input.dateScope ?? runtime.dateScope;
          if (input.operation === 'list' && effectiveDateScope) {
            if (tools.larkCalendar?.execute) {
              return tools.larkCalendar.execute({
                operation: 'listEvents',
                dateScope: effectiveDateScope,
              });
            }
            return buildEnvelope({
              success: false,
              summary:
                'Date-scoped meeting lookup requires the Lark calendar tool, which is unavailable in this runtime.',
              errorKind: 'unsupported',
              retryable: false,
            });
          }
          if (input.operation === 'getMinute') {
            const minuteTokenOrUrl = input.minuteToken ?? input.query;
            if (!minuteTokenOrUrl?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getMinute requires minuteToken or query.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const minute = await loadLarkMinutesService().getMinute({
              ...getLarkAuthInput(runtime),
              minuteTokenOrUrl,
            });
            return buildEnvelope({
              success: true,
              summary: `Fetched Lark minute ${asString(minute.title) ?? asString(minute.minuteToken) ?? 'minute'}.`,
              keyData: { meeting: minute },
              fullPayload: { minute },
            });
          }
          if (input.operation === 'get') {
            const meetingId = input.meetingId?.trim() || input.meetingNo?.trim();
            if (!meetingId) {
              return buildEnvelope({
                success: false,
                summary: 'get requires meetingId or meetingNo.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const meeting = await loadLarkMeetingsService().getMeeting({
              ...getLarkAuthInput(runtime),
              meetingId,
            });
            return buildEnvelope({
              success: true,
              summary: `Fetched Lark meeting ${asString(meeting.topic) ?? asString(meeting.meetingId) ?? 'meeting'}.`,
              keyData: { meeting },
              fullPayload: { meeting },
            });
          }
          const result = await loadLarkMeetingsService().listMeetings({
            ...getLarkAuthInput(runtime),
            pageSize: 20,
          });
          const normalizedQuery = input.query?.trim().toLowerCase();
          const items = normalizedQuery
            ? result.items.filter((item) =>
                `${asString(item.meetingId) ?? ''} ${asString(item.topic) ?? ''}`
                  .toLowerCase()
                  .includes(normalizedQuery),
              )
            : result.items;
          return buildLarkItemsEnvelope({
            summary: `Found ${items.length} Lark meeting(s).`,
            emptySummary: 'No Lark meetings matched the request.',
            items,
            fullPayload: { ...result },
          });
        }),
    }),

    larkApproval: tool({
      description: 'Comprehensive Lark Approvals tool for instance listing, lookup, and creation.',
      inputSchema: z.object({
        operation: z.enum(['listInstances', 'getInstance', 'createInstance']),
        approvalCode: z.string().optional(),
        instanceCode: z.string().optional(),
        status: z.string().optional(),
        pageSize: z.number().int().min(1).max(50).optional(),
        body: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkApproval', 'Running Lark Approvals workflow', async () => {
          const approvalsService = loadLarkApprovalsService();
          const defaults = await getLarkDefaults(runtime);
          logger.info('vercel.lark.approval.invoke', {
            executionId: runtime.executionId,
            threadId: runtime.threadId,
            companyId: runtime.companyId,
            userId: runtime.userId,
            operation: input.operation,
            authProvider: runtime.authProvider,
            credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
            hasLarkTenantKey: Boolean(runtime.larkTenantKey),
            hasLarkOpenId: Boolean(runtime.larkOpenId),
            hasLarkUserId: Boolean(runtime.larkUserId),
            hasApprovalCode: Boolean(input.approvalCode?.trim() || defaults?.defaultApprovalCode),
            status: input.status ?? null,
          });
          if (input.operation === 'getInstance') {
            if (!input.instanceCode?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getInstance requires instanceCode.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const instance = await withLarkTenantFallback(runtime, (auth) =>
              approvalsService.getInstance({
                ...auth,
                instanceCode: input.instanceCode.trim(),
              }),
            );
            return buildEnvelope({
              success: true,
              summary: `Fetched Lark approval instance ${asString(instance.title) ?? asString(instance.instanceCode) ?? 'instance'}.`,
              keyData: { instance },
              fullPayload: { instance },
            });
          }
          if (input.operation === 'listInstances') {
            try {
              const result = await withLarkTenantFallback(runtime, (auth) =>
                approvalsService.listInstances({
                  ...auth,
                  approvalCode: input.approvalCode?.trim() || defaults?.defaultApprovalCode,
                  status: input.status,
                  pageSize: input.pageSize,
                }),
              );
              return buildLarkItemsEnvelope({
                summary: `Found ${result.items.length} Lark approval instance(s).`,
                emptySummary: 'No Lark approval instances matched the request.',
                items: result.items as Array<Record<string, unknown>>,
                fullPayload: result as unknown as Record<string, unknown>,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Lark approval list failed';
              if (message.toLowerCase().includes('field validation failed')) {
                logger.warn('vercel.lark.approval.list.degraded', {
                  executionId: runtime.executionId,
                  threadId: runtime.threadId,
                  companyId: runtime.companyId,
                  userId: runtime.userId,
                  approvalCode: input.approvalCode?.trim() || defaults?.defaultApprovalCode || null,
                  status: input.status ?? null,
                  error: message,
                });
                return buildEnvelope({
                  success: true,
                  summary:
                    'Approval-instance data is unavailable for this workspace configuration. Continue with the digest using the remaining sources and mention that approval-risk context is limited.',
                  keyData: { items: [] },
                  fullPayload: {
                    items: [],
                    degraded: true,
                    reason: 'approval_list_validation_failed',
                  },
                });
              }
              throw error;
            }
          }
          const body = input.body;
          if (!body) {
            return buildEnvelope({
              success: false,
              summary: 'createInstance requires body.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const instance = await withLarkTenantFallback(runtime, (auth) =>
            approvalsService.createInstance({
              ...auth,
              body: {
                ...body,
                ...(input.approvalCode?.trim() || defaults?.defaultApprovalCode
                  ? { approval_code: input.approvalCode?.trim() || defaults?.defaultApprovalCode }
                  : {}),
              },
            }),
          );
          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: `Created Lark approval instance ${asString(instance.title) ?? asString(instance.instanceCode) ?? 'instance'}.`,
            keyData: { instance },
            fullPayload: { instance },
          });
        }),
    }),

    larkBase: tool({
      description:
        'Comprehensive Lark Base tool for structured company tables and records in Lark Base (Bitable). Use this for Base apps/tables/records, not for personal memory or general chat recall.',
      inputSchema: z.object({
        operation: z.enum([
          'listApps',
          'listTables',
          'listViews',
          'listFields',
          'listRecords',
          'getRecord',
          'createRecord',
          'updateRecord',
          'deleteRecord',
        ]),
        appToken: z.string().optional(),
        tableId: z.string().optional(),
        viewId: z.string().optional(),
        recordId: z.string().optional(),
        query: z.string().optional(),
        filter: z.string().optional(),
        sort: z.string().optional(),
        fieldNames: z.array(z.string()).optional(),
        fields: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkBase', 'Running Lark Base workflow', async () => {
          const defaults = await getLarkDefaults(runtime);
          const appToken = input.appToken?.trim() || defaults?.defaultBaseAppToken;
          const tableId = input.tableId?.trim() || defaults?.defaultBaseTableId;
          const viewId = input.viewId?.trim() || defaults?.defaultBaseViewId;
          const baseService = loadLarkBaseService();
          const LarkRuntimeClientError = loadLarkRuntimeClientError();
          const baseConfigHint = [
            'If this keeps failing, check Company Admin -> Lark operational config for default Base app/table/view ids and verify the connected Lark app has Base permissions.',
            appToken
              ? `Current app token: ${appToken}.`
              : 'No Base app token is currently resolved.',
            tableId ? `Current table id: ${tableId}.` : 'No Base table id is currently resolved.',
            viewId ? `Current view id: ${viewId}.` : undefined,
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join(' ');
          const runWithLarkBaseAuth = <T>(
            run: (auth: Record<string, unknown>) => Promise<T>,
          ): Promise<T> => withLarkTenantFallback(runtime, run);

          try {
            if (input.operation === 'listApps') {
              const candidateTokens = Array.from(
                new Set(
                  [input.appToken?.trim(), defaults?.defaultBaseAppToken].filter(
                    (value): value is string => Boolean(value),
                  ),
                ),
              );
              if (candidateTokens.length === 0) {
                return buildEnvelope({
                  success: false,
                  summary:
                    'Automatic Lark Base app discovery is not available in this runtime. Provide appToken or configure a default Base app token in Company Admin.',
                  errorKind: 'missing_input',
                  retryable: false,
                });
              }
              const items = candidateTokens.map((token, index) => ({
                appToken: token,
                name:
                  index === 0 && token === defaults?.defaultBaseAppToken
                    ? 'Configured default Lark Base app'
                    : 'Provided Lark Base app',
                raw: { app_token: token },
              }));
              return buildLarkItemsEnvelope({
                summary: `Resolved ${items.length} Lark Base app token(s) from configured defaults or provided input.`,
                emptySummary: 'No Lark Base app tokens were resolved.',
                items,
              });
            }

            if (input.operation === 'listTables') {
              if (!appToken) {
                return buildEnvelope({
                  success: false,
                  summary: 'listTables requires appToken or a configured default Base app token.',
                  errorKind: 'missing_input',
                });
              }
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listTables({
                  ...auth,
                  appToken,
                  pageSize: 50,
                }),
              );
              return buildLarkItemsEnvelope({
                summary: `Found ${result.items.length} Lark Base table(s).`,
                emptySummary: 'No Lark Base tables were found.',
                items: result.items as Array<Record<string, unknown>>,
                keyData: { app: { appToken } },
                fullPayload: result as unknown as Record<string, unknown>,
              });
            }

            if (input.operation === 'listViews') {
              if (!appToken || !tableId) {
                return buildEnvelope({
                  success: false,
                  summary: 'listViews requires appToken and tableId, or configured defaults.',
                  errorKind: 'missing_input',
                });
              }
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listViews({
                  ...auth,
                  appToken,
                  tableId,
                  pageSize: 50,
                }),
              );
              return buildLarkItemsEnvelope({
                summary: `Found ${result.items.length} Lark Base view(s).`,
                emptySummary: 'No Lark Base views were found.',
                items: result.items as Array<Record<string, unknown>>,
                keyData: { app: { appToken }, table: { tableId } },
                fullPayload: result as unknown as Record<string, unknown>,
              });
            }

            if (input.operation === 'listFields') {
              if (!appToken || !tableId) {
                return buildEnvelope({
                  success: false,
                  summary: 'listFields requires appToken and tableId, or configured defaults.',
                  errorKind: 'missing_input',
                });
              }
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listFields({
                  ...auth,
                  appToken,
                  tableId,
                  pageSize: 200,
                }),
              );
              const filteredItems =
                input.fieldNames && input.fieldNames.length > 0
                  ? result.items.filter((item) =>
                      input.fieldNames?.some(
                        (fieldName) =>
                          (asString(item.fieldName) ?? '').toLowerCase() ===
                          fieldName.toLowerCase(),
                      ),
                    )
                  : result.items;
              return buildLarkItemsEnvelope({
                summary: `Found ${filteredItems.length} Lark Base field(s).`,
                emptySummary: 'No Lark Base fields matched the request.',
                items: filteredItems,
                keyData: { app: { appToken }, table: { tableId } },
                fullPayload: { ...result },
              });
            }

            if (input.operation === 'getRecord') {
              if (!appToken || !tableId || !input.recordId?.trim()) {
                return buildEnvelope({
                  success: false,
                  summary:
                    'getRecord requires appToken, tableId, and recordId, or configured app/table defaults.',
                  errorKind: 'missing_input',
                });
              }
              const record = await runWithLarkBaseAuth((auth) =>
                baseService.getRecord({
                  ...auth,
                  appToken,
                  tableId,
                  recordId: input.recordId.trim(),
                }),
              );
              return buildEnvelope({
                success: true,
                summary: `Fetched Lark Base record ${record.recordId}.`,
                keyData: { app: { appToken }, table: { tableId }, record },
                fullPayload: { record },
              });
            }

            if (input.operation === 'deleteRecord') {
              if (!appToken || !tableId || !input.recordId?.trim()) {
                return buildEnvelope({
                  success: false,
                  summary:
                    'deleteRecord requires appToken, tableId, and recordId, or configured app/table defaults.',
                  errorKind: 'missing_input',
                });
              }
              await runWithLarkBaseAuth((auth) =>
                baseService.deleteRecord({
                  ...auth,
                  appToken,
                  tableId,
                  recordId: input.recordId.trim(),
                }),
              );
              return buildEnvelope({
                success: true,
                confirmedAction: true,
                summary: `Deleted Lark Base record ${input.recordId.trim()}.`,
                keyData: {
                  app: { appToken },
                  table: { tableId },
                  record: { recordId: input.recordId.trim() },
                },
              });
            }

            if (input.operation === 'listRecords') {
              if (!appToken || !tableId) {
                return buildEnvelope({
                  success: false,
                  summary: 'listRecords requires appToken and tableId, or configured defaults.',
                  errorKind: 'missing_input',
                });
              }
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listRecords({
                  ...auth,
                  appToken,
                  tableId,
                  viewId,
                  pageSize: 50,
                }),
              );
              const normalizedQuery = input.query?.trim().toLowerCase();
              const items = normalizedQuery
                ? result.items.filter((item) =>
                    `${asString(item.recordId) ?? ''} ${JSON.stringify(asRecord(item.fields) ?? {})}`
                      .toLowerCase()
                      .includes(normalizedQuery),
                  )
                : result.items;
              return buildLarkItemsEnvelope({
                summary: `Found ${items.length} Lark Base record(s).`,
                emptySummary: 'No Lark Base records matched the request.',
                items,
                keyData: {
                  app: { appToken },
                  table: { tableId },
                  view: viewId ? { viewId } : undefined,
                },
                fullPayload: { ...result },
              });
            }

            if (!appToken || !tableId || !input.fields) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires appToken, tableId, and fields, or configured app/table defaults.`,
                errorKind: 'missing_input',
              });
            }
            const record =
              input.operation === 'createRecord'
                ? await runWithLarkBaseAuth((auth) =>
                    baseService.createRecord({
                      ...auth,
                      appToken,
                      tableId,
                      fields: input.fields,
                    }),
                  )
                : await runWithLarkBaseAuth((auth) =>
                    baseService.updateRecord({
                      ...auth,
                      appToken,
                      tableId,
                      recordId: input.recordId?.trim() ?? '',
                      fields: input.fields,
                    }),
                  );
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `${input.operation === 'createRecord' ? 'Created' : 'Updated'} Lark Base record ${asString(record.recordId) ?? 'record'}.`,
              keyData: {
                app: { appToken },
                table: { tableId },
                record,
              },
              fullPayload: { record },
            });
          } catch (error) {
            const summary =
              input.operation === 'listApps'
                ? 'Automatic Lark Base app discovery is not available in this runtime. Provide appToken or configure a default Base app token in Company Admin.'
                : error instanceof LarkRuntimeClientError
                  ? `Lark Base ${input.operation} failed: ${error.message}. ${baseConfigHint}`
                  : `Lark Base ${input.operation} failed: ${error instanceof Error ? error.message : 'unknown error'}. ${baseConfigHint}`;
            return buildEnvelope({
              success: false,
              summary,
              errorKind: inferErrorKind(summary),
              retryable: false,
            });
          }
        }),
    }),


    larkDoc: tool({
      description: 'Comprehensive Lark Docs tool for create, edit, read, and inspect.',
      inputSchema: z.object({
        operation: z.enum(['create', 'edit', 'read', 'inspect']),
        documentId: z.string().optional(),
        title: z.string().optional(),
        markdown: z.string().optional(),
        instruction: z.string().optional(),
        strategy: z.enum(['replace', 'append', 'patch', 'delete']).optional(),
        query: z.string().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkDoc', 'Running Lark Docs workflow', async () => {
          const larkDocsService = loadLarkDocsService();
          const conversationKey = buildConversationKey(runtime.threadId);
          if (input.operation === 'create') {
            if (!input.title?.trim() || !input.markdown) {
              return buildEnvelope({
                success: false,
                summary: 'create requires title and markdown.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const result = await larkDocsService.createMarkdownDoc({
              ...getLarkAuthInput(runtime),
              title: input.title,
              markdown: input.markdown,
            });
            conversationMemoryStore.addLarkDoc(conversationKey, {
              title: asString(result.title) ?? input.title,
              documentId: asString(result.documentId) ?? '',
              url: asString(result.url),
            });
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Created Lark Doc ${asString(result.url) ?? asString(result.documentId) ?? 'document'}.`,
              keyData: {
                documentId: asString(result.documentId),
                docUrl: asString(result.url),
                blockCount: typeof result.blockCount === 'number' ? result.blockCount : undefined,
              },
              fullPayload: result as unknown as Record<string, unknown>,
            });
          }
          if (input.operation === 'edit') {
            const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
            const documentId = input.documentId?.trim() || latestDoc?.documentId;
            if (!documentId) {
              return buildEnvelope({
                success: false,
                summary:
                  'No prior Lark Doc was found in this conversation. Please provide documentId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const result = await larkDocsService.editMarkdownDoc({
              ...getLarkAuthInput(runtime),
              documentId,
              instruction: input.instruction ?? 'Update the document.',
              strategy: input.strategy ?? 'patch',
              ...(input.markdown ? { newMarkdown: input.markdown } : {}),
            });
            conversationMemoryStore.addLarkDoc(conversationKey, {
              title: latestDoc?.title ?? 'Lark Doc',
              documentId: asString(result.documentId) ?? documentId,
              url: asString(result.url),
            });
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Updated Lark Doc ${asString(result.url) ?? asString(result.documentId) ?? documentId}.`,
              keyData: {
                documentId: asString(result.documentId) ?? documentId,
                docUrl: asString(result.url),
              },
              fullPayload: result as unknown as Record<string, unknown>,
            });
          }

          const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
          const documentId = input.documentId?.trim() || latestDoc?.documentId;
          if (!documentId) {
            return buildEnvelope({
              success: false,
              summary:
                'No prior Lark Doc was found in this conversation. Please provide documentId.',
              errorKind: 'missing_input',
            });
          }
          try {
            const larkDocsService = loadLarkDocsService();
            const result =
              input.operation === 'read'
                ? await larkDocsService.readDocument({
                    companyId: runtime.companyId,
                    larkTenantKey: runtime.larkTenantKey,
                    appUserId: runtime.userId,
                    credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
                    documentId,
                  })
                : await larkDocsService.inspectDocument({
                    companyId: runtime.companyId,
                    larkTenantKey: runtime.larkTenantKey,
                    appUserId: runtime.userId,
                    credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
                    documentId,
                  });
            return buildEnvelope({
              success: true,
              summary:
                input.operation === 'read'
                  ? `Read Lark Doc ${documentId}.`
                  : `Inspected Lark Doc ${documentId}.`,
              keyData: {
                documentId,
                docUrl: asString(result.url),
                blockCount: typeof result.blockCount === 'number' ? result.blockCount : undefined,
                headings: asArray(result.headings).filter(
                  (value): value is string => typeof value === 'string',
                ),
              },
              fullPayload: result as unknown as Record<string, unknown>,
            });
          } catch (error) {
            return buildEnvelope({
              success: false,
              summary: error instanceof Error ? error.message : 'Failed to inspect Lark Doc.',
              errorKind: 'api_failure',
              retryable: true,
            });
          }
        }),
    }),
  };

  return tools;
};
