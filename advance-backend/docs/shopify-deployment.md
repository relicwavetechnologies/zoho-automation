# Shopify deployment

The backend endpoint alone does not register Shopify webhooks. Registration is
owned by the Shopify app configuration associated with the same client ID used
by `SHOPIFY_CLIENT_ID`.

1. Run `shopify app config link` and select the real Partner app.
2. Merge the `[webhooks]` section from `shopify.app.toml.example` into the
   generated `shopify.app.toml`.
3. Set its API version to the same stable version as `SHOPIFY_API_VERSION`.
4. Deploy the app configuration with `shopify app deploy`.
5. Verify the public HTTPS URL routes `/webhooks/shopify` to this backend.

Production enables aggregate `shopifyAnalytics` with `read_reports`.
`shopifyOrders` and `shopifyCustomers` remain absent unless
`SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED=true`; production startup then requires
both `read_orders` and `read_customers`. The production allowlist rejects every
other scope; `read_all_orders` is optional only when Shopify has separately
approved historical-order access. Grant each Divo tool separately through RBAC.
Protected reads cannot enter durable approval payloads: either grant the read
capability directly or deny it. Their Pi sessions, durable traces, Lark room
snapshots, and progress transcript are redacted, deleted, or suppressed by the
centralized protected-data path.
6. Trigger each topic in a non-production store and verify HMAC rejection,
   durable deduplication, uninstall revocation, and shop erasure.
7. Before enabling protected tools, exercise the data-request export, external
   delivery acknowledgement, customer redaction, shop redaction, retention
   sweep, and exact-session deletion against the deployed environment.

The delivery-acknowledgement endpoint records an authorized administrator's
external-provider receipt evidence. It hashes recipient and receipt identifiers
before audit storage, but it does not independently contact the recipient or
provider; operations must verify the provider receipt before acknowledging it.

Never commit the real app client secret or store access tokens. A local TOML
file is not proof of registration; the deployed Partner app version is the
authority.
