#!/usr/bin/env tsx
import 'dotenv/config';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadAndValidateEnv } from '../src/config/env';
import { AgentSeatService } from '../src/application/agent-seat/agent-seat.service';
import {
  buildAgentSeatContainer,
  shutdownAgentSeatContainer,
} from '../src/application/agent-seat/agent-seat-container';
import {
  AGENT_SEAT_DELIVERY_CHAT_ID_ENV,
  resolveAgentSeatDeliveryChatId,
} from '../src/application/agent-seat/agent-seat-delivery-chat';
import type { GatewayRequest } from '../src/application/gateway/gateway.types';

const startedAt = performance.now();

function logPhase(label: string): void {
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.error(`[agent-seat] ${label} (+${elapsedMs}ms)`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseJsonArg(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage(): void {
  console.log(`Usage:
  pnpm tsx scripts/agent-seat.ts init --user <email|name|open_id> [--chat-id <oc_...>] [--department <id>]
  pnpm tsx scripts/agent-seat.ts whoami
  pnpm tsx scripts/agent-seat.ts bootstrap
  pnpm tsx scripts/agent-seat.ts skill <slug-or-id>
  pnpm tsx scripts/agent-seat.ts skill search <query>
  pnpm tsx scripts/agent-seat.ts invoke <toolId> '<json-args>'
  pnpm tsx scripts/agent-seat.ts gateway '<json-request>'
  pnpm tsx scripts/agent-seat.ts turn begin
  pnpm tsx scripts/agent-seat.ts state
  pnpm tsx scripts/agent-seat.ts note "<finding>"
  pnpm tsx scripts/agent-seat.ts scenario list
  pnpm tsx scripts/agent-seat.ts scenario show <name>`);
}

async function createService(): Promise<AgentSeatService> {
  const env = loadAndValidateEnv(process.env);
  const container = await buildAgentSeatContainer(env);
  logPhase('container ready');
  return new AgentSeatService({
    prisma: container.prisma,
    channelIdentityRepo: container.channelIdentityRepo,
    gatewayDispatcher: container.gatewayDispatcher,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const service = await createService();
  const scenariosRoot = join(process.cwd(), 'scenarios', 'agent-seat');

  if (command === 'init') {
    let userSelector: string | undefined;
    let departmentId: string | undefined;
    let chatId: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const value = args[index]!;
      if (value === '--user') {
        userSelector = args[index + 1];
        index += 1;
        continue;
      }
      if (value === '--department') {
        departmentId = args[index + 1];
        index += 1;
        continue;
      }
      if (value === '--chat-id') {
        chatId = args[index + 1];
        index += 1;
      }
    }
    if (!userSelector) {
      throw new Error('init requires --user <email|name|open_id>');
    }
    const deliveryChatId = resolveAgentSeatDeliveryChatId({
      cliChatId: chatId,
      envChatId: process.env[AGENT_SEAT_DELIVERY_CHAT_ID_ENV],
    });
    const session = await service.init({
      userSelector,
      deliveryChatId,
      ...(departmentId ? { departmentId } : {}),
    });
    printJson({ status: 'initialized', whoami: service.whoami(session) });
    return;
  }

  const session = await service.loadSession();

  if (command === 'whoami') {
    printJson(service.whoami(session));
    return;
  }

  if (command === 'bootstrap') {
    printJson(await service.bootstrap(session));
    return;
  }

  if (command === 'skill') {
    const subcommand = args[1];
    if (subcommand === 'search') {
      const query = args.slice(2).join(' ').trim();
      if (!query) throw new Error('skill search requires a query');
      printJson(await service.searchSkills(session, query));
      return;
    }
    const slug = args.slice(1).join(' ').trim();
    if (!slug) throw new Error('skill requires a slug or id');
    printJson(await service.getSkill(session, slug));
    return;
  }

  if (command === 'invoke') {
    const toolId = args[1];
    const rawArgs = args[2];
    if (!toolId || !rawArgs) {
      throw new Error("invoke requires <toolId> '<json-args>'");
    }
    const { response } = await service.invoke(session, toolId, parseJsonArg(rawArgs, 'args'));
    printJson(response);
    return;
  }

  if (command === 'gateway') {
    const raw = args[1];
    if (!raw) throw new Error("gateway requires '<json-request>'");
    const request = parseJsonArg(raw, 'request') as GatewayRequest;
    const { response } = await service.gateway(session, request);
    printJson(response);
    return;
  }

  if (command === 'turn') {
    if (args[1] !== 'begin') throw new Error('Only "turn begin" is supported');
    const updated = await service.beginTurn(session);
    printJson({ turn: updated.turn, traceId: updated.traceId });
    return;
  }

  if (command === 'state') {
    printJson(service.state(session));
    return;
  }

  if (command === 'note') {
    const text = args.slice(1).join(' ').trim();
    const updated = await service.addNote(session, text);
    printJson({ notes: updated.notes });
    return;
  }

  if (command === 'scenario') {
    if (args[1] === 'list') {
      printJson({ scenarios: await service.listScenarios(scenariosRoot) });
      return;
    }
    if (args[1] === 'show') {
      const name = args[2];
      if (!name) throw new Error('scenario show requires a scenario name');
      console.log(await service.readScenario(scenariosRoot, name));
      return;
    }
    throw new Error('scenario supports list or show');
  }

  throw new Error(`Unknown command: ${command}`);
}

main()
  .then(() => {
    logPhase('done');
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    // BullMQ queues opened during buildContainer hold their own Redis sockets;
    // disconnecting shared clients is not enough for Node to exit on its own.
    void shutdownAgentSeatContainer()
      .catch(() => undefined)
      .finally(() => {
        process.exit(process.exitCode ?? 0);
      });
  });
