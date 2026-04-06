import { departmentService } from '../../departments/department.service';
import { companyPromptProfileService } from '../../prompt-profiles/company-prompt-profile.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { buildSharedAgentSystemPromptWithCache } from '../prompting/shared-agent-prompt';
import { runtimeConversationRepository } from './runtime-conversation.repository';
import type {
  RuntimeActor,
  RuntimeChannel,
  RuntimeConversationRefs,
  RuntimeModelMessage,
  RuntimePermissions,
} from './runtime.types';

const LOCAL_TIME_ZONE = 'Asia/Kolkata';

const getLocalDateString = (offsetDays = 0): string => {
  const base = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')}`;
};

export const inferRuntimeDateScope = (message?: string): string | undefined => {
  const input = message?.trim();
  if (!input) return undefined;
  const explicit = input.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (explicit) return explicit[0];
  const lowered = input.toLowerCase();
  if (lowered.includes('tomorrow')) return getLocalDateString(1);
  if (lowered.includes('yesterday')) return getLocalDateString(-1);
  if (lowered.includes('today')) return getLocalDateString(0);
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const readConversationRefs = (value: unknown): RuntimeConversationRefs =>
  isRecord(value) ? value as RuntimeConversationRefs : {};

const messageContent = (input: {
  contentText: string | null;
  contentJson: unknown;
}): string | null => {
  const explicit = input.contentText?.trim();
  if (explicit) {
    return explicit;
  }

  if (!isRecord(input.contentJson)) {
    return null;
  }

  const content = asString(input.contentJson.content);
  return content ?? null;
};

const buildSystemPrompt = async (input: {
  companyId: string;
  departmentName?: string;
  departmentId?: string;
  departmentRoleSlug?: string;
  departmentPrompt?: string;
  skillsMarkdown?: string;
  dateScope?: string;
  refs: RuntimeConversationRefs;
  allowedToolIds: string[];
  allowedActionsByTool: Record<string, Array<'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'>>;
  conversationKey: string;
}): Promise<string> => {
  const refLines: string[] = [];
  if (input.refs.latestLarkTask) {
    refLines.push(`Latest Lark task: ${JSON.stringify(input.refs.latestLarkTask)}`);
  }
  if (input.refs.latestLarkDoc) {
    refLines.push(`Latest Lark doc: ${JSON.stringify(input.refs.latestLarkDoc)}`);
  }
  if (input.refs.latestLarkCalendarEvent) {
    refLines.push(`Latest Lark event: ${JSON.stringify(input.refs.latestLarkCalendarEvent)}`);
  }
  const companyPromptProfile = await companyPromptProfileService.resolveRuntimeProfile(input.companyId);
  const result = await buildSharedAgentSystemPromptWithCache({
    runtimeLabel: 'You are the LangGraph runtime core for a tool-using assistant.',
    conversationKey: input.conversationKey,
    allowedToolIds: input.allowedToolIds,
    allowedActionsByTool: input.allowedActionsByTool,
    companyPromptProfile,
    departmentId: input.departmentId,
    departmentName: input.departmentName,
    departmentRoleSlug: input.departmentRoleSlug,
    departmentSystemPrompt: input.departmentPrompt,
    departmentSkillsMarkdown: input.skillsMarkdown,
    dateScope: input.dateScope,
    conversationRefsContext: refLines.length > 0 ? ['Conversation refs:', ...refLines].join('\n') : null,
  });
  return result.prompt;
};

export type RuntimeContextBuildResult = {
  systemPrompt: string;
  modelMessages: RuntimeModelMessage[];
  permissions: RuntimePermissions;
  department: {
    departmentId?: string;
    departmentName?: string;
    departmentRoleSlug?: string;
    departmentPrompt?: string;
    skillsMarkdown?: string;
  };
  refs: RuntimeConversationRefs;
  dateScope?: string;
};

export class RuntimeContextBuilder {
  async build(input: {
    conversationId: string;
    companyId: string;
    channel: RuntimeChannel;
    conversationKey: string;
    actor: RuntimeActor;
    incomingText?: string;
  }): Promise<RuntimeContextBuildResult> {
    const [conversation, messages, fallbackAllowedToolIds] = await Promise.all([
      runtimeConversationRepository.getById(input.conversationId),
      runtimeConversationRepository.listMessages(input.conversationId, 20),
      toolPermissionService.getAllowedTools(input.companyId, input.actor.aiRole ?? 'MEMBER'),
    ]);

    if (!conversation) {
      throw new Error(`Runtime conversation ${input.conversationId} not found.`);
    }

    const linkedUserId = input.actor.linkedUserId ?? input.actor.userId;
    let departmentId = conversation.departmentId ?? undefined;
    let departmentName: string | undefined;
    let departmentRoleSlug: string | undefined;
    let departmentPrompt: string | undefined;
    let skillsMarkdown: string | undefined;
    let allowedToolIds = fallbackAllowedToolIds;
    let allowedActionsByTool: Record<string, Array<'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'>> = {};

    if (linkedUserId) {
      const departments = await departmentService.listUserDepartments(linkedUserId, input.companyId);
      const autoDepartment = departmentId
        ? departments.find((entry) => entry.id === departmentId) ?? null
        : departments.length === 1 ? departments[0] : null;

      const resolved = await departmentService.resolveRuntimeContext({
        userId: linkedUserId,
        companyId: input.companyId,
        departmentId: autoDepartment?.id,
        fallbackAllowedToolIds,
      });

      departmentId = resolved.departmentId;
      departmentName = resolved.departmentName;
      departmentRoleSlug = resolved.departmentRoleSlug;
      departmentPrompt = resolved.systemPrompt;
      skillsMarkdown = resolved.skillsMarkdown;
      allowedToolIds = resolved.allowedToolIds;
      allowedActionsByTool = resolved.allowedActionsByTool ?? {};
    }

    const refs = readConversationRefs(conversation.refsJson);
    const dateScope = inferRuntimeDateScope(input.incomingText);
    const systemPrompt = await buildSystemPrompt({
      companyId: input.companyId,
      departmentId,
      departmentName,
      departmentRoleSlug,
      departmentPrompt,
      skillsMarkdown,
      dateScope,
      refs,
      conversationKey: input.conversationKey,
      allowedToolIds,
      allowedActionsByTool,
    });

    const modelMessages: RuntimeModelMessage[] = [];
    for (const message of messages) {
      const content = messageContent({
        contentText: message.contentText,
        contentJson: message.contentJson,
      });
      if (!content) {
        continue;
      }

      if (message.role === 'system' || message.role === 'user' || message.role === 'assistant') {
        modelMessages.push({
          role: message.role,
          content,
        });
      }
    }

    return {
      systemPrompt,
      modelMessages,
      permissions: {
        allowedToolIds,
        allowedActionsByTool,
      },
      department: {
        departmentId,
        departmentName,
        departmentRoleSlug,
        departmentPrompt,
        skillsMarkdown,
      },
      refs,
      dateScope,
    };
  }
}

export const runtimeContextBuilder = new RuntimeContextBuilder();
