# RBAC Migration Runbook

## Forward Migration
1. Ensure environment variables are set (`DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `APP_BASE_URL`).
2. Run Prisma migration:
   - `pnpm prisma migrate dev --name rbac_org_rbac_invites`
3. Generate Prisma client:
   - `pnpm prisma generate`
4. Seed system roles (auto-seeded at startup).
5. Backfill users without org membership:
   - `pnpm ts-node scripts/backfill-org-memberships.ts`
6. Start service and verify:
   - `/health`
   - `/auth/google/start`
   - `/session/bootstrap`

## Rollback Notes
1. Stop writes to the backend.
2. Roll back app deploy first.
3. Restore database from pre-migration snapshot.
4. Re-run previous backend version only after DB restore is complete.

## Verification Checklist
- OAuth exchange succeeds and maps user.
- Onboarding creates org + owner membership in one transaction.
- Invite create/accept lifecycle updates audit logs.
- Admin role/tool changes produce audit logs.
- Zoho integration endpoints enforce one integration row per org/provider.
- Policy checks and capability bootstrap reflect role + overrides.
