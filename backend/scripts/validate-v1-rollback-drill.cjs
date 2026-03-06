#!/usr/bin/env node

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const configModule = require('../dist/config');
const config = configModule.default || configModule;

const parseExpectedEngine = (argv) => {
  const flag = argv.find((arg) => arg.startsWith('--expected-engine='));
  if (!flag) {
    return null;
  }
  const value = flag.split('=')[1]?.trim();
  if (value === 'langgraph' || value === 'legacy') {
    return value;
  }
  return null;
};

const parseBoolean = (input, fallback) => {
  if (input === undefined || input === null || input === '') {
    return fallback;
  }
  const normalized = String(input).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const toError = (error) => (error instanceof Error ? error.message : String(error));

const requestJson = async (baseUrl, token, pathName) => {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(`GET ${pathName} failed with ${response.status}${raw ? `: ${raw}` : ''}`);
  }

  return parsed;
};

const readEngine = (task) => {
  if (!task || typeof task !== 'object') {
    return null;
  }
  return task.engineUsed || task.engine || null;
};

const runApiValidation = async (baseUrl, token, expectedEngine) => {
  if (!baseUrl || !token) {
    return {
      status: 'skipped',
      reason: 'ROLLBACK_DRILL_BASE_URL/ADMIN_RUNTIME_BASE_URL or token not set',
    };
  }

  try {
    const health = await requestJson(baseUrl, token, '/api/admin/runtime/health');
    const tasksResponse = await requestJson(baseUrl, token, '/api/admin/runtime/tasks?limit=20');
    const tasks = Array.isArray(tasksResponse?.data) ? tasksResponse.data : [];

    if (tasks.length === 0) {
      return {
        status: 'no_tasks',
        reason: 'runtime task list is empty; engine metadata cannot be asserted from live tasks',
        health: health?.data ?? health,
      };
    }

    const matchedTask = tasks.find((task) => readEngine(task) === expectedEngine);
    if (!matchedTask) {
      return {
        status: 'failed',
        reason: `no runtime task with effective engine '${expectedEngine}'`,
        sampledEngines: tasks.map((task) => readEngine(task)).filter(Boolean),
        health: health?.data ?? health,
      };
    }

    return {
      status: 'pass',
      health: health?.data ?? health,
      matchedTaskId: matchedTask.taskId,
      engineUsed: readEngine(matchedTask),
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: toError(error),
    };
  }
};

const main = async () => {
  const expectedEngine = parseExpectedEngine(process.argv.slice(2));
  if (!expectedEngine) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "Missing or invalid --expected-engine flag. Use --expected-engine=langgraph|legacy",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.ROLLBACK_DRILL_BASE_URL || process.env.ADMIN_RUNTIME_BASE_URL || '';
  const token = process.env.ROLLBACK_DRILL_ADMIN_TOKEN || process.env.ADMIN_RUNTIME_BEARER_TOKEN || '';
  const requireApi = parseBoolean(process.env.ROLLBACK_DRILL_REQUIRE_API, false);

  const configuredEngine = config.ORCHESTRATION_ENGINE;
  const configMatch = configuredEngine === expectedEngine;

  const apiValidation = await runApiValidation(baseUrl, token, expectedEngine);
  const apiPass = apiValidation.status === 'pass';
  const apiOptionalOk = !requireApi && (apiValidation.status === 'skipped' || apiValidation.status === 'no_tasks');

  const ok = Boolean(configMatch && (apiPass || apiOptionalOk));

  const report = {
    generatedAt: new Date().toISOString(),
    expectedEngine,
    configuredEngine,
    configMatch,
    requireApi,
    apiValidation,
    ok,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = ok ? 0 : 1;
};

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: toError(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
