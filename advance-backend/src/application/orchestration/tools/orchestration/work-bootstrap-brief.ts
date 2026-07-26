import type { WorkBootstrap } from '../../../gateway/work-bootstrap.service';

/**
 * A native schema large enough that spending the tokens costs more than the
 * describe round-trip it saves. Truncating one is not an option — a partial
 * JSON schema reads as complete and teaches the model wrong field names — so
 * an oversized contract is dropped and named instead.
 */
const MAX_CONTRACT_SCHEMA_CHARS = 4_000;

/**
 * Advisories whose payload this brief does not carry.
 *
 * `contracts_loaded` promises tool contracts "loaded below" and forbids
 * `tools.list`. Neither survives the trip: the brief omits `bootstrap.tools`
 * because the engine already hands the model its tool schemas through the SDK
 * definitions and discover_skill's own tool section, and `tools.list` is a
 * gateway op no backend-hosted channel can call. Passed through verbatim it is
 * an instruction pointing at absent content — precisely the failure mode the
 * bootstrap is meant to end.
 */
const ADVISORIES_WITHOUT_PAYLOAD_HERE = new Set(['contracts_loaded']);

/**
 * Advisory text written for the desktop sidecar names gateway ops the engine
 * cannot reach. Same instruction, minus the dead reference.
 */
const ENGINE_ADVISORY_TEXT: Readonly<Record<string, string>> = {
  connections_loaded:
    'The accounts this work needs are listed below. Reuse one of those exact connectionId values; do not try to rediscover accounts.',
};

/**
 * Renders run bootstrap as text for a model that reads prose rather than JSON.
 *
 * The desktop sidecar consumes the structured bootstrap directly. Backend
 * channels put it in the prompt instead, so the same facts have to survive the
 * change of medium: which accounts exist, their exact IDs, and the standing
 * instruction not to invent one.
 *
 * Scopes are deliberately omitted. They can run to forty entries per account,
 * the model cannot act on them, and the connection layer re-checks them on
 * every call anyway.
 */
export function renderWorkBootstrapBrief(bootstrap: WorkBootstrap): string {
  // Contracts are rendered before the instructions are chosen, because whether
  // "do not describe again" is honest depends on what actually survived the
  // size cap. Deciding first let a bootstrap whose every schema was dropped
  // still forbid describing them.
  const renderable: string[] = [];
  const oversized: string[] = [];
  for (const contract of bootstrap.nativeContracts) {
    const schema = JSON.stringify(contract.inputSchema);
    const label = `${String(contract.toolId)} · ${String(contract.nativeTool)}`;
    if (schema.length > MAX_CONTRACT_SCHEMA_CHARS) {
      oversized.push(label);
      continue;
    }
    renderable.push([
      `### ${label}`,
      ...(contract.description ? [String(contract.description)] : []),
      `Input schema: ${schema}`,
    ].join('\n'));
  }

  const carriesNoPayload = (code: string): boolean =>
    ADVISORIES_WITHOUT_PAYLOAD_HERE.has(code)
    || (code === 'native_contracts_loaded' && renderable.length === 0)
    || (code === 'connections_loaded' && bootstrap.connections.length === 0);

  const sections: string[] = [];
  const instructions = bootstrap.advisories
    .filter(advisory => advisory.level === 'required')
    .filter(advisory => !carriesNoPayload(advisory.code))
    .map(advisory => `- ${ENGINE_ADVISORY_TEXT[advisory.code] ?? advisory.instruction}`);
  if (instructions.length > 0) {
    sections.push(['## Operating instructions for this work', ...instructions].join('\n'));
  }

  if (bootstrap.connections.length > 0) {
    const rows = bootstrap.connections.map(connection => {
      const account = connection.accountEmail ?? connection.accountName ?? connection.label;
      const owner = connection.ownerType === 'company' ? 'company-owned' : 'user-owned';
      return `- ${String(connection.provider)} · ${String(account)} · access ${String(connection.access)} · ${owner} · connectionId ${String(connection.connectionId)}`;
    });
    sections.push([
      '## Connected accounts available to this member',
      'Pass one of these exact connectionId values. Never invent, guess, or reformat one.',
      ...rows,
    ].join('\n'));
  }

  if (renderable.length > 0) {
    sections.push(['## Native operation contracts already loaded', ...renderable].join('\n\n'));
  }
  if (oversized.length > 0) {
    sections.push(
      `## Native contracts too large to preload\nDescribe these only if the work actually needs them: ${oversized.join(', ')}`,
    );
  }

  return sections.join('\n\n');
}
