import { spawn } from 'node:child_process';

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  // CI/deploy has no interactive Prisma prompt. Tenant-integrity unique indexes and
  // other additive constraints may require this flag even when no rows are deleted.
  await run(['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss']);
  await run([
    'exec',
    'prisma',
    'db',
    'execute',
    '--file',
    'prisma/sql/knowledge-invariants.sql',
    '--schema',
    'prisma/schema.prisma',
  ]);
}

function run(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', [...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`Schema command failed ${signal ? `with ${signal}` : `with code ${code ?? 'unknown'}`}.`));
    });
  });
}
