import { createHash } from 'node:crypto';
import { Client as LarkSdkClient, LoggerLevel } from '@larksuiteoapi/node-sdk';
import sdkPackage from '@larksuiteoapi/node-sdk/package.json';

const NON_API_CLIENT_KEYS = new Set([
  'appId',
  'appSecret',
  'appType',
  'cache',
  'clientAssertionProvider',
  'disableTokenCache',
  'domain',
  'helpDeskId',
  'helpDeskToken',
  'httpInstance',
  'logger',
  'oauthBaseUrl',
  'tokenManager',
  'userAccessToken',
  'userAgent',
]);

const HTTP_METHOD = /method:\s*["']([A-Z]+)["']/;
const OPEN_API_PATH = /\/open-apis\/[^`"']+/;

export interface LarkSdkEndpoint {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly services: readonly string[];
  readonly sdkPaths: readonly string[];
}

export interface LarkSdkInventory {
  readonly packageName: '@larksuiteoapi/node-sdk';
  readonly version: string;
  readonly endpointCount: number;
  readonly serviceCount: number;
  readonly sha256: string;
  readonly endpoints: readonly LarkSdkEndpoint[];
}

export const LARK_SDK_PARITY_BASELINE = Object.freeze({
  packageName: '@larksuiteoapi/node-sdk' as const,
  version: '1.71.0',
  endpointCount: 1628,
  serviceCount: 55,
  sha256: 'e638665bd341fcb240279f4b918c498c5a34dc229d7f74cc82d2aa13304a37fa',
});

export function createLarkSdkInventory(): LarkSdkInventory {
  const client = new LarkSdkClient({
    appId: 'inventory-only',
    appSecret: 'inventory-only',
    loggerLevel: LoggerLevel.error,
  });
  const endpointAliases = new Map<string, Set<string>>();
  const visited = new Set<object>();

  const visit = (value: object, parents: readonly string[]): void => {
    if (visited.has(value)) return;
    visited.add(value);

    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      const sdkPath = [...parents, key];
      if (typeof child === 'function') {
        const source = Function.prototype.toString.call(child);
        const method = HTTP_METHOD.exec(source)?.[1];
        const path = OPEN_API_PATH.exec(source)?.[0];
        if (!method || !path) continue;
        const id = `${method} ${path}`;
        const aliases = endpointAliases.get(id) ?? new Set<string>();
        aliases.add(sdkPath.join('.'));
        endpointAliases.set(id, aliases);
      } else if (child && typeof child === 'object') {
        visit(child, sdkPath);
      }
    }
  };

  for (const key of Object.keys(client).sort()) {
    if (NON_API_CLIENT_KEYS.has(key)) continue;
    const value = (client as unknown as Record<string, unknown>)[key];
    if (value && typeof value === 'object') visit(value, [key]);
  }

  const endpoints = [...endpointAliases.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([id, aliases]): LarkSdkEndpoint => {
      const separator = id.indexOf(' ');
      const sdkPaths = [...aliases].sort();
      return {
        id,
        method: id.slice(0, separator),
        path: id.slice(separator + 1),
        services: [...new Set(sdkPaths.map(path => path.split('.')[0]!))].sort(),
        sdkPaths,
      };
    });
  const sha256 = createHash('sha256')
    .update(endpoints.map(endpoint => endpoint.id).join('\n'))
    .digest('hex');

  return {
    packageName: '@larksuiteoapi/node-sdk',
    version: sdkPackage.version,
    endpointCount: endpoints.length,
    serviceCount: new Set(endpoints.flatMap(endpoint => endpoint.services)).size,
    sha256,
    endpoints,
  };
}
