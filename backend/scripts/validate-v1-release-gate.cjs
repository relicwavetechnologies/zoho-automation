#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const docsDir = path.join(repoRoot, 'docs');
const evidenceDir = path.join(docsDir, 'evidence');
const waiverFilePath = path.join(docsDir, 'V1-RELEASE-WAIVERS.json');

const SCENARIOS = [
  {
    id: 'build_backend',
    name: 'Backend build',
    command: 'pnpm -C backend build',
    required: true,
  },
  {
    id: 'unit_lark',
    name: 'Lark unit suite',
    command: 'pnpm -C backend test:unit:lark',
    required: true,
  },
  {
    id: 'unit_v1',
    name: 'V1 orchestration unit suite',
    command: 'pnpm -C backend test:unit:v1',
    required: true,
  },
  {
    id: 'unit_zoho',
    name: 'Zoho/Qdrant/embedding unit suite',
    command: 'pnpm -C backend test:unit:zoho',
    required: true,
  },
  {
    id: 'resilience_tests',
    name: 'Resilience test suite',
    command: 'pnpm -C backend run test:resilience',
    required: true,
  },
  {
    id: 'resilience_drill',
    name: 'Resilience drill script',
    command: 'node backend/scripts/validate-v1-resilience.cjs',
    required: true,
  },
  {
    id: 'core_smoke',
    name: 'Core smoke script',
    command: 'node backend/scripts/validate-v0-core-smoke.cjs',
    required: true,
  },
  {
    id: 'admin_e2e',
    name: 'Admin e2e script',
    command: 'node backend/scripts/validate-admin-e2e.cjs',
    required: true,
  },
];

const parseBoolean = (input, defaultValue) => {
  if (input === undefined || input === null || input === '') {
    return defaultValue;
  }

  const normalized = String(input).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
};

const parsePositiveInteger = (input, fallback) => {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
};

const trimOutput = (text) => {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  if (lines.length <= 40) {
    return lines.join('\n');
  }
  return lines.slice(lines.length - 40).join('\n');
};

const toTimestampToken = (value) => {
  const pad = (num) => String(num).padStart(2, '0');
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hour = pad(value.getHours());
  const minute = pad(value.getMinutes());
  const second = pad(value.getSeconds());
  return `${year}${month}${day}-${hour}${minute}${second}`;
};

const validateWaiverRecord = (item, now) => {
  const requiredKeys = ['scenarioId', 'reason', 'owner', 'expiresOn', 'ticket'];
  for (const key of requiredKeys) {
    if (!item || typeof item[key] !== 'string' || item[key].trim().length === 0) {
      return `waiver is missing non-empty string field '${key}'`;
    }
  }

  const expiry = new Date(item.expiresOn);
  if (Number.isNaN(expiry.valueOf())) {
    return `waiver '${item.scenarioId}' has invalid expiresOn date '${item.expiresOn}'`;
  }

  if (expiry.getTime() < now.getTime()) {
    return `waiver '${item.scenarioId}' expired on ${item.expiresOn}`;
  }

  return null;
};

