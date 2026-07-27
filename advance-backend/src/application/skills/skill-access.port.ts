/**
 * Resolves the explicit skill grants effective for one company member.
 *
 * Skill content and tool execution have separate policy gates: this port
 * controls which skills may be discovered, while PermissionService continues
 * to control which tools/actions may execute.
 */
export interface SkillAccessEnforcementPort {
  listGrantedSkillIds(
    companyId: string,
    userId: string,
    abortSignal?: AbortSignal,
  ): Promise<ReadonlySet<string>>;
}
