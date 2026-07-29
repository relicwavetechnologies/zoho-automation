# Legacy Google and Zoho OAuth routes accept forged identity headers

## Verdict

**Confirmed — P1 security issue.** The mounted legacy initiation routes establish the
company/user ownership for an OAuth connection from unauthenticated HTTP headers.
Neither route is protected by member or admin authentication, and no committed
application caller uses either initiation route.

## Exact evidence

- `advance-backend/src/server.ts` mounts `createGoogleAuthRoutes` at
  `/api/google/auth` and `createZohoAuthRoutes` at `/api/zoho/auth`, before the
  later `memberAuth` construction and without an auth middleware argument.
- `advance-backend/src/http/google/google-auth.routes.ts` handles
  `GET /connect` by reading `x-company-id` and `x-user-id` directly, puts them
  in the signed-by-nothing base64url state/nonce record, then persists the
  completed Google connection with `state.companyId` and `state.userId`.
- `advance-backend/src/http/zoho/zoho-auth.routes.ts` does the same for
  `GET /connect`: it reads `x-company-id` and `x-user-id`, but only carries the
  company into state and finally upserts a company Zoho connection for that
  company.
- The committed production template points both providers at these legacy
  callbacks: `.env.production.example` sets
  `GOOGLE_OAUTH_REDIRECT_URI=/api/google/auth/callback` and
  `ZOHO_REDIRECT_URI=/api/zoho/auth/callback`.
- A committed-source search finds no caller of `/api/google/auth/connect` or
  `/api/zoho/auth/connect` outside their route files, server mount, templates,
  and tests. Jan instead calls the member-authenticated
  `/api/desktop/auth/google/authorize-url` and
  `/api/desktop/auth/zoho/authorize-url` paths.

## Caller and route map

```text
No committed app caller
  -> GET /api/google/auth/connect (public; trusts x-company-id/x-user-id)
  -> Google consent
  -> GET /api/google/auth/callback (public callback)
  -> IntegrationConnectionRepository.upsertGoogleConnection(state identity)

No committed app caller
  -> GET /api/zoho/auth/connect (public; trusts x-company-id/x-user-id)
  -> Zoho consent
  -> GET /api/zoho/auth/callback (public callback)
  -> ZohoConnectionRepository.upsertFromExchange(state.companyId)

Actual desktop callers
  Jan commands.rs -> /api/desktop/auth/{google,zoho}/authorize-url (memberAuth)
  -> /api/desktop/auth/{google,zoho}/callback (signed state)
```

## Failure/security scenario

An unauthenticated attacker can request either legacy `/connect` URL with a
victim company ID (and any user ID for Google), complete consent for the
attacker's own provider account, and cause its token to be stored under the
victim company. For Google this creates a user-owned connection attributed to
the forged user ID; for Zoho it replaces/creates the victim company's shared
connection. The nonce only binds the callback to the attacker-created request;
it does not authenticate the request identity.

## Smallest sound correction

Remove the two orphaned legacy route mounts and their redirect-URI entries after
confirming the provider consoles use the desktop callbacks. This keeps one
supported flow per provider: the existing member-authenticated desktop router.
Because removal changes externally registered callback URLs, first update the
provider registrations/deployment secret values to
`/api/desktop/auth/google/callback` and `/api/desktop/auth/zoho/callback`.

If compatibility must be retained temporarily, mount each legacy `/connect`
behind `memberAuth` and derive company/user only from `res.locals`; do not
accept identity headers. That is a bridge, not the preferred final shape because
it leaves duplicate OAuth surfaces alive.

## Regression tests

1. Assert the server no longer mounts `/api/google/auth` and
   `/api/zoho/auth`, and the production template contains only desktop callback
   paths.
2. For the retained desktop Google and Zoho initiation routes, verify a request
   without a member JWT is rejected and a valid member JWT produces state whose
   company/user equal the session claims.
3. If a temporary compatibility route is kept, prove forged
   `x-company-id`/`x-user-id` values cannot change the state identity.
