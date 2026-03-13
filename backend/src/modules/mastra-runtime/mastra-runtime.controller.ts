import { Request, Response } from 'express';
import { z } from 'zod';

import config from '../../config';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { mastraRuntimeService, MastraRuntimeService } from './mastra-runtime.service';

const generateRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.string().min(1),
      content: z.unknown(),
    }),
  ).min(1),
  requestContext: z.record(z.unknown()).optional(),
});

const matchesMastraApiKey = (headerValue: string | undefined): boolean => {
  if (!config.MASTRA_API_KEY) {
    return true;
  }

  const tokenHeader = headerValue?.trim() ?? '';
  if (tokenHeader.startsWith('Bearer ')) {
    return tokenHeader.slice('Bearer '.length).trim() === config.MASTRA_API_KEY;
  }
  return tokenHeader === config.MASTRA_API_KEY;
};

class MastraRuntimeController extends BaseController {
  constructor(private readonly service: MastraRuntimeService = mastraRuntimeService) {
    super();
  }

  generate = async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const keyHeader = typeof req.headers['x-mastra-api-key'] === 'string' ? req.headers['x-mastra-api-key'] : undefined;
    const hasAuth = matchesMastraApiKey(authHeader) || matchesMastraApiKey(keyHeader);
    if (!hasAuth) {
      throw new HttpException(401, 'Unauthorized Mastra runtime request');
    }

    const payload = generateRequestSchema.parse(req.body);
    const agentId = req.params.agentId;
    const requestId = (req as Request & { requestId?: string }).requestId;
    const response = await this.service.generate(agentId, payload, requestId);
    return res.json(response);
  };

  stream = async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const keyHeader = typeof req.headers['x-mastra-api-key'] === 'string' ? req.headers['x-mastra-api-key'] : undefined;
    const hasAuth = matchesMastraApiKey(authHeader) || matchesMastraApiKey(keyHeader);
    if (!hasAuth) {
      throw new HttpException(401, 'Unauthorized Mastra runtime request');
    }

    const payload = generateRequestSchema.parse(req.body);
    const agentId = req.params.agentId;
    const requestId = (req as Request & { requestId?: string }).requestId;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (type: string, data: any) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const streamResults = await this.service.stream(agentId, payload, requestId);

      // We handle the text stream and steps concurrently
      const textStream = streamResults.textStream;
      const stepStream = (streamResults as any).stepsStream;

      if (stepStream) {
        (async () => {
          for await (const step of stepStream) {
            sendEvent('step', step);
          }
        })();
      }

      for await (const chunk of textStream) {
        sendEvent('text', { delta: chunk });
      }

      sendEvent('done', { status: 'complete' });
    } catch (err) {
      sendEvent('error', { message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      res.end();
    }
  };

  listAgents = async (_req: Request, res: Response) =>
    res.json({
      agents: [
        { id: 'supervisorAgent', description: 'Odin AI supervisor that routes across web search, outreach, and Zoho specialists.' },
        { id: 'searchAgent', description: 'Odin web research specialist with exact-site page context extraction.' },
        { id: 'zohoAgent', description: 'Odin CRM specialist for grounded Zoho context.' },
      ],
    });
}

export const mastraRuntimeController = new MastraRuntimeController();
