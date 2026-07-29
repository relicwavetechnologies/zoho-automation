# Admin OAuth callback page targets missing Lark and Google handlers

## Verdict

**Confirmed — P2 dead/broken integration surface.** The admin SPA
registers Lark and Google OAuth callback pages, but both pages POST to backend
paths that do not exist in the committed company router. Zoho is the only one
of the three callback mappings with a matching handler.

## Exact evidence

- `admin/src/app/App.tsx` registers `/zoho/callback`, `/lark/callback`, and
  `/google/callback` with `OAuthCallbackPage`.
- `admin/src/pages/OAuthCallbackPage.tsx` maps those providers respectively to
  `/api/admin/company/onboarding/connect`,
  `/api/admin/company/onboarding/lark-connect`, and
  `/api/admin/company/onboarding/google-connect`.
- `advance-backend/src/http/admin/company.routes.ts` documents and implements
  `POST /onboarding/connect` (Zoho), plus `POST /onboarding/lark-start`; it has
  no `lark-connect`, `google-connect`, or Google-start route. A committed
  search finds `lark-connect` and `google-connect` only in the SPA mapping.
- `advance-backend/src/server.ts` mounts this router at
  `/api/admin/company` behind `adminAuth`, so a callback to either missing
  endpoint resolves to a protected 404 rather than completing OAuth.
- The committed production template points Lark and Google at backend callbacks
  (`/api/lark/auth/callback` and `/api/google/auth/callback`), not the SPA
  callback pages. Thus the two SPA routes have no committed initiation/config
  caller today, but fail deterministically if a provider is configured to use
  them.

## Caller and route map

```text
Admin SPA route /lark/callback
  -> OAuthCallbackPage(provider="lark")
  -> POST /api/admin/company/onboarding/lark-connect  [no handler: 404]

Admin SPA route /google/callback
  -> OAuthCallbackPage(provider="google")
  -> POST /api/admin/company/onboarding/google-connect [no handler: 404]

Admin SPA route /zoho/callback
  -> OAuthCallbackPage(provider="zoho")
  -> POST /api/admin/company/onboarding/connect       [implemented]

Committed provider configuration for Lark/Google
  -> backend legacy callbacks, not these SPA pages
```

## Failure scenario

If a company admin uses a Lark or Google OAuth URL whose registered redirect is
the corresponding admin SPA callback, the page reads the returned code and
state, then submits them to a nonexistent API. It shows “OAuth callback failed”
and the provider token is never exchanged or stored. The broken pages also make
the intended ownership of those flows ambiguous beside the active backend and
desktop callbacks.

## Smallest sound correction

Choose one owner for admin OAuth completion. The smallest correction, given no
committed SPA initiation/config caller for Lark or Google, is to remove their
two stale SPA callback routes and mappings, leaving only Zoho's implemented
callback. If admin-owned Lark/Google onboarding is required instead, add
matching authenticated completion endpoints with the same nonce/state
validation and provider-account binding as the existing supported flows, then
add a committed initiation caller before registering the frontend callbacks.

## Regression tests

1. Add an SPA route/mapping test that every `OAuthCallbackPage` provider maps
   to an actually mounted backend endpoint.
2. If retaining Lark/Google admin callbacks, integration-test successful POSTs
   through the authenticated company router and rejection of absent/expired
   state; otherwise assert the two frontend routes are absent.
3. Keep the existing Zoho callback test and verify its route remains
   `/api/admin/company/onboarding/connect`.
