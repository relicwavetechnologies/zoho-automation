# Google Workspace MCP runtime

Divo runs `taylorwilsdon/google_workspace_mcp` as a private backend sidecar.
The reviewed contract is pinned to release `1.22.0`, commit
`6e1d1457746777f8512f52d40fb195b2a40bad36`. The authoritative product/tool
allowlist and scope matrix live in
`application/google/google-workspace-mcp-manifest.ts`.

## Authority boundary

- Divo creates and stores Google OAuth connections and refresh tokens.
- The desktop and Pi receive no Google credential and no MCP URL.
- Divo resolves `connectionId`, sharing grants, RBAC action, approval policy,
  and audit before constructing the sidecar request.
- The adapter authenticates with the resolved connection's OAuth bearer token.
  The sidecar derives the Google identity from that token; native tool input
  never carries `user_google_email` or another caller-selected identity field.
- The upstream `start_google_auth` tool is not in Divo's reviewed manifest.
- Local paths and `file://` inputs are blocked. Use base64 or HTTPS inputs.

## Runtime

Compose starts `ghcr.io/taylorwilsdon/google_workspace_mcp:1.22.0` with OAuth
2.1 external-provider mode and stateless mode. In Docker, the backend uses
`GOOGLE_WORKSPACE_MCP_URL=http://google-workspace-mcp:8000/mcp`. A backend
running directly on the host uses the loopback-only published endpoint at
`http://127.0.0.1:18000/mcp` by default.

The sidecar uses the same Google OAuth client metadata as Divo:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

The user must reconnect an older Google connection before calling products for
which its stored grant lacks scopes. Scope denial fails before the MCP call and
never falls back to a direct Google client.

## Catalogue and skills

`scripts/seed-registered-tools.ts` creates missing product catalogue rows.
`pnpm provision:google-workspace-skills` creates the company-global Google
Workspace folder and one company-granted governed skill per product. The
manifest, generated runtime tools, runner allowlist, seed rows, and system skill
definitions share the same product list to prevent drift.
