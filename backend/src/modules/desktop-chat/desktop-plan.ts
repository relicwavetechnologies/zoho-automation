import { randomUUID } from 'crypto';
import { z } from 'zod';

const PLAN_OWNER_AGENTS = [
  'supervisor',
  'zoho',
  'outreach',
  'search',
  'larkDoc',
  'workspace',
  'terminal',
] as const;

const PLAN_TASK_STATUS = ['pending', 'running', 'done', 'blocked', 'failed', 'skipped'] as const;
const PLAN_STATUS = ['running', 'completed', 'failed'] as const;

const plannerTaskDraftSchema = z.object({
  title: z.string().min(4).max(160),
  ownerAgent: z.enum(PLAN_OWNER_AGENTS),
});

export const plannerDraftSchema = z.object({
  goal: z.string().min(4).max(240),
  successCriteria: z.array(z.string().min(3).max(200)).min(1).max(4),
  tasks: z.array(plannerTaskDraftSchema).min(2).max(6),
});

export const executionPlanSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(4).max(240),
  successCriteria: z.array(z.string().min(3).max(200)).min(1).max(4),
  status: z.enum(PLAN_STATUS),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  tasks: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(4).max(160),
    ownerAgent: z.enum(PLAN_OWNER_AGENTS),
    status: z.enum(PLAN_TASK_STATUS),
    resultSummary: z.string().min(1).max(500).optional(),
  })).min(2).max(6),
});

export type PlannerDraft = z.infer<typeof plannerDraftSchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type ExecutionPlanTask = ExecutionPlan['tasks'][number];
export type ExecutionPlanOwner = ExecutionPlanTask['ownerAgent'];

export const buildDesktopPlannerPrompt = (input: {
  message: string;
  workspace?: { name: string; path: string } | null;
}): string => {
  const workspaceSection = input.workspace
    ? [
      'Local desktop workspace is available.',
      `Workspace name: ${input.workspace.name}`,
      `Workspace path: ${input.workspace.path}`,
      'The planner may use ownerAgent "workspace" for file tasks and "terminal" for command tasks when clearly needed.',
    ].join('\n')
    : 'No local workspace context is required unless the request explicitly implies it.';

  return [
    'Create a compact execution plan for this desktop chat request.',
    workspaceSection,
    'The plan will be shown live in the UI and used by the supervisor as orchestration state.',
    'Return JSON only.',
    'User request:',
    input.message,
  ].join('\n\n');
};

export const initializeExecutionPlan = (draft: PlannerDraft): ExecutionPlan => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    goal: draft.goal.trim(),
    successCriteria: draft.successCriteria.map((item) => item.trim()),
    status: 'running',
    createdAt: now,
    updatedAt: now,
    tasks: draft.tasks.map((task, index) => ({
      id: randomUUID(),
      title: task.title.trim(),
      ownerAgent: task.ownerAgent,
      status: index === 0 ? 'running' : 'pending',
    })),
  };
};

export const buildExecutionPlanContext = (plan: ExecutionPlan | null | undefined): string => {
  if (!plan) return '';
  const tasks = plan.tasks
    .map((task, index) => `${index + 1}. [${task.status}] (${task.ownerAgent}) ${task.title}`)
    .join('\n');
  const successCriteria = plan.successCriteria.map((item) => `- ${item}`).join('\n');
  return [
    '\n--- ACTIVE EXECUTION PLAN ---',
    `Goal: ${plan.goal}`,
    'Success criteria:',
    successCriteria,
    'Current ordered tasks:',
    tasks,
    'Rules:',
    '- Stay aligned to this plan unless the user changes the request.',
    '- Do not claim unfinished tasks are done.',
    '- Prefer progressing the current running task before jumping ahead.',
    '- If you answer without more tool work, make sure the answer satisfies the remaining success criteria.',
    '--- END ACTIVE EXECUTION PLAN ---\n',
  ].join('\n');
};

export const formatExecutionPlanForLog = (plan: ExecutionPlan): string => {
  const successCriteria = plan.successCriteria.map((item) => `- ${item}`).join('\n');
  const tasks = plan.tasks
    .map((task, index) => `${index + 1}. [${task.ownerAgent}] ${task.title}`)
    .join('\n');

  return [
    `Goal: ${plan.goal}`,
    '',
    'Success criteria:',
    successCriteria,
    '',
    'Ordered tasks:',
    tasks,
  ].join('\n');
};

const touchPlan = (plan: ExecutionPlan, tasks: ExecutionPlan['tasks'], status: ExecutionPlan['status']): ExecutionPlan => ({
  ...plan,
  status,
  updatedAt: new Date().toISOString(),
  tasks,
});

const getCurrentTaskIndex = (tasks: ExecutionPlan['tasks']): number =>
  tasks.findIndex((task) => task.status === 'running');

const getFirstPendingIndex = (tasks: ExecutionPlan['tasks']): number =>
  tasks.findIndex((task) => task.status === 'pending');

const startNextPendingTask = (tasks: ExecutionPlan['tasks']): boolean => {
  const nextIndex = getFirstPendingIndex(tasks);
  if (nextIndex === -1) return false;
  tasks[nextIndex].status = 'running';
  return true;
};

const hasRemainingOpenTasks = (tasks: ExecutionPlan['tasks']): boolean =>
  tasks.some((task) => task.status === 'pending' || task.status === 'running' || task.status === 'blocked');

