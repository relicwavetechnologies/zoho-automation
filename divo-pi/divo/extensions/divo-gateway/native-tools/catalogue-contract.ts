/**
 * Reviewable, process-start definition for one permanent Divo Pi tool.
 *
 * These fields are the agent-facing half of a capability. They do not grant
 * access and carry no provider implementation or credential. Every execute
 * call still crosses the backend's governed `tools.invoke` boundary.
 */
export interface NativeToolSpec {
	readonly toolId: string;
	readonly name: string;
	readonly family: string;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet: string;
	readonly promptGuidelines: readonly string[];
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly executionMode: "parallel" | "sequential";
}
