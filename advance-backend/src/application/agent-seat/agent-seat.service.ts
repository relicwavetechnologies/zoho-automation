import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '../../generated/prisma';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { GatewayDispatcher } from '../gateway/gateway-dispatcher';
import type {
  GatewayMemberContext,
  GatewayRequest,
  GatewayResponse,
} from '../gateway/gateway.types';
import {
  AGENT_SEAT_SESSION_VERSION,
  appendHistory,
  defaultSessionPath,
  loadAgentSeatSession,
  saveAgentSeatSession,
  type AgentSeatSession,
} from './agent-seat-session';
import {
  resolveHarnessOpenId,
  resolveHarnessTenantKey,
} from './harness-identity';

export interface AgentSeatServiceDeps {
  readonly prisma: Pick<PrismaClient, 'channelIdentity'>;
  readonly channelIdentityRepo: Pick<ChannelIdentityRepoPort, 'resolveByLarkOpenId'>;
  readonly gatewayDispatcher: GatewayDispatcher;
  readonly sessionPath?: string;
  readonly now?: () => Date;
}

export interface AgentSeatInitInput {
  readonly userSelector: string;
  readonly departmentId?: string;
  /** Lark chat id for export delivery and runtime chat context (per-tester config). */
  readonly deliveryChatId: string;
}

export class AgentSeatService {
  constructor(private readonly deps: AgentSeatServiceDeps) {}

  async init(input: AgentSeatInitInput): Promise<AgentSeatSession> {
    const userOpenId = await resolveHarnessOpenId(this.deps.prisma, input.userSelector);
    const identityResult = await this.deps.channelIdentityRepo.resolveByLarkOpenId(userOpenId);
    if (!identityResult.ok || !identityResult.value) {
      throw new Error(`Identity not found for openId=${userOpenId}`);
    }
    const identity = identityResult.value;
    const tenantKey = await resolveHarnessTenantKey(
      this.deps.prisma,
      identity.companyId,
      userOpenId,
    );
    const departmentId = input.departmentId ?? identity.activeDepartmentId;
    const sessionId = randomUUID();
    const now = this.deps.now?.() ?? new Date();
    const session: AgentSeatSession = {
      version: AGENT_SEAT_SESSION_VERSION,
      sessionId,
      createdAt: now.toISOString(),
      userSelector: input.userSelector.trim(),
      userId: identity.userId,
      companyId: identity.companyId,
      ...(departmentId ? { departmentId } : {}),
      larkOpenId: userOpenId,
      email: identity.email ?? null,
      displayName: identity.displayName ?? null,
      aiRole: identity.aiRole,
      larkTenantKey: tenantKey,
      chatId: input.deliveryChatId,
      runtimeRunId: `agent-seat-run-${sessionId}`,
      runtimeThreadId: `agent-seat-${sessionId}`,
      turn: 0,
      traceId: `agent-seat-trace-${sessionId}`,
      history: [],
      notes: [],
    };
    await saveAgentSeatSession(session, this.sessionPath());
    return session;
  }

  async loadSession(): Promise<AgentSeatSession> {
    return loadAgentSeatSession(this.sessionPath());
  }

  whoami(session: AgentSeatSession): Record<string, unknown> {
    return {
      userSelector: session.userSelector,
      displayName: session.displayName,
      email: session.email,
      larkOpenId: session.larkOpenId,
      companyId: session.companyId,
      userId: session.userId,
      aiRole: session.aiRole,
      departmentId: session.departmentId ?? null,
      chatId: session.chatId,
      runtimeRunId: session.runtimeRunId,
      runtimeThreadId: session.runtimeThreadId,
      turn: session.turn,
      traceId: session.traceId,
      sessionId: session.sessionId,
    };
  }

  async bootstrap(session: AgentSeatSession): Promise<GatewayResponse> {
    const member = this.memberFromSession(session);
    const departmentId = session.departmentId;
    const [capabilities, routers] = await Promise.all([
      this.dispatch(member, { op: 'capabilities.get', ...(departmentId ? { departmentId } : {}) }),
      this.dispatch(member, { op: 'skills.list', ...(departmentId ? { departmentId } : {}) }),
    ]);
    return {
      ok: true,
      status: 'success',
      data: {
        capabilities: capabilities.ok ? capabilities.data : capabilities,
        routers: routers.ok ? routers.data : routers,
      },
    };
  }

  async getSkill(session: AgentSeatSession, slugOrId: string): Promise<GatewayResponse> {
    const skillId = await this.resolveSkillId(session, slugOrId);
    return this.dispatch(this.memberFromSession(session), {
      op: 'skills.get',
      ...(session.departmentId ? { departmentId: session.departmentId } : {}),
      payload: { skillId },
    });
  }

  async searchSkills(session: AgentSeatSession, query: string, limit = 3): Promise<GatewayResponse> {
    return this.dispatch(this.memberFromSession(session), {
      op: 'skills.search',
      ...(session.departmentId ? { departmentId: session.departmentId } : {}),
      payload: { query, limit },
    });
  }

