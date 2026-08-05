# Setup and secrets

This runbook starts the local Mac as if it were the Pi worker VM. It uses the
development Postgres database through an SSH tunnel, local Redis, the local
backend, and the real Dockerized Pi runtime.

## Prerequisites

- Docker Desktop is running.
- Node.js 22 and pnpm 10.33.4 are available.
- Dependencies are installed in `advance-backend/` and `divo-pi/`.
- `advance-backend/.env` exists and contains the normal development
  configuration.
- `redis-server`, `redis-cli`, `ssh`, `curl`, `jq`, and either `pg_isready` or
  `nc` are available.
- `uvx` is available because `pnpm dev` starts the Google Workspace MCP
  sidecar.
- The teammate has SSH key access to the development DB tunnel, or has been
  given the development VPS password for this session.

Run these non-mutating checks:

```bash
node --version
pnpm --version
docker version
redis-server --version
uvx --version
```

## Missing credential rule

The database tunnel defaults to `deploy@103.172.92.187`, forwards local port
`15432` to VPS loopback port `15433`, and supports two auth modes:

1. **SSH key (preferred):** set `DB_TUNNEL_SSH_IDENTITY_FILE` in local
   `advance-backend/.env` to the private key path you were given.
2. **Password:** set `DB_TUNNEL_SSH_PASSWORD` in local `.env` only (requires
   `sshpass`; `brew install sshpass` on macOS). Leave
   `DB_TUNNEL_SSH_IDENTITY_FILE` unset in this mode.

Use SSH user **`deploy`**, not `root`. The VPS provider's root/panel password is
not the same as the deploy SSH password used by `scripts/db-tunnel.sh`.

If neither key nor `DB_TUNNEL_SSH_PASSWORD` / `SSHPASS` is available, stop and
ask the human for the deploy-user password or a deploy SSH key. Do not search the
repository, old messages, shell history, or logs for it.

For an interactive human shell, this avoids printing the password or putting
it in shell history:

```bash
read -s "DB_TUNNEL_SSH_PASSWORD?Development VPS password: "
echo
export DB_TUNNEL_SSH_PASSWORD
```

An automated agent must ask for the missing secret and use the execution
environment's secure secret input. It must never paste the value into a command
line or tracked `.env` file.

## Start the stack

Use separate terminals so logs stay attributable.

### Terminal 1: database tunnel and Redis

```bash
cd advance-backend
pnpm dev:e2e
bash scripts/db-tunnel.sh status
```

`pnpm dev:e2e` starts and verifies the Postgres SSH tunnel, starts Redis queue
on `6380`, Redis cache on `6381`, and generates the Prisma client. It does not
start the backend.

### Terminal 2: Pi image and controller

Build the runtime image after any `divo-pi/` runtime, extension, skill, or
Dockerfile change:

```bash
cd divo-pi
docker build -t divo-pi-local:phase0 .
```

Then start the controller in the foreground:

```bash
MAX_ACTIVE_RUNS=2 node divo/local-rpc-server.mjs
```

The controller listens at `127.0.0.1:4317`. On startup it stops any
Divo-labelled container left running by an interrupted local test. It does not
delete the user's durable workspace volume.

### Terminal 3: backend

```bash
cd advance-backend
pnpm dev
```

This starts the Google Workspace MCP sidecar and the backend watcher. The local
backend defaults to `http://127.0.0.1:8000`.

## Preflight

Do not send a test prompt until both checks pass:

```bash
curl -fsS http://127.0.0.1:4317/health | jq .
curl -fsS http://127.0.0.1:8000/health | jq .
```

Expected controller shape:

```json
{
  "status": "ok",
  "activeRuns": 0,
  "maxActiveRuns": 2
}
```

The Pi controller must remain private. Only the backend or an explicit local
health check should call port `4317`.

## Normal lifecycle

For each admitted user:

1. The backend issues a short-lived runtime lease from that user's active Lark
   member session.
2. The controller derives a stable user profile and thread; callers do not
   supply Docker paths or volume names.
3. Docker starts that user's stopped container and mounts that user's durable
   volume.
4. Pi runs terminal/file actions locally and calls governed company tools
   through the backend Divo Gateway.
5. The controller clears the temporary bootstrap credential and stops the
   container in `finally`.
6. The workspace volume remains for the next run.

## Stop at the end of the day

Stop the foreground backend and controller with `Ctrl+C`, then:

```bash
cd advance-backend
pnpm stop
```

`pnpm stop` stops the two local Redis processes and the DB tunnel. It does not
delete Docker containers, images, networks, or user volumes. Do not add a
cleanup command unless deletion was explicitly requested.

