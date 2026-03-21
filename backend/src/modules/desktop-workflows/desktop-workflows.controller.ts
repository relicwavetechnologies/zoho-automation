import { Request, Response } from 'express';
import { z } from 'zod';

import {
  scheduledWorkflowCapabilitySummarySchema,
  scheduledWorkflowSpecSchema,
} from '../../company/scheduled-workflows/contracts';
import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { attachedFileSchema } from '../desktop-chat/desktop-chat.schemas';
import { desktopWorkflowsService } from './desktop-workflows.service';
import { zonedDateTimeToUtc } from './desktop-workflows.schedule';

const dayOfWeekSchema = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const uiScheduleSchema = z.discriminatedUnion('frequency', [
  z.object({
    frequency: z.literal('daily'),
    timezone: z.string().trim().min(1).max(100),
    time: timeSchema,
  }).strict(),
  z.object({
    frequency: z.literal('hourly'),
    timezone: z.string().trim().min(1).max(100),
    intervalHours: z.number().int().min(1).max(24),
    minute: z.number().int().min(0).max(59).optional(),
  }).strict(),
  z.object({
    frequency: z.literal('weekly'),
    timezone: z.string().trim().min(1).max(100),
    time: timeSchema,
    dayOfWeek: dayOfWeekSchema,
  }).strict(),
  z.object({
    frequency: z.literal('monthly'),
    timezone: z.string().trim().min(1).max(100),
    time: timeSchema,
    dayOfMonth: z.number().int().min(1).max(31),
  }).strict(),
  z.object({
    frequency: z.literal('one_time'),
    timezone: z.string().trim().min(1).max(100),
    time: timeSchema,
    runDate: dateSchema,
  }).strict(),
]);

const destinationInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('desktop_inbox'),
    label: z.string().trim().max(160).optional(),
  }).strict(),
  z.object({
    kind: z.literal('desktop_thread'),
    label: z.string().trim().max(160).optional(),
    value: z.string().trim().max(160).optional(),
  }).strict(),
  z.object({
    kind: z.literal('lark_chat'),
    label: z.string().trim().max(160).optional(),
    value: z.string().trim().max(160).optional(),
  }).strict(),
]);

const compileWorkflowRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  userIntent: z.string().trim().min(1).max(10000),
  schedule: uiScheduleSchema,
  destinations: z.array(destinationInputSchema).max(10).default([]),
  attachedFiles: z.array(attachedFileSchema).optional().default([]),
}).strict();

const publishWorkflowRequestSchema = compileWorkflowRequestSchema.extend({
  workflowId: z.string().uuid().nullable().optional(),
  aiDraft: z.string().trim().min(1).max(12000).optional(),
  scheduleEnabled: z.boolean().optional().default(false),
  compiledPrompt: z.string().trim().min(1).max(50000),
  workflowSpec: scheduledWorkflowSpecSchema,
  capabilitySummary: scheduledWorkflowCapabilitySummarySchema.optional(),
  departmentId: z.string().uuid().nullable().optional(),
}).strict();

const createDraftRequestSchema = z.object({
  name: z.string().trim().max(160).optional(),
  departmentId: z.string().uuid().nullable().optional(),
}).strict();

const workflowAuthorMessageSchema = z.object({
  message: z.string().trim().min(1).max(12000),
  attachedFiles: z.array(attachedFileSchema).optional().default([]),
}).strict();

const updateWorkflowRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  userIntent: z.string().trim().max(10000).optional(),
  aiDraft: z.string().trim().max(12000).nullable().optional(),
  workflowSpec: scheduledWorkflowSpecSchema.optional(),
  schedule: uiScheduleSchema.optional(),
  destinations: z.array(destinationInputSchema).max(10).optional(),
  departmentId: z.string().uuid().nullable().optional(),
}).strict();

const runWorkflowRequestSchema = z.object({
  overrideText: z.string().trim().max(4000).optional(),
}).strict();

