# Live Lark webhook testing

Use this path when the test must begin with a human sending a message in Lark.
It proves signed webhook ingress, durable queue admission, identity/session
handling, isolated Pi execution, status updates, cards, approvals, attachments,
and final delivery.

## Permanent development path

The development Lark app currently points to:

```text
https://app-dev.103.172.92.187.sslip.io/webhooks/lark/events
```

For ordinary team testing, send the prompt directly to the development Divo
bot in Lark. Do not run a local harness and call that webhook proof.

Expected DM behavior:

1. The webhook acknowledges the event.
2. Divo either shows a sign-in card or starts a Pi run.
3. A status card appears and updates while the container works.
4. The final response arrives in the same DM.
5. The per-user container stops afterward; its workspace volume remains.

An expired cloud session is not bypassed. Use the **Connect Lark** card. The
original pending event should continue after successful sign-in without the
user retyping it.

## Group behavior to verify

- A normal top-level group message without mentioning Divo is retained as room
  context but does not receive a Divo reply.
- A top-level message that mentions Divo starts a Divo-owned thread.
- Inside that Divo-owned thread, later human replies continue to Divo without
  requiring another mention.
- Divo replies inside the group thread, not as unrelated top-level messages.

The direct group harness cannot prove these admission rules because it builds
an already-admitted message.

## Local backend through ngrok

Use ngrok only when the purpose is to test uncommitted local backend/webhook
code. Changing the Lark developer-console webhook affects other testers, so get
explicit approval and record the previous URL first.

1. Start the full local stack from
   [01-setup-and-secrets.md](./01-setup-and-secrets.md).
2. Start a tunnel to backend port `8000`:

   ```bash
   ngrok http 8000
   ```

3. Set the Lark event callback to:

   ```text
   https://<assigned-ngrok-host>/webhooks/lark/events
   ```

4. If a separate card callback is configured, use:

   ```text
   https://<assigned-ngrok-host>/webhooks/lark/card
   ```

5. Confirm the Lark console's URL-verification challenge succeeds.
6. Send a uniquely identifiable prompt in the Divo DM.
7. Watch ngrok, backend, controller, and Lark together.
8. Restore the previous webhook URL after the local test if the shared app was
   temporarily changed.

Only the public backend URL goes through ngrok. Never expose the Pi controller
port `4317`.

## Live media proof

Inbound media must be tested here; the direct harness currently constructs no
Lark attachments.

Send one small, non-sensitive fixture to the Divo DM and ask Divo to:

- state the file name and type;
- extract a specific known fact;
- create a small derived artifact in its workspace;
- explain whether OCR or ordinary text extraction was used.

Current controller limits are:

- at most 4 attachments per request;
- at most 25 MiB per attachment;
- at most 50 MiB total per request.

Files are streamed into the sender's own Docker volume. The backend never gives
the controller a caller-selected filesystem path, and Pi reads the staged path
inside its isolated workspace.

## Evidence to record

- test time and environment: permanent development or local ngrok;
- Lark user/open identity and DM/group, without copying credentials;
- prompt and any non-sensitive fixture names;
- webhook HTTP status;
- backend correlation/request ID;
- controller transition `0 → 1 → 0` active runs;
- status-card phases seen;
- final Lark message ID;
- container stopped after completion;
- PASS/FAIL plus the first exact error code.

