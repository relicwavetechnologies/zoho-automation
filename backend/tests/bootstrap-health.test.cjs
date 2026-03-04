const assert = require('node:assert/strict');
const test = require('node:test');

const { BootstrapHealthError, runBootstrapHealthChecks } = require('../dist/loaders/bootstrap-health');

const silentLog = {
  info: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

test('runBootstrapHealthChecks succeeds when all checks pass', async () => {
  const checks = [
    { name: 'database', run: async () => undefined },
    { name: 'redis', run: async () => undefined },
  ];

  const results = await runBootstrapHealthChecks({ checks, log: silentLog });

  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.ok), true);
});

test('runBootstrapHealthChecks fails when database check fails', async () => {
  const checks = [
    { name: 'database', run: async () => { throw new Error('db down'); } },
    { name: 'redis', run: async () => undefined },
  ];

  await assert.rejects(
    async () => runBootstrapHealthChecks({ checks, log: silentLog }),
    (error) => {
      assert.ok(error instanceof BootstrapHealthError);
      assert.ok(error.results.some((result) => result.name === 'database' && result.ok === false));
      return true;
    },
  );
});

test('runBootstrapHealthChecks fails when redis check fails', async () => {
  const checks = [
    { name: 'database', run: async () => undefined },
    { name: 'redis', run: async () => { throw new Error('redis down'); } },
  ];

  await assert.rejects(
    async () => runBootstrapHealthChecks({ checks, log: silentLog }),
    (error) => {
      assert.ok(error instanceof BootstrapHealthError);
      assert.ok(error.results.some((result) => result.name === 'redis' && result.ok === false));
      return true;
    },
  );
});

test('runBootstrapHealthChecks aggregates multiple failures', async () => {
  const checks = [
    { name: 'database', run: async () => { throw new Error('db down'); } },
    { name: 'redis', run: async () => { throw new Error('redis down'); } },
  ];

  await assert.rejects(
    async () => runBootstrapHealthChecks({ checks, log: silentLog }),
    (error) => {
      assert.ok(error instanceof BootstrapHealthError);
      const failed = error.results.filter((result) => !result.ok);
      assert.equal(failed.length, 2);
      return true;
    },
  );
});