  async invoke(
    session: AgentSeatSession,
    toolId: string,
    args: Record<string, unknown>,
  ): Promise<{ session: AgentSeatSession; response: GatewayResponse }> {
    const member = this.memberFromSession(session);
    const request: GatewayRequest = {
      op: 'tools.invoke',
      ...(session.departmentId ? { departmentId: session.departmentId } : {}),
      payload: { toolId, args },
      execution: this.executionContext(session),
    };
    const response = await this.dispatch(member, request);
    const updated = appendHistory(session, {
      kind: 'invoke',
      toolId,
      request: { toolId, args },
      response,
    });
    await saveAgentSeatSession(updated, this.sessionPath());
    return { session: updated, response };
  }

  async gateway(
    session: AgentSeatSession,
    request: GatewayRequest,
  ): Promise<{ session: AgentSeatSession; response: GatewayResponse }> {
    const response = await this.dispatch(this.memberFromSession(session), {
      ...request,
      ...(request.departmentId === undefined && session.departmentId
        ? { departmentId: session.departmentId }
        : {}),
      execution: request.execution ?? this.executionContext(session),
    });
    const updated = appendHistory(session, {
      kind: 'gateway',
      op: request.op,
      request,
      response,
    });
    await saveAgentSeatSession(updated, this.sessionPath());
    return { session: updated, response };
  }

  async beginTurn(session: AgentSeatSession): Promise<AgentSeatSession> {
    const updated: AgentSeatSession = {
      ...session,
      turn: session.turn + 1,
      traceId: `agent-seat-trace-${session.sessionId}-t${session.turn + 1}-${Date.now()}`,
    };
    await saveAgentSeatSession(updated, this.sessionPath());
    return updated;
  }

  async addNote(session: AgentSeatSession, text: string): Promise<AgentSeatSession> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Note text is required');
    const updated = appendHistory(
      {
        ...session,
        notes: [...session.notes, trimmed],
      },
      { kind: 'note', note: trimmed },
    );
    await saveAgentSeatSession(updated, this.sessionPath());
    return updated;
  }

  state(session: AgentSeatSession): Record<string, unknown> {
    const lastInvoke = [...session.history].reverse().find(entry => entry.kind === 'invoke');
    return {
      ...this.whoami(session),
      notes: session.notes,
      historyCount: session.history.length,
      lastInvoke: lastInvoke ?? null,
      hint: 'Run bootstrap and load skills before invoking tools.',
    };
  }

  async listScenarios(scenariosRoot: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(scenariosRoot, { withFileTypes: true });
      return entries
        .filter(entry => entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')))
        .map(entry => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  async readScenario(scenariosRoot: string, name: string): Promise<string> {
    const fileName = name.endsWith('.yaml') || name.endsWith('.yml') ? name : `${name}.yaml`;
    return readFile(join(scenariosRoot, fileName), 'utf8');
  }

  private sessionPath(): string {
    return this.deps.sessionPath ?? defaultSessionPath();
  }

  private memberFromSession(session: AgentSeatSession): GatewayMemberContext {
    return {
      companyId: session.companyId,
      userId: session.userId,
      aiRole: session.aiRole,
      channel: 'lark',
      email: session.email,
      larkOpenId: session.larkOpenId,
      larkTenantKey: session.larkTenantKey,
      runtimeChatId: session.chatId,
      runtimeRunId: session.runtimeRunId,
      runtimeThreadId: session.runtimeThreadId,
      sessionId: `agent-seat-${session.sessionId}`,
    };
  }

  private executionContext(session: AgentSeatSession) {
    return {
      version: 1 as const,
      threadId: session.runtimeThreadId,
      runId: session.runtimeRunId,
      actionId: `agent-seat-t${session.turn}-${session.history.length + 1}`,
    };
  }

  private dispatch(
    member: GatewayMemberContext,
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    return this.deps.gatewayDispatcher.dispatch(request, member);
  }

  private async resolveSkillId(session: AgentSeatSession, slugOrId: string): Promise<string> {
    const normalized = slugOrId.trim();
    if (!normalized) throw new Error('Skill slug or id is required');
    const bootstrap = await this.bootstrap(session);
    if (!bootstrap.ok) throw new Error('Could not load capabilities to resolve skill slug');
    const data = bootstrap.data as {
      capabilities?: { skills?: Array<{ id: string; slug: string }> };
      routers?: { skills?: Array<{ id: string; slug: string }> };
    };
    const skills = [
      ...(data.capabilities?.skills ?? []),
      ...(data.routers?.skills ?? []),
    ];
    const exactId = skills.find(skill => skill.id === normalized);
    if (exactId) return exactId.id;
    const bySlug = skills.find(skill => skill.slug === normalized);
    if (bySlug) return bySlug.id;
    const search = await this.searchSkills(session, normalized, 5);
    if (search.ok) {
      const results = (search.data as { skills?: Array<{ id: string; slug: string }> }).skills ?? [];
      const matched = results.find(skill => skill.slug === normalized || skill.id === normalized);
      if (matched) return matched.id;
      if (results.length === 1) return results[0]!.id;
    }
    throw new Error(`Could not resolve skill "${normalized}" for this user`);
  }
}
