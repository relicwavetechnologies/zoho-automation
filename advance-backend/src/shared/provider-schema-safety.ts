export interface ProviderSchemaToolShape {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface ProviderSchemaSafetyPolicy {
  readonly forbiddenProperties: readonly string[];
  readonly appendedDescription?: readonly string[];
}

/** Remove provider fields Divo will refuse before the schema becomes durable or model-visible. */
export function sanitizeProviderSchemaTool<TTool extends ProviderSchemaToolShape>(
  tool: TTool,
  policy: ProviderSchemaSafetyPolicy,
): TTool {
  const forbidden = normalizedNames(policy.forbiddenProperties);
  return {
    ...tool,
    ...(tool.description ? {
      description: sanitizeProviderDescription(
        tool.description,
        forbidden,
        policy.appendedDescription ?? [],
      ),
    } : {}),
    inputSchema: sanitizeSchemaNode(tool.inputSchema, forbidden),
  };
}

/** Return the first forbidden runtime argument path, including nested objects and arrays. */
export function findForbiddenProviderInputPath(
  value: unknown,
  forbiddenProperties: readonly string[],
  path = 'input',
): string | undefined {
  const forbidden = normalizedNames(forbiddenProperties);
  return findForbiddenPath(value, forbidden, path);
}

function sanitizeSchemaNode(value: unknown, forbidden: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeSchemaNode(item, forbidden));
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(normalizeName(key))) continue;
    if (key === 'properties' && isRecord(child)) {
      sanitized[key] = Object.fromEntries(
        Object.entries(child)
          .filter(([property]) => !forbidden.has(normalizeName(property)))
          .map(([property, schema]) => [property, sanitizeSchemaNode(schema, forbidden)]),
      );
      continue;
    }
    if (key === 'required' && Array.isArray(child)) {
      sanitized[key] = child.filter(property =>
        typeof property !== 'string' || !forbidden.has(normalizeName(property)));
      continue;
    }
    if ((key === 'dependentRequired' || key === 'dependencies') && isRecord(child)) {
      sanitized[key] = Object.fromEntries(
        Object.entries(child)
          .filter(([property]) => !forbidden.has(normalizeName(property)))
          .map(([property, dependency]) => [
            property,
            Array.isArray(dependency)
              ? dependency.filter(item =>
                  typeof item !== 'string' || !forbidden.has(normalizeName(item)))
              : sanitizeSchemaNode(dependency, forbidden),
          ]),
      );
      continue;
    }
    if (key === 'description' && typeof child === 'string') {
      sanitized[key] = sanitizeProviderDescription(child, forbidden, []);
      continue;
    }
    sanitized[key] = sanitizeSchemaNode(child, forbidden);
  }
  return sanitized;
}

function sanitizeProviderDescription(
  description: string,
  forbidden: ReadonlySet<string>,
  appended: readonly string[],
): string {
  const safeSentences = description
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => ![...forbidden].some(property =>
      descriptionContainsCanonicalName(sentence, property)));
  return [...safeSentences, ...appended].join(' ').trim();
}

function findForbiddenPath(
  value: unknown,
  forbidden: ReadonlySet<string>,
  path: string,
): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenPath(value[index], forbidden, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (forbidden.has(normalizeName(key))) return childPath;
    const found = findForbiddenPath(child, forbidden, childPath);
    if (found) return found;
  }
  return undefined;
}

function normalizedNames(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map(normalizeName).filter(Boolean));
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function descriptionContainsCanonicalName(value: string, canonicalName: string): boolean {
  const tokens = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  for (let start = 0; start < tokens.length; start += 1) {
    let candidate = '';
    for (let end = start; end < tokens.length; end += 1) {
      candidate += tokens[end];
      if (candidate === canonicalName) return true;
      if (candidate.length >= canonicalName.length) break;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
