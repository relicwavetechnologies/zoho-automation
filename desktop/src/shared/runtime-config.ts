import { existsSync, readFileSync } from "fs";
import { join } from "path";

type RuntimeConfig = {
  backendUrl: string;
  webAppUrl: string;
};

const DEFAULT_BACKEND_URL = "http://localhost:8000";
const DEFAULT_WEB_APP_URL = "http://localhost:5173";

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

function readBundledEnv(): Record<string, string> {
  const candidates = [
    join(process.resourcesPath, "app.env"),
    join(__dirname, "../../.env"),
    join(process.cwd(), ".env"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return parseEnvFile(candidate);
    }
  }

  return {};
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

export function readRuntimeConfig(): RuntimeConfig {
  const fileEnv = readBundledEnv();
  const env = process.env as Record<string, string | undefined>;
  const sources = [env, fileEnv];

  return {
    backendUrl:
      firstDefined(sources, ["DIVO_BACKEND_URL", "CURSORR_BACKEND_URL"])
      ?? DEFAULT_BACKEND_URL,
    webAppUrl:
      firstDefined(sources, ["DIVO_WEB_APP_URL", "CURSORR_WEB_APP_URL"])
      ?? DEFAULT_WEB_APP_URL,
  };
}