const loadWaivers = (now) => {
  if (!fs.existsSync(waiverFilePath)) {
    return { map: new Map(), errors: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(waiverFilePath, 'utf8'));
  } catch (error) {
    return {
      map: new Map(),
      errors: [`failed to parse waiver file: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!Array.isArray(parsed)) {
    return { map: new Map(), errors: ['waiver file must be a JSON array'] };
  }

  const map = new Map();
  const errors = [];

  for (const item of parsed) {
    const validationError = validateWaiverRecord(item, now);
    if (validationError) {
      errors.push(validationError);
      continue;
    }

    if (map.has(item.scenarioId)) {
      errors.push(`duplicate waiver for scenarioId '${item.scenarioId}'`);
      continue;
    }

    map.set(item.scenarioId, item);
  }

  return { map, errors };
};

const runCommandScenario = (scenario, waiverMap, allowWaivers, timeoutMs) => {
  const startedAt = Date.now();
  const result = spawnSync(scenario.command, {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - startedAt;

  const passed = result.status === 0 && !result.error;
  const waiver = !passed && allowWaivers ? waiverMap.get(scenario.id) ?? null : null;
  const timeoutError =
    result.error && typeof result.error === 'object' && result.error.code === 'ETIMEDOUT'
      ? `Command timed out after ${timeoutMs}ms`
      : null;

  return {
    id: scenario.id,
    name: scenario.name,
    command: scenario.command,
    required: scenario.required,
    status: passed ? 'PASS' : waiver ? 'FAIL_WAIVED' : 'FAIL',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    durationMs,
    waived: Boolean(waiver),
    waiver,
    output: {
      stdoutTail: trimOutput(result.stdout),
      stderrTail: trimOutput(timeoutError ? `${result.stderr || ''}\n${timeoutError}` : result.stderr),
    },
  };
};

const buildMarkdownReport = (report) => {
  const lines = [];
  lines.push('# V1 Release Gate Evidence');
  lines.push('');
  lines.push(`- Generated At: ${report.generatedAt}`);
  lines.push(`- Overall Status: ${report.overallStatus}`);
  lines.push(`- Waivers Allowed: ${report.allowWaivers}`);
  lines.push(`- Summary: pass=${report.summary.pass}, fail=${report.summary.fail}, fail_waived=${report.summary.failWaived}`);
  lines.push('');

  if (report.waiverValidationErrors.length > 0) {
    lines.push('## Waiver Validation Errors');
    lines.push('');
    for (const error of report.waiverValidationErrors) {
      lines.push(`- ${error}`);
    }
    lines.push('');
  }

  lines.push('## Scenario Results');
  lines.push('');
  lines.push('| Scenario ID | Status | Duration (ms) | Exit Code | Waiver |');
  lines.push('|---|---|---:|---:|---|');
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.id} | ${scenario.status} | ${scenario.durationMs} | ${scenario.exitCode ?? ''} | ${scenario.waiver ? scenario.waiver.ticket : ''} |`,
    );
  }
  lines.push('');

  lines.push('## Command Details');
  lines.push('');
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.id} — ${scenario.name}`);
    lines.push('');
    lines.push(`- Command: \`${scenario.command}\``);
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Duration: ${scenario.durationMs} ms`);
    if (scenario.waiver) {
      lines.push(`- Waiver: ${scenario.waiver.ticket} (owner: ${scenario.waiver.owner}, expires: ${scenario.waiver.expiresOn})`);
      lines.push(`- Waiver reason: ${scenario.waiver.reason}`);
    }
    lines.push('');
    if (scenario.output.stdoutTail) {
      lines.push('```text');
      lines.push(scenario.output.stdoutTail);
      lines.push('```');
      lines.push('');
    }
    if (scenario.output.stderrTail) {
      lines.push('```text');
      lines.push(scenario.output.stderrTail);
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
};

const main = () => {
  const generatedAt = new Date();
  const allowWaivers = parseBoolean(process.env.RELEASE_GATE_ALLOW_WAIVERS, true);
  const scenarioTimeoutMs = parsePositiveInteger(process.env.RELEASE_GATE_COMMAND_TIMEOUT_MS, 30000);

  const waiverLoad = loadWaivers(generatedAt);

  const scenarios = SCENARIOS.map((scenario) =>
    runCommandScenario(scenario, waiverLoad.map, allowWaivers, scenarioTimeoutMs),
  );

  const fail = scenarios.filter((scenario) => scenario.status === 'FAIL').length;
  const failWaived = scenarios.filter((scenario) => scenario.status === 'FAIL_WAIVED').length;
  const pass = scenarios.filter((scenario) => scenario.status === 'PASS').length;

  const overallStatus = waiverLoad.errors.length > 0
    ? 'FAIL'
    : fail > 0
      ? 'FAIL'
      : failWaived > 0
        ? 'PASS_WITH_WAIVERS'
        : 'PASS';

  const report = {
    generatedAt: generatedAt.toISOString(),
    overallStatus,
    allowWaivers,
    waiverValidationErrors: waiverLoad.errors,
    scenarios,
    summary: {
      total: scenarios.length,
      pass,
      fail,
      failWaived,
    },
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  const token = toTimestampToken(generatedAt);
  const jsonPath = path.join(evidenceDir, `v1-release-gate-${token}.json`);
  const mdPath = path.join(evidenceDir, `v1-release-gate-${token}.md`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, `${buildMarkdownReport(report)}\n`, 'utf8');

  const output = {
    ...report,
    artifacts: {
      jsonPath,
      mdPath,
    },
  };

  console.log(JSON.stringify(output, null, 2));
  process.exitCode = overallStatus === 'FAIL' ? 1 : 0;
};

main();
