import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '../src/application/tools/tool.contract';
import { createAirtableMcpTools } from '../src/application/tools/families/airtable-mcp.tool';
import { createAitableTools } from '../src/application/tools/families/aitable.tool';
import { createCanvaDesignTool } from '../src/application/tools/families/canva-design.tool';
import { createGoogleWorkspaceMcpTools } from '../src/application/tools/families/google-workspace-mcp.tool';
import { createKnowledgeTool } from '../src/application/tools/families/knowledge.tool';
import { createLarkApprovalTool } from '../src/application/tools/families/lark-approval.tool';
import { createLarkBaseTool } from '../src/application/tools/families/lark-base.tool';
import { createLarkCalendarTool } from '../src/application/tools/families/lark-calendar.tool';
import { createLarkContactsTool } from '../src/application/tools/families/lark-contacts.tool';
import { createLarkDocTool } from '../src/application/tools/families/lark-doc.tool';
import { createLarkMeetingTool } from '../src/application/tools/families/lark-meeting.tool';
import { createLarkMessagingTool } from '../src/application/tools/families/lark-messaging.tool';
import { createLarkTaskTool } from '../src/application/tools/families/lark-task.tool';
import { createMailAutomationsTool } from '../src/application/tools/families/mail-automations.tool';
import { createMenhoodDataTool } from '../src/application/tools/families/menhood-data.tool';
import { createOmsSiteDataTool } from '../src/application/tools/families/oms-site-data.tool';
import { createScheduledWorkflowsTool } from '../src/application/tools/families/scheduled-workflows.tool';
import { createSemrushTool } from '../src/application/tools/families/semrush.tool';
import { createShopifyTools } from '../src/application/tools/families/shopify.tool';
import { createWebSearchTool } from '../src/application/tools/families/web-search.tool';
import { createZohoBooksTool } from '../src/application/tools/families/zoho-books.tool';
import { createZohoCrmTool } from '../src/application/tools/families/zoho-crm.tool';
import { serializeToolArgsSchema } from '../src/application/gateway/work-bootstrap.service';
import {
  CANONICAL_TOOL_IDS,
  typedToolNameFor,
} from '../src/domain/tools/tool-id';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const GENERATED_DIR = resolve(
  REPO_ROOT,
  'divo-pi/divo/extensions/divo-gateway/native-tools/generated',
);

type GeneratedSpec = {
  readonly toolId: string;
  readonly name: string;
  readonly family: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly executionMode: 'parallel' | 'sequential';
};

/**
 * Construct contracts only. Factory dependencies are never invoked while a
 * Tool object is created; protected provider work remains in execute().
 */
export function buildCanonicalToolContracts(): ReadonlyArray<Tool<unknown, unknown>> {
  const inert = {} as never;
  const tools: Tool<unknown, unknown>[] = [
    createLarkMessagingTool(inert),
    createLarkContactsTool(inert),
    createLarkTaskTool(inert),
    createLarkCalendarTool(inert),
    createLarkMeetingTool(inert),
    createLarkDocTool(inert),
    createLarkBaseTool(inert),
    createLarkApprovalTool(inert),
    ...createGoogleWorkspaceMcpTools(inert),
    createCanvaDesignTool(inert),
    ...createAirtableMcpTools(inert),
    ...createAitableTools(inert),
    createZohoCrmTool(inert),
    createZohoBooksTool(inert),
    ...createShopifyTools(inert),
    createWebSearchTool(inert),
    createKnowledgeTool(inert),
    createMailAutomationsTool({
      repo: inert,
      runtime: { pubsubConfigured: false, workersEnabled: false },
      resolveConnection: inert,
    }),
    createScheduledWorkflowsTool({ prisma: inert }),
    createSemrushTool(inert),
    createOmsSiteDataTool(inert),
    createMenhoodDataTool(inert),
  ];
  return tools as ReadonlyArray<Tool<unknown, unknown>>;
}

export function buildGeneratedNativeToolSpecs(): GeneratedSpec[] {
  const contracts = buildCanonicalToolContracts();
  const byId = new Map(contracts.map(tool => [String(tool.id), tool]));
  const missing = CANONICAL_TOOL_IDS.filter(toolId => !byId.has(toolId));
  const unexpected = [...byId.keys()].filter(toolId => !CANONICAL_TOOL_IDS.includes(toolId as never));
  if (missing.length > 0 || unexpected.length > 0 || byId.size !== contracts.length) {
    throw new Error(`Canonical tool construction drift: ${JSON.stringify({ missing, unexpected })}`);
  }

  return CANONICAL_TOOL_IDS
    .filter(toolId => toolId !== 'semrush')
    .map(toolId => {
      const tool = byId.get(toolId);
      if (!tool) throw new Error(`Missing canonical tool contract: ${toolId}`);
      const parameters = sanitizeSchema(
        serializeToolArgsSchema(tool.argsSchema, { $refStrategy: 'none' }),
        toolId,
      );
      const name = typedToolNameFor(toolId);
      return {
        toolId,
        name,
        family: tool.family,
        label: `Divo ${humanizeToolId(toolId)}`,
        description: tool.description,
        promptSnippet: `Use ${name} for governed ${tool.family} work. The backend remains authoritative for access, connections, approvals, and execution.`,
        promptGuidelines: compactGuidelines(tool.parameterDocs),
        parameters,
        executionMode: tool.actionGroups.size === 1 && tool.actionGroups.has('read')
          ? 'parallel'
          : 'sequential',
      };
    });
}

