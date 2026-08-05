import type { Tool } from './tool.contract';
import type { ToolId } from '../../shared/ids';
import type { PermissionResult } from '../permissions/permission.types';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  register<TArgs, TOut>(tool: Tool<TArgs, TOut>): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool "${tool.id}" is already registered.`);
    }
    this.tools.set(tool.id, tool as Tool<unknown, unknown>);
  }

  /** Return all tools the current runtime is allowed to use. */
  forRuntime(perm: PermissionResult): ReadonlyArray<Tool<unknown, unknown>> {
    return [...this.tools.values()].filter(t => perm.allowedToolIds.has(t.id));
  }

  byId(id: ToolId): Tool<unknown, unknown> | undefined {
    return this.tools.get(id);
  }

  all(): ReadonlyArray<Tool<unknown, unknown>> {
    return [...this.tools.values()];
  }

  ids(): ToolId[] {
    return [...this.tools.keys()] as ToolId[];
  }
}
