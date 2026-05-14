import { z } from 'zod';

const WEEKDAY_VALUES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

const timeWindowSchema = z.object({
  hour:   z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
}).strict();

const timezoneSchema = z.string().trim().min(1).max(100);

export const scheduleConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type:     z.literal('one_time'),
    timezone: timezoneSchema,
    runAt:    z.string(),
  }).strict(),
  z.object({
    type:          z.literal('hourly'),
    timezone:      timezoneSchema,
    intervalHours: z.number().int().min(1).max(24),
    minute:        z.number().int().min(0).max(59).default(0),
  }).strict(),
  z.object({
    type:     z.literal('daily'),
    timezone: timezoneSchema,
    time:     timeWindowSchema,
  }).strict(),
  z.object({
    type:       z.literal('weekly'),
    timezone:   timezoneSchema,
    daysOfWeek: z.array(z.enum(WEEKDAY_VALUES)).min(1).max(7),
    time:       timeWindowSchema,
  }).strict(),
  z.object({
    type:       z.literal('monthly'),
    timezone:   timezoneSchema,
    dayOfMonth: z.number().int().min(1).max(31),
    time:       timeWindowSchema,
  }).strict(),
]);

export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
