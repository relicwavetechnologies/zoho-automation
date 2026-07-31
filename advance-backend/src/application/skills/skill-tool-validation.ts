import { CANONICAL_TOOL_IDS } from '../../domain/tools/tool-id';

const CANONICAL_SKILL_TOOL_IDS = new Set<string>(CANONICAL_TOOL_IDS);

export function unknownSkillToolIds(toolIds: readonly string[] | undefined): string[] {
  if (!toolIds) return [];
  return [...new Set(toolIds.filter((toolId) => !CANONICAL_SKILL_TOOL_IDS.has(toolId)))];
}
