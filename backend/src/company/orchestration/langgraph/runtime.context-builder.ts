import { departmentService } from '../../departments/department.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { runtimeConversationRepository } from './runtime-conversation.repository';
import type { RuntimeChannelAdapter } from './adapters/channel.adapter';
import { desktopRuntimeAdapter } from './adapters/desktop.adapter';
import { larkRuntimeAdapter } from './adapters/lark.adapter';
import type {
  RuntimeActor,
  RuntimeChannel,
  RuntimeConversationRefs,
  RuntimeModelMessage,
  RuntimePermissions,
} from './runtime.types';

const BASE_SYSTEM_PROMPT = [
  'You are the LangGraph runtime core for a tool-using assistant.',
  'Keep shared runtime behavior channel-agnostic and route presentation concerns through adapters.',
  'Only describe tool results that were actually persisted or returned.',
  'Treat stored approvals as first-class runtime state rather than conversational suggestions.',
].join('\n');

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

const getAdapter = (channel: RuntimeChannel): RuntimeChannelAdapter =>
  channel === 'desktop' ? desktopRuntimeAdapter : larkRuntimeAdapter;

const buildSystemPrompt = (input: {
  departmentName?: string;
  departmentRoleSlug?: string;
  departmentPrompt?: string;
  skillsMarkdown?: string;
  dateScope?: string;
  refs: RuntimeConversationRefs;
  conversationKey: string;
  channelInstructions: string;
}) => {
  const parts = [BASE_SYSTEM_PROMPT, input.channelInstructions];

  if (input.departmentName) {
    parts.push(`Active department: ${input.departmentName}.`);
  }
  if (input.departmentRoleSlug) {
    parts.push(`Requester department role: ${input.departmentRoleSlug}.`);
  }
  if (input.departmentPrompt?.trim()) {
    parts.push('Department instructions:', input.departmentPrompt.trim());
  }
  if (input.skillsMarkdown?.trim()) {
    parts.push('Skills fallback context:', input.skillsMarkdown.trim());
  }
  if (input.dateScope) {
    parts.push(`Inferred date scope: ${input.dateScope}.`);
  }

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
  if (refLines.length > 0) {
    parts.push('Conversation refs:', ...refLines);
  }

  parts.push(`Conversation key: ${input.conversationKey}.`);
  return parts.join('\n');
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

    const adapter = getAdapter(input.channel);
    const channelInstructions = input.channel === 'desktop'
      ? 'Desktop channel: rich traces and coding/workspace affordances may be available through the adapter.'
      : 'Lark channel: keep status concise, avoid coding/workspace actions, and assume in-place status updates.';
    const refs = readConversationRefs(conversation.refsJson);
    const dateScope = inferRuntimeDateScope(input.incomingText);
    const systemPrompt = buildSystemPrompt({
      departmentName,
      departmentRoleSlug,
      departmentPrompt,
      skillsMarkdown,
      dateScope,
      refs,
      conversationKey: input.conversationKey,
      channelInstructions,
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
        blockedToolIds: adapter.getBlockedToolIds(),
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