function sanitizeSchema(value: unknown, toolId: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${toolId} args schema did not serialize to an object`);
  }
  const schema = { ...(value as Record<string, unknown>) };
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  const objectRoot = schema.type === 'object' && isRecord(schema.properties);
  const unionRoot = anyOf?.length
    && anyOf.every(branch => isRecord(branch) && branch.type === 'object' && isRecord(branch.properties));
  if (!objectRoot && !unionRoot) {
    throw new Error(`${toolId} args schema root is not an object union`);
  }
  if (JSON.stringify(schema).includes('"$ref"')) {
    throw new Error(`${toolId} args schema contains an unresolved $ref`);
  }
  if (unionRoot) schema.type = 'object';
  delete schema.$schema;
  delete schema.$id;
  delete schema.title;
  return schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Procedures belong in skills. Keep only the first bounded mechanics bullets
 * on an always-visible tool so the full catalogue does not duplicate every
 * workflow rule into every model request.
 */
function compactGuidelines(parameterDocs: string): string[] {
  const lines = parameterDocs
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
  return lines.slice(0, 4);
}

function humanizeToolId(toolId: string): string {
  return toolId
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, value => value.toUpperCase());
}

function renderFamily(family: string, specs: readonly GeneratedSpec[]): string {
  const constant = `${family.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_NATIVE_TOOLS`;
  return [
    '/* This file is generated by advance-backend/scripts/generate-pi-native-tools.ts. */',
    '/* Edit the canonical backend Tool contract, then regenerate. */',
    '',
    'import type { NativeToolSpec } from "../catalogue-contract.ts";',
    '',
    `export const ${constant} = ${JSON.stringify(specs, null, 2)} as const satisfies readonly NativeToolSpec[];`,
    '',
  ].join('\n');
}

function renderIndex(families: readonly string[], digest: string): string {
  const imports = families.map(family => {
    const constant = `${family.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_NATIVE_TOOLS`;
    return `import { ${constant} } from "./${family}.ts";`;
  });
  const spreads = families.map(family => {
    const constant = `${family.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_NATIVE_TOOLS`;
    return `\t...${constant},`;
  });
  return [
    '/* This file is generated by advance-backend/scripts/generate-pi-native-tools.ts. */',
    '/* Edit the canonical backend Tool contract, then regenerate. */',
    '',
    ...imports,
    '',
    `export const GENERATED_NATIVE_CATALOGUE_DIGEST = "${digest}";`,
    '',
    'export const GENERATED_NATIVE_TOOL_SPECS = [',
    ...spreads,
    '] as const;',
    '',
  ].join('\n');
}

export function renderGeneratedNativeToolFiles(): Map<string, string> {
  const specs = buildGeneratedNativeToolSpecs();
  const digest = createHash('sha256').update(JSON.stringify(specs)).digest('hex');
  const grouped = new Map<string, GeneratedSpec[]>();
  for (const spec of specs) {
    const family = grouped.get(spec.family) ?? [];
    family.push(spec);
    grouped.set(spec.family, family);
  }
  const families = [...grouped.keys()].sort();
  const files = new Map<string, string>();
  for (const family of families) {
    files.set(`${family}.ts`, renderFamily(family, grouped.get(family) ?? []));
  }
  files.set('index.ts', renderIndex(families, digest));
  return files;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') {
    throw new Error('Usage: tsx scripts/generate-pi-native-tools.ts --write|--check');
  }
  const files = renderGeneratedNativeToolFiles();
  if (mode === '--write') await mkdir(GENERATED_DIR, { recursive: true });
  const drift: string[] = [];
  for (const [fileName, expected] of files) {
    const target = resolve(GENERATED_DIR, fileName);
    if (mode === '--write') {
      await writeFile(target, expected, 'utf8');
      continue;
    }
    const actual = await readFile(target, 'utf8').catch(() => undefined);
    if (actual !== expected) drift.push(fileName);
  }
  if (drift.length > 0) {
    throw new Error(`Pi-native tool catalogue drift: ${drift.join(', ')}. Run pnpm generate:pi-native-tools.`);
  }
  process.stdout.write(`${mode === '--write' ? 'Wrote' : 'Verified'} ${files.size} generated Pi-native catalogue files.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
