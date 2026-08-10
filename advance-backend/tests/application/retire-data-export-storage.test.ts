import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blockingDataExportJobs,
  dataExportRetirementProbeExitCode,
  inspectRetiredDataExportStorage,
  retiredDataExportDropSql,
} from '../../scripts/retire-data-export-storage';

test('retired exporter storage blocks deletion while runnable jobs remain', () => {
  assert.equal(blockingDataExportJobs({ active: 1, waiting: 2, completed: 50, failed: 3 }), 3);
});

test('retired exporter storage permits deletion when only terminal jobs remain', () => {
  assert.equal(blockingDataExportJobs({ completed: 50, failed: 3 }), 0);
});

test('retired exporter storage treats every runnable BullMQ state as blocking', () => {
  assert.equal(blockingDataExportJobs({ delayed: 1, paused: 1, prioritized: 1, 'waiting-children': 1 }), 4);
});

test('retired exporter probe distinguishes ready, already absent, and runnable jobs', () => {
  assert.equal(dataExportRetirementProbeExitCode({ DataExportOffer: 2 }, { completed: 1 }), 0);
  assert.equal(dataExportRetirementProbeExitCode({ DataExportOffer: 'absent' }, {}), 3);
  assert.equal(dataExportRetirementProbeExitCode({ DataExportOffer: 2 }, { waiting: 1 }), 4);
});

test('retired exporter storage inspects Prisma CamelCase tables with quoted regclass names', async () => {
  const regclasses: string[] = [];
  const prisma = {
    $queryRawUnsafe: async (_sql: string, regclass: string) => {
      regclasses.push(regclass);
      return [{ exists: false }];
    },
  };

  const rows = await inspectRetiredDataExportStorage(prisma as never);
  assert.deepEqual(regclasses, [
    'public."DataExportPlan"',
    'public."DataExportCandidate"',
    'public."DataExportOffer"',
    'public."DataExportDestinationPreference"',
  ]);
  assert.deepEqual(rows, {
    DataExportPlan: 'absent',
    DataExportCandidate: 'absent',
    DataExportOffer: 'absent',
    DataExportDestinationPreference: 'absent',
  });
});

test('retired exporter storage drops only the four exact tables without cascading', () => {
  assert.equal(
    retiredDataExportDropSql(),
    'DROP TABLE IF EXISTS "DataExportPlan", "DataExportCandidate", "DataExportOffer", "DataExportDestinationPreference"',
  );
  assert.doesNotMatch(retiredDataExportDropSql(), /CASCADE/i);
});
