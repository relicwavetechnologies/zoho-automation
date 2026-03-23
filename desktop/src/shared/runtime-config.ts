import { existsSync, readFileSync } from "fs";
import { join } from "path";

type RuntimeConfig = {
  backendUrl: string;
  webAppUrl: string;
  backendUrlSource: string;
  webAppUrlSource: string;
};

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const result: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function readBundledEnv(): {
  values: Record<string, string>;
  source: string | null;
} {
  const candidates = [
    join(process.resourcesPath, "app.env"),
    join(__dirname, "../../.env"),
    join(process.cwd(), ".env"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        values: parseEnvFile(candidate),
        source: `file:${candidate}`,
      };
    }
  }

  return {
    values: {},
    source: null,
  };
}

function firstDefined(
  sources: Array<Record<string, string | undefined>>,
  keys: string[],
): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return undefined;
}

function resolveWithSource(
  processEnv: Record<string, string | undefined>,
  fileEnv: { values: Record<string, string>; source: string | null },
  keys: string[],
): { value: string; source: string } {
  const processValue = firstDefined([processEnv], keys);
  if (processValue) {
    return { value: processValue, source: "process.env" };
  }

  const fileValue = firstDefined([fileEnv.values], keys);
  if (fileValue) {
    return {
      value: fileValue,
      source: fileEnv.source ?? "file:.env",
    };
  }

  return {
    value: "",
    source: "unset",
  };
}

export function readRuntimeConfig(): RuntimeConfig {
  const fileEnv = readBundledEnv();
  const env = process.env as Record<string, string | undefined>;
  const backend = resolveWithSource(
    env,
    fileEnv,
    ["DIVO_BACKEND_URL", "CURSORR_BACKEND_URL"],
  );
  const webApp = resolveWithSource(
    env,
    fileEnv,
    ["DIVO_WEB_APP_URL", "CURSORR_WEB_APP_URL"],
  );

  return {
    backendUrl: backend.value,
    webAppUrl: webApp.value,
    backendUrlSource: backend.source,
    webAppUrlSource: webApp.source,
  };
}
