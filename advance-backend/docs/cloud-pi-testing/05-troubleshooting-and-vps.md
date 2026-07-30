# Troubleshooting and VPS observation

Record the first exact failing command, HTTP status, and error code before
changing anything. Do not hide a Pi failure with the retired AI SDK agent.

## Fast decision table

| Symptom or code | Meaning | Next check |
| --- | --- | --- |
| Controller health fails | Controller is stopped, Docker is unavailable, or port `4317` is wrong | Start `node divo/local-rpc-server.mjs`; check Docker and `PI_LARK_CONTROLLER_URL` |
| Backend health fails | Backend, DB, Redis, env validation, or MCP startup failed | Read the first backend error; check tunnel and Redis before restarting |
| `runtime_image_missing` / image missing | `divo-pi-local:phase0` is not built locally | Build from `divo-pi/` with `docker build -t divo-pi-local:phase0 .` |
| `runtime_session_missing` in live webhook | No matching unrevoked Lark member session with more than five minutes remaining | Sign in through the real Divo Lark flow; do not synthesize a session |
| `runtime_session_missing` in direct harness | The current harness omits the tenant ID required by runtime session lookup | Use live Lark for E2E; fix the harness tenant binding separately rather than asking the user to sign in repeatedly |
| No DB-linked identity / ambiguous identity | `--user` did not resolve exactly one Lark identity | Ask for exact email or `open_id` |
| Chat is not allowlisted | Custom `--chat-id` is absent from `HARNESS_LARK_ALLOWED_CHAT_IDS` | Confirm the exact destination, then add only that ID for the command |
| `controller_unreachable` | Backend cannot reach the private controller | Check controller health and backend/controller network address |
| `409 user_busy` | That user's profile already has one active run | Let it finish or stop it through the supported user action |
| `429 capacity_full` | All controller slots are occupied | Wait for a slot; do not increase limits during a correctness test |
| `empty_runtime_response` | Pi ended without usable final text | Inspect controller stderr and the persisted trace |
| `invalid_controller_stream` | Controller emitted malformed NDJSON | Capture the response/trace and stop; this is a runtime protocol defect |
| Harness rejects `pro` | Dynamic cloud Pi model switching is not implemented | Use `--model flash` |
| Lark shows no response | Event URL, signature/token, queue admission, identity, or delivery failed | Check webhook HTTP status and backend logs in that order |
| ngrok shows `503` | Local backend was unavailable or returned ingress failure | Confirm port `8000`, DB tunnel, Redis, and backend logs |
| Container is `Exited` after success | Normal idle behavior | Verify its volume remains; do not restart it manually |
| Media works in Lark but not harness | Harness carries no inbound attachments | Use the live webhook media test |

## Local observations

```bash
cd advance-backend
bash scripts/db-tunnel.sh status
redis-cli -p 6380 ping
redis-cli -p 6381 ping
curl -fsS http://127.0.0.1:8000/health | jq .
curl -fsS http://127.0.0.1:4317/health | jq .
docker ps -a \
  --filter label=dev.divo.profile \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
```

Read the latest harness trace:

```bash
rg -n 'run_failed|tool_call|model_call|run_complete' \
  /tmp/divo-harness-latest.jsonl
```

Do not delete volumes to fix a startup problem. First establish whether the
failure is the backend, controller, image, runtime session, or one user's
workspace.

## Development VPS: credential boundary

The shared development host is `103.172.92.187` and the normal user is
`deploy`. Prefer the provisioned SSH key.

If the required key/password is not available, stop and ask the human. Never
guess a root/deploy password, reuse a password from chat history, or write one
into the repository. Never display the received value in logs.

Before any VPS command, state that the scope is:

```text
/opt/divo-dev and Docker resources belonging to the divo-development project
```

Grind is explicitly out of scope.

## Read-only VPS checks

Connect with the approved identity:

```bash
ssh deploy@103.172.92.187
```

Then inspect only Divo development resources:

```bash
docker ps -a \
  --filter label=com.docker.compose.project=divo-development \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'

curl -fsS http://127.0.0.1:13001/health | jq .
curl -fsS https://app-dev.103.172.92.187.sslip.io/health | jq .
```

To check backend-to-controller routing, first copy the exact backend container
name from the filtered `docker ps` output, then:

```bash
docker exec <exact-divo-dev-backend-container> \
  node -e "fetch('http://divo-dev-pi-controller:4317/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }).catch(e => { console.error(e.message); process.exit(1); })"
```

To read logs, again use an exact Divo container name resolved from the filtered
list:

```bash
docker logs --since 15m --tail 200 <exact-divo-development-container>
```

These are observations only. Do not run `docker stop`, `restart`, `rm`,
`compose up/down`, image pruning, volume deletion, migrations, seeding, or file
edits without explicit authorization.

## Deployment facts

Development deployment is owned by the `CI` workflow's explicit
`workflow_dispatch` on branch `dev` with `deploy_development=true`. It builds
and publishes backend, admin, Pi runtime, and Pi controller images, then
deploys `/opt/divo-dev`.

A local code change is not on the VPS until that workflow completes
successfully. A green local harness proves local code; a green permanent Lark
test proves the deployed commit. Record the commit SHA in every test result.

## Escalation packet

When asking another engineer for help, send only:

- environment and commit SHA;
- exact command or Lark prompt;
- exact first error code/status;
- correlation/request ID and time window;
- controller health before/during/after;
- exact Divo container status;
- redacted relevant log lines;
- whether the failure reproduces in direct harness, live webhook, or both.

Do not include passwords, tokens, OAuth codes, cookies, whole `.env` files, or
private customer documents.
