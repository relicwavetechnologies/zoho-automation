import { app } from './app';
import { config } from './config/env';
import { seedSystemRoles } from './modules/policy/seed-roles';

async function start() {
  await seedSystemRoles();

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.info(`Listening on 0.0.0.0:${config.port}`);
  });
}

void start();
