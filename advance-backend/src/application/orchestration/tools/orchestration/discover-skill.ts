/**
 * discover_skill — meta-tool that loads domain expertise and tool schemas.
 *
 * The LLM calls this BEFORE using call_tool for a domain it hasn't loaded yet.
 * Returns the skill's instructions (domain expertise) and tool descriptions/parameter
 * docs so the LLM knows exactly how to call them.
 */

import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { SkillRegistry } from '../../../skills/skill-registry';
import type { ToolRegistry } from '../tool-registry';

const inputSchema = z.object({
  query: z.string().describe('What domain or capability you need, e.g. "send email" or "zoho invoices"'),
});

export function createDiscoverSkillTool(
  skillRegistry: SkillRegistry,
  toolRegistry: ToolRegistry,
) {
  const availableSkills = skillRegistry.all().map(s => `${s.id} — ${s.description}`).join('\n  ');

  return dynamicTool({
    description:
      'Load domain expertise and tool schemas for a capability. Call this BEFORE using call_tool for a domain you haven\'t loaded yet.',
    inputSchema: inputSchema as never,
    execute: async (input: unknown): Promise<string> => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return `error: invalid discover_skill input — ${parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`;
      }

      const { query } = parsed.data;
      const skill = skillRegistry.discover(query);

      if (!skill) {
        return `No matching skill found for "${query}". Available skills:\n  ${availableSkills}\n\nTry a more specific query matching one of these domains.`;
      }

      // Build tool documentation for each tool in the skill
      const toolDocs: string[] = [];
      for (const toolId of skill.toolIds) {
        const tool = toolRegistry.byId(toolId as never);
        if (tool) {
          toolDocs.push(`### ${tool.id}\n${tool.description}\n${tool.parameterDocs}`);
        } else {
          toolDocs.push(`### ${toolId}\n(tool not registered in current runtime)`);
        }
      }

      return `[Skill loaded: ${skill.name}]\n\n## Domain Expertise\n${skill.instructions}\n\n## Available Tools\n\n${toolDocs.join('\n\n')}`;
    },
  });
}
