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
}).strict();

const publishWorkflowRequestSchema = compileWorkflowRequestSchema.extend({
  workflowId: z.string().uuid().nullable().optional(),
  compiledPrompt: z.string().trim().min(1).max(50000),
  workflowSpec: scheduledWorkflowSpecSchema,
  capabilitySummary: scheduledWorkflowCapabilitySummarySchema.optional(),
  departmentId: z.string().uuid().nullable().optional(),
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

  list = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const result = await desktopWorkflowsService.list(session);
    return res.json(ApiResponse.success(result, 'Workflows listed'));
  };

  compile = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const parsed = compileWorkflowRequestSchema.parse(req.body ?? {});

    const result = await desktopWorkflowsService.compile(session, {
      name: parsed.name,
      userIntent: parsed.userIntent,
      schedule: toScheduleConfig(parsed.schedule),
      outputConfig: toOutputConfig(parsed.destinations),
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
      schedule: toScheduleConfig(parsed.schedule),
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
    const result = await desktopWorkflowsService.runNow(session, workflowId);
    return res.json(ApiResponse.success(result, 'Workflow run started'));
  };

  archive = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const workflowId = z.string().uuid().parse(req.params.workflowId);
    await desktopWorkflowsService.archive(session, workflowId);
    return res.status(204).send();
  };
}

export const desktopWorkflowsController = new DesktopWorkflowsController();