const updateWorkflowScheduleSchema = z.object({
  scheduleEnabled: z.boolean(),
}).strict();

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

const DAY_CODE_BY_VALUE: Record<z.infer<typeof dayOfWeekSchema>, 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'> = {
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
  sunday: 'SU',
};

const parseTime = (value: string): { hour: number; minute: number } => {
  const [hour, minute] = value.split(':').map((part) => Number(part));
  return { hour, minute };
};

const toScheduleConfig = (input: z.infer<typeof uiScheduleSchema>) => {
  if (input.frequency === 'hourly') {
    return {
      type: 'hourly' as const,
      timezone: input.timezone,
      intervalHours: input.intervalHours,
      minute: input.minute ?? 0,
    };
  }
  if (input.frequency === 'daily') {
    return { type: 'daily' as const, timezone: input.timezone, time: parseTime(input.time) };
  }
  if (input.frequency === 'weekly') {
    return {
      type: 'weekly' as const,
      timezone: input.timezone,
      time: parseTime(input.time),
      daysOfWeek: [DAY_CODE_BY_VALUE[input.dayOfWeek]],
    };
  }
  if (input.frequency === 'monthly') {
    return {
      type: 'monthly' as const,
      timezone: input.timezone,
      time: parseTime(input.time),
      dayOfMonth: input.dayOfMonth,
    };
  }

  return {
    type: 'one_time' as const,
    timezone: input.timezone,
    runAt: zonedDateTimeToUtc({
      year: Number(input.runDate.slice(0, 4)),
      month: Number(input.runDate.slice(5, 7)),
      day: Number(input.runDate.slice(8, 10)),
      hour: parseTime(input.time).hour,
      minute: parseTime(input.time).minute,
      timeZone: input.timezone,
    }).toISOString(),
  };
};

const toOutputConfig = (destinations: z.infer<typeof destinationInputSchema>[]) => {
  const sourceDestinations = destinations.length > 0
    ? destinations
    : [{ kind: 'desktop_inbox', label: 'Desktop inbox' } as const];

  const normalizedDestinations = sourceDestinations.map((destination) => {
    if (destination.kind === 'desktop_inbox') {
      return {
        id: 'desktop_inbox',
        kind: 'desktop_inbox' as const,
        label: destination.label || 'Desktop inbox',
      };
    }
    if (destination.kind === 'desktop_thread') {
      return {
        id: 'desktop_thread',
        kind: 'desktop_thread' as const,
        label: destination.label || 'Desktop thread',
        threadId: destination.value || destination.label || 'desktop-thread',
      };
    }
    return {
      id: 'lark_chat',
      kind: 'lark_chat' as const,
      label: destination.label || 'Lark chat',
      chatId: destination.value || destination.label || 'lark-chat',
    };
  });

  return {
    version: 'v1' as const,
    destinations: normalizedDestinations,
    defaultDestinationIds: normalizedDestinations.map((destination) => destination.id),
  };
};

