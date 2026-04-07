import config from '../../../../../config';
import { tool } from 'ai';
import { z } from 'zod';

import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

export const buildWorkflowRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: Record<string, any>,
): Record<string, any> => {
  const {
    withLifecycle,
    buildEnvelope,
    ensureActionPermission,
    toCanonicalToolId,
    buildRuntimeWorkflowSession,
    loadDesktopWorkflowsService,
    buildRuntimeWorkflowDestinations,
    toWorkflowOutputConfig,
    resolveWorkflowOriginChatId,
    asString,
    asRecord,
    workflowDestinationSchema,
    workflowAttachedFileSchema,
    asArray,
    validateWorkflowSaveDestinations,
    loadWorkflowValidatorService,
    buildWorkflowValidationRepairHints,
    toWorkflowScheduleConfig,
    workflowScheduleInputSchema,
    humanizePollInterval,
    summarizeWorkflowCandidates,
  } = helpers;

  const tools = {
    workflowDraft: tool({
      description:
        'Create a reusable workflow/prompt draft or reopen an existing draft. Use when the user wants to make a process reusable, save it for later, or prepare it for scheduling.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(160).optional(),
          departmentId: z.string().uuid().nullable().optional(),
          destinations: z.array(workflowDestinationSchema).max(10).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowDraft', 'Preparing workflow draft', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'create');
          if (permissionError) {
            return permissionError;
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const destinations = input.destinations ?? buildRuntimeWorkflowDestinations(runtime);
          const desiredOutputConfig = toWorkflowOutputConfig(destinations, runtime);

          if (input.workflowId) {
            const existing = await workflowsService.get(session, input.workflowId);
            const nextOutputConfig = input.destinations ? desiredOutputConfig : existing.outputConfig;
            const nextOriginChatId = input.destinations
              ? resolveWorkflowOriginChatId({
                  runtime,
                  current: existing,
                  outputConfig: desiredOutputConfig,
                  preferRuntimeForCurrentChat: true,
                })
              : asString(existing.originChatId) ?? null;
            const updatePayload: Parameters<typeof workflowsService.update>[2] = {};
            if (input.name?.trim()) {
              updatePayload.name = input.name.trim();
            }
            if (input.destinations) {
              updatePayload.outputConfig = nextOutputConfig;
              updatePayload.originChatId = nextOriginChatId;
            }
            if (input.departmentId !== undefined || runtime.departmentId) {
              updatePayload.departmentId = input.departmentId ?? runtime.departmentId ?? null;
            }
            const normalized =
              Object.keys(updatePayload).length > 0
                ? await workflowsService.update(session, input.workflowId, updatePayload)
                : existing;
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Resumed workflow draft "${asString(normalized.name) ?? input.workflowId}".`,
              keyData: {
                workflowId: normalized.id,
                name: normalized.name,
                status: normalized.status,
              },
              fullPayload: normalized,
            });
          }

          const created = await workflowsService.createDraft(session, {
            name: input.name ?? null,
            departmentId: input.departmentId ?? runtime.departmentId ?? null,
            originChatId: null,
          });
          const originChatId = resolveWorkflowOriginChatId({
            runtime,
            current: created,
            outputConfig: desiredOutputConfig,
          });
          const normalized = await workflowsService.update(session, created.id as string, {
            outputConfig: desiredOutputConfig,
            ...(originChatId ? { originChatId } : {}),
            ...(input.departmentId !== undefined || runtime.departmentId
              ? { departmentId: input.departmentId ?? runtime.departmentId ?? null }
              : {}),
          });

          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: `Created workflow draft "${asString(normalized.name) ?? asString(created.name) ?? 'New workflow'}".`,
            keyData: {
              workflowId: normalized.id,
              name: normalized.name,
              status: normalized.status,
            },
            fullPayload: normalized,
          });
        }),
    }),

    workflowPlan: tool({
      description:
        'Advance workflow planning from a user brief. Use this when the user wants a reusable prompt/workflow or wants to schedule a repeatable process. If required details are missing, this tool returns exactly what to ask next.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid().optional(),
          brief: z.string().trim().min(1).max(12000).optional(),
          attachedFiles: z.array(workflowAttachedFileSchema).max(12).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowPlan', 'Planning workflow', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'create');
          if (permissionError) {
            return permissionError;
          }
          if (!input.brief?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'Workflow planning needs the process or prompt brief first.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user what reusable process/prompt they want to create.',
            });
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          let workflowId = input.workflowId;
          if (!workflowId) {
            const created = await workflowsService.createDraft(session, {
              departmentId: runtime.departmentId ?? null,
              originChatId: null,
            });
            const destinations = buildRuntimeWorkflowDestinations(runtime);
            const outputConfig = toWorkflowOutputConfig(destinations, runtime);
            const originChatId = resolveWorkflowOriginChatId({
              runtime,
              current: created,
              outputConfig,
            });
            const normalized = await workflowsService.update(session, created.id as string, {
              outputConfig,
              ...(originChatId ? { originChatId } : {}),
              ...(runtime.departmentId ? { departmentId: runtime.departmentId } : {}),
            });
            workflowId = asString(normalized.id) ?? asString(created.id);
          }
          if (!workflowId) {
            return buildEnvelope({
              success: false,
              summary: 'Workflow planning could not create a draft workflow.',
              errorKind: 'api_failure',
              retryable: true,
            });
          }

          const current = await workflowsService.get(session, workflowId);
          const planned = await workflowsService.author(
            session,
            workflowId,
            input.brief.trim(),
            input.attachedFiles ?? [],
          );
          const planningState = asRecord(planned.planningState);
          const openQuestions = asArray(planningState?.openQuestions)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          if (openQuestions.length > 0 && planningState?.readyToBuild !== true) {
            const firstQuestion =
              asString(openQuestions[0]?.question) ??
              'Ask the user for the next missing workflow detail.';
            return buildEnvelope({
              success: false,
              summary:
                asString(planned.aiDraft) ??
                asString(planned.userIntent) ??
                `Workflow planning needs more details. ${firstQuestion}`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: firstQuestion,
              keyData: {
                workflowId: planned.id,
                name: planned.name,
                readyToBuild: planningState?.readyToBuild ?? false,
                openQuestionCount: openQuestions.length,
              },
              fullPayload: planned,
            });
          }

          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary:
              planningState?.readyToBuild === true
                ? `Workflow "${asString(planned.name) ?? workflowId}" is ready to build.`
                : `Workflow "${asString(planned.name) ?? workflowId}" planning was updated.`,
            keyData: {
              workflowId: planned.id,
              name: planned.name,
              readyToBuild: planningState?.readyToBuild ?? false,
            },
            fullPayload: planned,
          });
        }),
    }),

    workflowBuild: tool({
      description:
        'Build the reusable workflow/prompt once planning is complete. If planning is still incomplete, this tool tells you exactly what to ask the user next.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowBuild', 'Building workflow', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'update');
          if (permissionError) {
            return permissionError;
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const current = await workflowsService.get(session, input.workflowId);
          const planningState = asRecord(current.planningState);
          const openQuestions = asArray(planningState?.openQuestions)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          if (planningState?.readyToBuild !== true) {
            const firstQuestion =
              asString(openQuestions[0]?.question) ??
              'Ask the user for the remaining workflow details before building.';
            return buildEnvelope({
              success: false,
              summary: `Workflow "${asString(current.name) ?? input.workflowId}" is not ready to build yet.`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: firstQuestion,
              keyData: {
                workflowId: current.id,
                name: current.name,
                openQuestionCount: openQuestions.length,
              },
              fullPayload: current,
            });
          }
          const destinationValidationError = validateWorkflowSaveDestinations({
            outputConfig: current.outputConfig,
            originChatId: resolveWorkflowOriginChatId({
              runtime,
              current,
              outputConfig: current.outputConfig,
            }),
          });
          if (destinationValidationError) {
            return destinationValidationError;
          }

          const built = await workflowsService.author(
            session,
            input.workflowId,
            'Build the reusable workflow now.',
          );
          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: `Built workflow "${asString(built.name) ?? input.workflowId}".`,
            keyData: {
              workflowId: built.id,
              name: built.name,
              built:
                typeof built.compiledPrompt === 'string' && built.compiledPrompt.trim().length > 0,
            },
            fullPayload: built,
          });
        }),
    }),

    workflowValidate: tool({
      description:
        'Validate a built workflow before saving or scheduling it. Returns blocking errors plus warnings that should be surfaced to the user before publishing.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowValidate', 'Validating workflow', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'read');
          if (permissionError) {
            return permissionError;
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const validator = loadWorkflowValidatorService();
          const current = await workflowsService.get(session, input.workflowId);
          if (typeof current.compiledPrompt !== 'string' || !current.compiledPrompt.trim()) {
            return buildEnvelope({
              success: false,
              summary: `Workflow "${asString(current.name) ?? input.workflowId}" must be built before validation can run.`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Build the workflow first, then validate it.',
              missingFields: ['compiledPrompt'],
              fullPayload: current,
            });
          }
          const validation = validator.validateDefinition({
            userIntent: current.userIntent,
            workflowSpec: current.workflowSpec,
            schedule: current.schedule,
            outputConfig: current.outputConfig,
            originChatId: asString(current.originChatId) ?? null,
          });
          const errors = asArray(asRecord(validation)?.errors)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          const warnings = asArray(asRecord(validation)?.warnings)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          if (errors.length > 0) {
            return buildEnvelope({
              success: false,
              summary: `Workflow "${asString(current.name) ?? input.workflowId}" has ${errors.length} validation error(s) that must be fixed before it can be saved.`,
              errorKind: 'validation',
              retryable: false,
              repairHints: buildWorkflowValidationRepairHints(errors),
              userAction: errors
                .map((entry) => asString(entry.humanReadable))
                .filter((entry): entry is string => Boolean(entry))
                .slice(0, 4)
                .join('\n'),
              keyData: {
                workflowId: current.id,
                valid: false,
                errorCount: errors.length,
                warningCount: warnings.length,
              },
              fullPayload: validation,
            });
          }
          return buildEnvelope({
            success: true,
            summary: warnings.length > 0
              ? `Workflow "${asString(current.name) ?? input.workflowId}" passed validation with ${warnings.length} warning(s).`
              : `Workflow "${asString(current.name) ?? input.workflowId}" passed validation.`,
            keyData: {
              workflowId: current.id,
              valid: true,
              warningCount: warnings.length,
              requiresWarningConfirmation: warnings.length > 0,
            },
            fullPayload: validation,
          });
        }),
    }),

    workflowSave: tool({
      description:
        'Save or publish a built reusable workflow. Requires explicit confirmation before saving, and never enables a schedule unless explicitly requested.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid(),
          confirm: z.boolean().optional(),
          scheduleEnabled: z.boolean().optional(),
          departmentId: z.string().uuid().nullable().optional(),
          destinations: z.array(workflowDestinationSchema).max(10).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowSave', 'Saving workflow', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'update');
          if (permissionError) {
            return permissionError;
          }
          if (input.confirm !== true) {
            return buildEnvelope({
              success: false,
              summary: input.scheduleEnabled
                ? 'Saving and enabling a workflow schedule requires explicit confirmation.'
                : 'Saving this reusable workflow requires explicit confirmation.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: input.scheduleEnabled
                ? 'Ask the user to confirm saving and enabling the schedule.'
                : 'Ask the user to confirm saving the reusable workflow.',
            });
          }

          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const current = await workflowsService.get(session, input.workflowId);
          if (typeof current.compiledPrompt !== 'string' || !current.compiledPrompt.trim()) {
            return buildEnvelope({
              success: false,
              summary: `Workflow "${asString(current.name) ?? input.workflowId}" is not built yet.`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Build the workflow first, then save or publish it.',
              fullPayload: current,
            });
          }

          const outputConfig = input.destinations
            ? toWorkflowOutputConfig(input.destinations, runtime)
            : current.outputConfig;
          const originChatId = resolveWorkflowOriginChatId({
            runtime,
            current,
            outputConfig,
            preferRuntimeForCurrentChat: Boolean(input.destinations),
          });
          const destinationValidationError = validateWorkflowSaveDestinations({
            outputConfig,
            originChatId,
          });
          if (destinationValidationError) {
            return destinationValidationError;
          }
          const validation = loadWorkflowValidatorService().validateDefinition({
            userIntent: current.userIntent,
            workflowSpec: current.workflowSpec,
            schedule: current.schedule,
            outputConfig,
            originChatId,
          });
          const validationErrors = asArray(asRecord(validation)?.errors)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          if (validationErrors.length > 0) {
            return buildEnvelope({
              success: false,
              summary: `Workflow "${asString(current.name) ?? input.workflowId}" still has validation errors and cannot be saved yet.`,
              errorKind: 'validation',
              retryable: false,
              repairHints: buildWorkflowValidationRepairHints(validationErrors),
              userAction: validationErrors
                .map((entry) => asString(entry.humanReadable))
                .filter((entry): entry is string => Boolean(entry))
                .slice(0, 4)
                .join('\n'),
              keyData: {
                workflowId: current.id,
                errorCount: validationErrors.length,
              },
              fullPayload: validation,
            });
          }
          const published = await workflowsService.publish(session, {
            workflowId: current.id,
            name: current.name,
            userIntent: current.userIntent,
            aiDraft: current.aiDraft ?? undefined,
            workflowSpec: current.workflowSpec,
            compiledPrompt: current.compiledPrompt,
            schedule: current.schedule,
            scheduleEnabled: input.scheduleEnabled ?? false,
            outputConfig,
            originChatId,
            departmentId:
              input.departmentId ?? runtime.departmentId ?? current.departmentId ?? null,
          });

          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: input.scheduleEnabled
              ? `Saved and scheduled workflow "${asString(current.name) ?? input.workflowId}".`
              : `Saved workflow "${asString(current.name) ?? input.workflowId}".`,
            keyData: {
              workflowId: published.workflowId,
              status: published.status,
              scheduleEnabled: published.scheduleEnabled,
              nextRunAt: published.nextRunAt,
              primaryThreadId: published.primaryThreadId,
            },
            fullPayload: published,
          });
        }),
    }),

    workflowSchedule: tool({
      description:
        'Update a workflow schedule or enable/disable scheduling. If timing is missing, this tool tells you what to ask the user next. Enabling a schedule requires explicit confirmation.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid(),
          schedule: workflowScheduleInputSchema.optional(),
          scheduleEnabled: z.boolean().optional(),
          confirm: z.boolean().optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowSchedule', 'Updating workflow schedule', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'update');
          if (permissionError) {
            return permissionError;
          }
          if (!input.schedule && input.scheduleEnabled === undefined) {
            return buildEnvelope({
              success: false,
              summary:
                'Workflow scheduling needs either a new schedule or an explicit enable/disable decision.',
              errorKind: 'missing_input',
              retryable: false,
              userAction:
                'Ask the user what schedule to set, or whether they want scheduling enabled or paused.',
            });
          }

          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          let current = await workflowsService.get(session, input.workflowId);
          if (input.schedule) {
            const parsedSchedule = toWorkflowScheduleConfig(input.schedule);
            if (!parsedSchedule.ok) {
              return buildEnvelope({
                success: false,
                summary: parsedSchedule.summary,
                errorKind: 'missing_input',
                retryable: false,
                userAction: parsedSchedule.userAction,
              });
            }
            current = await workflowsService.update(session, input.workflowId, {
              schedule: parsedSchedule.schedule,
            });
          }

          if (input.scheduleEnabled === true) {
            if (input.confirm !== true) {
              return buildEnvelope({
                success: false,
                summary: 'Enabling a workflow schedule requires explicit confirmation.',
                errorKind: 'missing_input',
                retryable: false,
                userAction: 'Ask the user to confirm enabling the workflow schedule.',
              });
            }
            if (
              typeof current.compiledPrompt !== 'string' ||
              !current.compiledPrompt.trim() ||
              asString(current.status) === 'draft'
            ) {
              return buildEnvelope({
                success: false,
                summary: `Workflow "${asString(current.name) ?? input.workflowId}" must be built and saved before scheduling is enabled.`,
                errorKind: 'missing_input',
                retryable: false,
                userAction: 'Build and save the workflow first, then enable its schedule.',
              });
            }
            const outputDestinationValidation = validateWorkflowSaveDestinations({
              outputConfig: current.outputConfig,
              originChatId: resolveWorkflowOriginChatId({
                runtime,
                current,
                outputConfig: current.outputConfig,
              }),
            });
            if (outputDestinationValidation) {
              return outputDestinationValidation;
            }
            const scheduled = await workflowsService.setScheduleState(
              session,
              input.workflowId,
              true,
            );
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Enabled scheduling for "${asString(current.name) ?? input.workflowId}".`,
              keyData: {
                ...scheduled,
                pollIntervalMs: config.DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS,
                pollIntervalSummary: humanizePollInterval(
                  config.DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS,
                ),
              },
              fullPayload: {
                ...scheduled,
                pollIntervalMs: config.DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS,
                pollIntervalSummary: humanizePollInterval(
                  config.DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS,
                ),
              },
            });
          }

          if (input.scheduleEnabled === false) {
            const paused = await workflowsService.setScheduleState(
              session,
              input.workflowId,
              false,
            );
            return buildEnvelope({
              success: true,
              confirmedAction: true,
              summary: `Paused scheduling for "${asString(current.name) ?? input.workflowId}".`,
              keyData: paused,
              fullPayload: paused,
            });
          }

          const refreshed = await workflowsService.get(session, input.workflowId);
          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: `Updated the saved schedule for "${asString(refreshed.name) ?? input.workflowId}".`,
            keyData: {
              workflowId: refreshed.id,
              schedule: refreshed.schedule,
            },
            fullPayload: refreshed,
          });
        }),
    }),

    workflowList: tool({
      description:
        'List saved reusable prompts/workflows available to the current user. Use this for requests like "show my saved prompts" or "list workflows".',
      inputSchema: z
        .object({
          query: z.string().trim().max(160).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowList', 'Listing workflows', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'read');
          if (permissionError) {
            return permissionError;
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflows = await loadDesktopWorkflowsService().listVisibleSummaries(session);
          const filtered = input.query?.trim()
            ? workflows.filter((workflow) =>
                (asString(workflow.name) ?? '')
                  .toLowerCase()
                  .includes(input.query!.trim().toLowerCase()),
              )
            : workflows;
          return buildEnvelope({
            success: true,
            summary:
              filtered.length > 0
                ? `Found ${filtered.length} saved workflow(s).`
                : 'No saved workflows matched the current request.',
            keyData: {
              workflowCount: filtered.length,
            },
            fullPayload: {
              workflows: filtered,
            },
          });
        }),
    }),

    workflowArchive: tool({
      description:
        'Archive or delete a saved workflow by id or exact/near-exact name. Requires explicit confirmation before removing it from the active workflow list.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(160).optional(),
          confirm: z.boolean().optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowArchive', 'Archiving workflow', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'delete');
          if (permissionError) {
            return permissionError;
          }
          const reference = input.workflowId ?? input.name?.trim();
          if (!reference) {
            return buildEnvelope({
              success: false,
              summary: 'Workflow archive needs a workflow id or workflow name.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user which saved workflow should be archived.',
            });
          }
          if (input.confirm !== true) {
            return buildEnvelope({
              success: false,
              summary: 'Archiving a saved workflow requires explicit confirmation.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user to confirm archiving this workflow.',
            });
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const resolved = await workflowsService.resolveVisibleWorkflow(session, reference);
          if (resolved.status === 'not_found') {
            return buildEnvelope({
              success: false,
              summary: `No saved workflow matched "${reference}".`,
              errorKind: 'missing_input',
              retryable: false,
              userAction:
                'Ask the user for the exact workflow name or tell them to list saved workflows first.',
            });
          }
          if (resolved.status === 'ambiguous') {
            return buildEnvelope({
              success: false,
              summary: `Multiple saved workflows matched "${reference}":\n${summarizeWorkflowCandidates(resolved.candidates as Array<Record<string, unknown>>)}`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user which exact saved workflow should be archived.',
              fullPayload: resolved,
            });
          }
          const workflowId = asString(asRecord(resolved.workflow)?.id) ?? reference;
          const workflowName = asString(asRecord(resolved.workflow)?.name) ?? workflowId;
          await workflowsService.archive(session, workflowId);
          return buildEnvelope({
            success: true,
            confirmedAction: true,
            summary: `Archived workflow "${workflowName}".`,
            keyData: {
              workflowId,
              archived: true,
            },
            fullPayload: {
              workflowId,
              name: workflowName,
              archived: true,
            },
          });
        }),
    }),

    workflowRun: tool({
      description:
        'Run a saved workflow now by id or exact/near-exact name. Use this when the user asks to run a saved prompt/workflow, not when they want immediate ad hoc execution.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(160).optional(),
          overrideText: z.string().trim().max(4000).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowRun', 'Running saved workflow', async () => {
          const permissionError = ensureActionPermission(runtime, toCanonicalToolId('workflow-authoring'), 'execute');
          if (permissionError) {
            return permissionError;
          }
          const reference = input.workflowId ?? input.name?.trim();
          if (!reference) {
            return buildEnvelope({
              success: false,
              summary: 'Workflow execution needs a workflow id or workflow name.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user which saved workflow should be run.',
            });
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const resolved = await workflowsService.resolveVisibleWorkflow(session, reference);
          if (resolved.status === 'not_found') {
            return buildEnvelope({
              success: false,
              summary: `No saved workflow matched "${reference}".`,
              errorKind: 'missing_input',
              retryable: false,
              userAction:
                'Ask the user for the exact workflow name or tell them to list saved workflows first.',
            });
          }
          if (resolved.status === 'ambiguous') {
            return buildEnvelope({
              success: false,
              summary: `Multiple saved workflows matched "${reference}":\n${summarizeWorkflowCandidates(resolved.candidates as Array<Record<string, unknown>>)}`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user which exact saved workflow should run.',
              fullPayload: resolved,
            });
          }
          const run = await workflowsService.runNow(
            session,
            asString(asRecord(resolved.workflow)?.id) ?? reference,
            input.overrideText ?? null,
          );
          return buildEnvelope({
            success: asString(run.status) !== 'failed',
            confirmedAction: asString(run.status) !== 'failed',
            summary:
              asString(run.resultSummary) ??
              (asString(run.errorSummary)
                ? `Workflow run finished with an issue: ${asString(run.errorSummary)}`
                : `Started workflow "${asString(asRecord(resolved.workflow)?.name) ?? reference}".`),
            keyData: {
              workflowId: run.workflowId,
              runId: run.runId,
              status: run.status,
              threadId: run.threadId,
            },
            fullPayload: {
              resolved,
              run,
            },
            ...(asString(run.status) === 'failed'
              ? { errorKind: 'api_failure' as const, retryable: true }
              : {}),
          });
        }),
    }),
  };

  return tools;
};