const hasRemainingOpenNonSupervisorTasks = (tasks: ExecutionPlan['tasks']): boolean =>
  tasks.some(
    (task) =>
      task.ownerAgent !== 'supervisor'
      && (task.status === 'pending' || task.status === 'running' || task.status === 'blocked'),
  );

export const resolvePlanOwnerFromToolName = (toolName?: string | null): ExecutionPlanOwner | null => {
  if (!toolName) return null;
  const normalized = toolName.trim().toLowerCase();

  if (normalized === 'zoho-agent' || normalized === 'read-zoho-records' || normalized === 'zoho-read' || normalized === 'zoho-search') {
    return 'zoho';
  }
  if (normalized === 'outreach-agent' || normalized === 'read-outreach-publishers') {
    return 'outreach';
  }
  if (normalized === 'search-agent' || normalized === 'search-read' || normalized === 'search-documents') {
    return 'search';
  }
  if (normalized === 'lark-doc-agent' || normalized === 'create-lark-doc' || normalized === 'edit-lark-doc') {
    return 'larkDoc';
  }
  return null;
};

export const resolvePlanOwnerFromActionKind = (
  actionKind: 'list_files' | 'read_file' | 'write_file' | 'mkdir' | 'delete_path' | 'run_command',
): ExecutionPlanOwner => (actionKind === 'run_command' ? 'terminal' : 'workspace');

export const updateExecutionPlanTask = (
  plan: ExecutionPlan,
  input: {
    ownerAgent: ExecutionPlanOwner;
    ok: boolean;
    resultSummary?: string;
  },
): ExecutionPlan => {
  if (plan.status !== 'running') return plan;

  const tasks = plan.tasks.map((task) => ({ ...task }));
  const currentIndex = getCurrentTaskIndex(tasks);
  if (currentIndex === -1) return plan;

  const currentTask = tasks[currentIndex];
  if (currentTask.ownerAgent !== input.ownerAgent) {
    return plan;
  }

  currentTask.status = input.ok ? 'done' : 'failed';
  if (input.resultSummary) {
    currentTask.resultSummary = input.resultSummary.slice(0, 500);
  }

  if (!input.ok) {
    if (startNextPendingTask(tasks)) {
      return touchPlan(plan, tasks, 'running');
    }
    return touchPlan(plan, tasks, 'failed');
  }

  if (startNextPendingTask(tasks)) {
    return touchPlan(plan, tasks, 'running');
  }

  return touchPlan(plan, tasks, 'completed');
};

export const advanceExecutionPlan = (
  plan: ExecutionPlan,
  resultSummary?: string,
): ExecutionPlan => {
  if (plan.status !== 'running') return plan;

  const tasks = plan.tasks.map((task) => ({ ...task }));
  const currentIndex = tasks.findIndex((task) => task.status === 'running');
  const targetIndex = currentIndex >= 0 ? currentIndex : tasks.findIndex((task) => task.status === 'pending');

  if (targetIndex === -1) {
    return touchPlan(plan, tasks, 'completed');
  }

  tasks[targetIndex].status = 'done';
  if (resultSummary) {
    tasks[targetIndex].resultSummary = resultSummary.slice(0, 500);
  }

  const nextIndex = tasks.findIndex((task) => task.status === 'pending');
  if (nextIndex >= 0) {
    tasks[nextIndex].status = 'running';
    return touchPlan(plan, tasks, 'running');
  }

  return touchPlan(plan, tasks, 'completed');
};

export const completeExecutionPlan = (
  plan: ExecutionPlan,
  finalSummary?: string,
): ExecutionPlan => {
  const tasks = plan.tasks.map((task) => ({ ...task }));
  const trimmedSummary = finalSummary?.trim();
  const currentIndex = getCurrentTaskIndex(tasks);

  if (trimmedSummary) {
    if (currentIndex >= 0 && tasks[currentIndex].ownerAgent === 'supervisor') {
      tasks[currentIndex].status = 'done';
      tasks[currentIndex].resultSummary = trimmedSummary.slice(0, 500);
    } else {
      const pendingIndex = getFirstPendingIndex(tasks);
      if (pendingIndex >= 0 && tasks[pendingIndex].ownerAgent === 'supervisor') {
        tasks[pendingIndex].status = 'done';
        tasks[pendingIndex].resultSummary = trimmedSummary.slice(0, 500);
      }
    }
  }

  if (tasks.some((task) => task.status === 'failed')) {
    return touchPlan(plan, tasks, 'failed');
  }

  if (!trimmedSummary && hasRemainingOpenNonSupervisorTasks(tasks)) {
    return touchPlan(plan, tasks, 'running');
  }

  if (hasRemainingOpenTasks(tasks)) {
    return touchPlan(plan, tasks, 'running');
  }

  return touchPlan(plan, tasks, 'completed');
};

export const failExecutionPlan = (
  plan: ExecutionPlan,
  reason?: string,
): ExecutionPlan => {
  const tasks = plan.tasks.map((task) => ({ ...task }));
  const current = tasks.find((task) => task.status === 'running');
  if (current) {
    current.status = 'failed';
    if (reason) current.resultSummary = reason.slice(0, 500);
  }
  return touchPlan(plan, tasks, 'failed');
};
