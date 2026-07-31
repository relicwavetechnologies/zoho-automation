export interface WorkBootstrap {
	version: 1;
	scope: "run";
	registryRevision: number;
	tools: Array<{
		id: string;
		family: string;
		description: string;
		allowedActions: string[];
		parameterDocs: string;
		argsSchema: unknown;
	}>;
	nativeContracts: Array<{
		toolId: string;
		nativeTool: string;
		description?: string;
		inputSchema: unknown;
	}>;
	connections: Array<{
		connectionId: string;
		provider: string;
		label: string;
		accountEmail: string | null;
		accountName: string | null;
		ownerType: string;
		access: string;
		scopes: string[];
	}>;
	advisories: Array<{
		code: string;
		level: "required" | "info";
		instruction: string;
		provider?: string;
	}>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reject malformed backend bootstrap entries rather than teaching the model an invented contract. */
export function parseWorkBootstrap(value: unknown): WorkBootstrap | undefined {
	const raw = record(value);
	if (!raw || raw.version !== 1 || raw.scope !== "run" || typeof raw.registryRevision !== "number") {
		return undefined;
	}
	const tools = Array.isArray(raw.tools) ? raw.tools.flatMap((value): WorkBootstrap["tools"] => {
		const tool = record(value);
		const id = string(tool?.id);
		const family = string(tool?.family);
		const description = string(tool?.description);
		const parameterDocs = string(tool?.parameterDocs);
		if (!tool || !id || !family || !description || !parameterDocs || !Array.isArray(tool.allowedActions)) return [];
		return [{
			id,
			family,
			description,
			parameterDocs,
			allowedActions: tool.allowedActions.filter((item): item is string => typeof item === "string"),
			argsSchema: tool.argsSchema,
		}];
	}) : [];
	const nativeContracts = Array.isArray(raw.nativeContracts)
		? raw.nativeContracts.flatMap((value): WorkBootstrap["nativeContracts"] => {
			const contract = record(value);
			const toolId = string(contract?.toolId);
			const nativeTool = string(contract?.nativeTool);
			if (!contract || !toolId || !nativeTool || !("inputSchema" in contract)) return [];
			const description = string(contract.description);
			return [{
				toolId,
				nativeTool,
				...(description ? { description } : {}),
				inputSchema: contract.inputSchema,
			}];
		})
		: [];
	const connections = Array.isArray(raw.connections) ? raw.connections.flatMap((value): WorkBootstrap["connections"] => {
		const connection = record(value);
		const connectionId = string(connection?.connectionId);
		const provider = string(connection?.provider);
		const label = string(connection?.label);
		const ownerType = string(connection?.ownerType);
		const access = string(connection?.access);
		if (!connection || !connectionId || !provider || !label || !ownerType || !access || !Array.isArray(connection.scopes)) return [];
		return [{
			connectionId,
			provider,
			label,
			accountEmail: string(connection.accountEmail) ?? null,
			accountName: string(connection.accountName) ?? null,
			ownerType,
			access,
			scopes: connection.scopes.filter((item): item is string => typeof item === "string"),
		}];
	}) : [];
	const advisories = Array.isArray(raw.advisories) ? raw.advisories.flatMap((value): WorkBootstrap["advisories"] => {
		const advisory = record(value);
		const code = string(advisory?.code);
		const instruction = string(advisory?.instruction);
		if (!advisory || !code || !instruction || (advisory.level !== "required" && advisory.level !== "info")) return [];
		const provider = string(advisory.provider);
		return [{
			code,
			level: advisory.level,
			instruction,
			...(provider ? { provider } : {}),
		}];
	}) : [];
	return {
		version: 1,
		scope: "run",
		registryRevision: raw.registryRevision,
		tools,
		nativeContracts,
		connections,
		advisories,
	};
}

export function formatWorkBootstrap(bootstrap: WorkBootstrap): string[] {
	const lines = ["Run bootstrap (already loaded; do not rediscover these items):"];
	for (const tool of bootstrap.tools) {
		lines.push(`- Tool ${tool.id} [${tool.allowedActions.join(", ") || "no allowed actions"}]`);
		lines.push(`  ${tool.description}`);
		lines.push(`  parameters: ${tool.parameterDocs}`);
		lines.push(`  args schema: ${JSON.stringify(tool.argsSchema)}`);
	}
	for (const contract of bootstrap.nativeContracts) {
		lines.push(`- Native contract ${contract.toolId}.${contract.nativeTool}`);
		if (contract.description) lines.push(`  ${contract.description}`);
		lines.push(`  input schema: ${JSON.stringify(contract.inputSchema)}`);
	}
	for (const connection of bootstrap.connections) {
		const account = connection.accountEmail ?? connection.accountName ?? connection.label;
		lines.push(`- Account ${connection.provider}: ${account} · connectionId=${connection.connectionId} · ${connection.access}`);
	}
	for (const advisory of bootstrap.advisories) {
		lines.push(`- ${advisory.level.toUpperCase()} ${advisory.code}: ${advisory.instruction}`);
	}
	return lines;
}