class DesktopWorkflowsController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      throw new HttpException(401, 'Member session required');
    }
    return session;
  }

  private async createDraftResponse(req: Request, res: Response): Promise<Response> {
    const session = this.session(req);
    const parsed = createDraftRequestSchema.parse(req.body ?? {});
    const result = await desktopWorkflowsService.createDraft(session, {
      name: parsed.name?.trim() || null,
      departmentId: parsed.departmentId ?? null,
    });
    return res.status(201).json(ApiResponse.success(result, 'Workflow draft created'));
  }

  createDraft = async (req: Request, res: Response): Promise<Response> => {
    return this.createDraftResponse(req, res);
  };

  list = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const result = await desktopWorkflowsService.list(session);
    return res.json(ApiResponse.success(result, 'Workflows listed'));
  };

  get = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const workflowId = z.string().uuid().parse(req.params.workflowId);
    const result = await desktopWorkflowsService.get(session, workflowId);
    return res.json(ApiResponse.success(result, 'Workflow loaded'));
  };

  author = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const workflowId = z.string().uuid().parse(req.params.workflowId);
    const parsed = workflowAuthorMessageSchema.parse(req.body ?? {});
    const result = await desktopWorkflowsService.author(session, workflowId, parsed.message, parsed.attachedFiles);
    return res.json(ApiResponse.success(result, 'Workflow updated'));
  };

  update = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const workflowId = z.string().uuid().parse(req.params.workflowId);
    const parsed = updateWorkflowRequestSchema.parse(req.body ?? {});
    const result = await desktopWorkflowsService.update(session, workflowId, {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.userIntent !== undefined ? { userIntent: parsed.userIntent } : {}),
      ...(parsed.aiDraft !== undefined ? { aiDraft: parsed.aiDraft } : {}),
      ...(parsed.workflowSpec !== undefined ? { workflowSpec: parsed.workflowSpec } : {}),
      ...(parsed.schedule !== undefined ? { schedule: toScheduleConfig(parsed.schedule) } : {}),
      ...(parsed.destinations !== undefined ? { outputConfig: toOutputConfig(parsed.destinations) } : {}),
      ...(parsed.departmentId !== undefined ? { departmentId: parsed.departmentId } : {}),
    });
    return res.json(ApiResponse.success(result, 'Workflow updated'));
  };

  compile = async (req: Request, res: Response): Promise<Response> => {
    if (req.path === '/drafts' || req.path === '/new-draft' || req.originalUrl.endsWith('/drafts') || req.originalUrl.endsWith('/new-draft')) {
      return this.createDraftResponse(req, res);
    }
    const session = this.session(req);
    const parsed = compileWorkflowRequestSchema.parse(req.body ?? {});

    const result = await desktopWorkflowsService.compile(session, {
      name: parsed.name,
      userIntent: parsed.userIntent,
      schedule: toScheduleConfig(parsed.schedule),
      outputConfig: toOutputConfig(parsed.destinations),
      attachedFiles: parsed.attachedFiles,
    });

    return res.json(ApiResponse.success(result, 'Workflow compiled'));
  };

  publish = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const parsed = publishWorkflowRequestSchema.parse(req.body ?? {});

    const result = await desktopWorkflowsService.publish(session, {
      workflowId: parsed.workflowId ?? null,
      name: parsed.name,
      userIntent: parsed.userIntent,
      aiDraft: parsed.aiDraft ?? null,
      schedule: toScheduleConfig(parsed.schedule),
      scheduleEnabled: parsed.scheduleEnabled,
      outputConfig: toOutputConfig(parsed.destinations),
      workflowSpec: parsed.workflowSpec,
      compiledPrompt: parsed.compiledPrompt,
      capabilitySummary: parsed.capabilitySummary,
      departmentId: parsed.departmentId ?? null,
    });

    return res.status(201).json(ApiResponse.success(result, 'Workflow published'));
  };

  runNow = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const workflowId = z.string().uuid().parse(req.params.workflowId);
    const { overrideText } = runWorkflowRequestSchema.parse(req.body ?? {});
    const result = await desktopWorkflowsService.runNow(session, workflowId, overrideText);
    return res.json(ApiResponse.success(result, 'Workflow run started'));
  };

  setScheduleState = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const workflowId = z.string().uuid().parse(req.params.workflowId);
    const { scheduleEnabled } = updateWorkflowScheduleSchema.parse(req.body ?? {});
    const result = await desktopWorkflowsService.setScheduleState(session, workflowId, scheduleEnabled);
    return res.json(ApiResponse.success(result, 'Workflow schedule updated'));
  };

  archive = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const workflowId = z.string().uuid().parse(req.params.workflowId);
    await desktopWorkflowsService.archive(session, workflowId);
    return res.status(204).send();
  };
}

export const desktopWorkflowsController = new DesktopWorkflowsController();
