import { z } from 'zod';

const querySchema = z.object({
  query: z.string().min(1),
});

export const WorkerContracts = {
  skills: {
    DISCOVER_CANDIDATES: querySchema,
    RETRIEVE_ARTIFACT: z.object({
      id: z.string().min(1),
    }),
    VERIFY_OUTPUT: z.object({
      artifactId: z.string().min(1),
      criteria: z.string().min(1).optional(),
    }),
  },
  repo: {
    DISCOVER_CANDIDATES: z.object({
      query: z.string().min(1),
      targetFileName: z.string().min(1).optional(),
    }),
    INSPECT_CANDIDATE: z.object({
      repoRef: z.string().min(1),
      targetFilePath: z.string().min(1).optional(),
      targetFileName: z.string().min(1).optional(),
      requireRoot: z.boolean().optional(),
    }),
    RETRIEVE_ARTIFACT: z.object({
      repoRef: z.string().min(1),
      filePath: z.string().min(1).optional(),
      targetFilePath: z.string().min(1).optional(),
      targetFileName: z.string().min(1).optional(),
      requireRoot: z.boolean().optional(),
    }),
    VERIFY_OUTPUT: z.object({
      artifactId: z.string().min(1),
      criteria: z.string().min(1).optional(),
    }),
  },
  search: {
    DISCOVER_CANDIDATES: querySchema,
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({
      artifactId: z.string().min(1).optional(),
      criteria: z.string().min(1).optional(),
    }).passthrough(),
  },
  webSearch: {
    DISCOVER_CANDIDATES: querySchema,
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({
      artifactId: z.string().min(1).optional(),
      criteria: z.string().min(1).optional(),
    }).passthrough(),
  },
  docSearch: {
    DISCOVER_CANDIDATES: querySchema,
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({
      artifactId: z.string().min(1).optional(),
      criteria: z.string().min(1).optional(),
    }).passthrough(),
  },
  coding: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  zoho: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  outreach: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  larkTask: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  larkBase: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  larkCalendar: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  larkMeeting: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  larkApproval: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
  larkDoc: {
    QUERY_REMOTE_SYSTEM: querySchema,
    VERIFY_OUTPUT: z.object({ criteria: z.string().min(1).optional() }).passthrough(),
  },
} as const;

export type WorkerContractsMap = typeof WorkerContracts;
