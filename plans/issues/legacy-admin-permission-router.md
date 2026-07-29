# Legacy `/admin` permission router: unauthenticated, unreferenced, but not full parity

## Status / verdict

**Open — P1 application-level authorization defect. Migrate the one missing coarse company-tool writer, then remove the legacy router. Production exposure depends on whether clients can reach the backend port directly.**

The committed server still mounts `createAdminPermissionRoutes` at `/admin` without `adminAuth` (`advance-backend/src/server.ts:288-306`). All seven routes therefore accept a caller-supplied company, department, role, and optional `x-actor-id` with no authentication or tenant authorization. The committed application, Jan desktop, scripts, docs, and deployment configuration contain no request caller for `/admin/companies/...`; only the router's unit tests exercise it. It is a dead public surface in committed code, not a safe complete duplicate: the current authenticated APIs do **not** provide a write for the coarse `ToolPermission.enabled` company ceiling.

Creating `adminAuth` later in `server.ts` does not protect an earlier Express
mount, and there is no Basic Auth middleware on this router. The admin SPA uses
Bearer admin JWTs for `/api/admin/*`; it does not supply HTTP Basic Auth to this
legacy surface.

## Evidence

- The legacy router is the only `/admin` mount (`advance-backend/src/server.ts:288-306`), and it appears before `adminAuth` is constructed at `advance-backend/src/server.ts:357-363`.
- It trusts `:companyId` and derives the audit actor from the untrusted `x-actor-id` header, defaulting to `system` (`advance-backend/src/http/admin/permission.routes.ts:61-63`). Its company-tool write persists the supplied company/role directly (`:128-163`); its department read does not verify the department belongs to the supplied company (`:203-220`); its cache endpoints are likewise unauthenticated (`:259-273`).
- Authenticated replacements are deliberately mounted with `adminAuth`: department administration at `advance-backend/src/server.ts:559-568` and company administration at `:587-598`. The desktop management surface applies member auth to every tools route (`advance-backend/src/http/desktop/desktop-tools.routes.ts:75-101,254-270`).
- The desktop is the committed active writer: Jan invokes the authenticated global action route (`jan/src-tauri/src/core/divo/commands.rs:2300-2320`) and authenticated department role action route (`:2322-2346`). Those map to `PermissionWriteService`, which validates the live role/target and audits/invalidates (`advance-backend/src/application/desktop/desktop-tool-access.service.ts:481-521`; `advance-backend/src/application/permissions/permission-write.service.ts:35-66`).
- The gap is real. `DesktopToolAccessService` still reads `ToolPermission.enabled` as the company tool gate (`advance-backend/src/application/desktop/desktop-tool-access.service.ts:106-121`) and refuses an action write when that coarse gate is false (`:481-498`), but current desktop routes expose only action writes (`advance-backend/src/http/desktop/desktop-tools.routes.ts:254-270`). The newer admin company API only lists raw `toolPermission` and `toolActionPermission` rows (`advance-backend/src/http/admin/company.routes.ts:981-1000`); it has no mutation route.

## Route parity

| Legacy behavior | Authenticated current surface | Parity |
| --- | --- | --- |
| `GET /admin/companies/:companyId/matrix` returns canonical tools, defaults, overrides, sources, and all built-in roles | `GET /api/admin/company/tool-permissions` returns raw stored rows only (`advance-backend/src/http/admin/company.routes.ts:981-1000`); desktop `GET /api/desktop/auth/tools/:toolId/manage?scope=global` is per-tool | Partial read parity; no committed caller needs the aggregate legacy response. |
| `PUT /admin/companies/:companyId/tools/:toolId` writes `ToolPermission.enabled` | None | **Missing parity.** This is the live coarse company ceiling used by the desktop service. |
| `PUT /admin/companies/:companyId/tools/:toolId/actions/:actionGroup` writes an action override | `PUT /api/desktop/auth/tools/:toolId/global/roles/:role/actions/:actionGroup` (`advance-backend/src/http/desktop/desktop-tools.routes.ts:254-258`) | Full functional parity, with member auth, live COMPANY_ADMIN/SUPER_ADMIN verification, registry validation, audit, and cache invalidation. |
| `GET /admin/companies/:companyId/departments/:deptId/matrix?roleId=` reads one department-role matrix | `GET /api/admin/departments/:id?sections=permissions` returns the department permission rows after company scoping (`advance-backend/src/http/admin/departments.routes.ts:174-186`; `advance-backend/src/application/departments/department-admin.service.ts:256-305`) and desktop per-tool snapshots | Partial shape parity; current reads are authenticated and scoped. No committed legacy caller. |
| `PUT /admin/companies/:companyId/departments/:deptId/tools/:toolId/actions/:actionGroup` writes a role action | Desktop exact action route (`advance-backend/src/http/desktop/desktop-tools.routes.ts:260-264`); admin department route also writes role actions (`advance-backend/src/http/admin/departments.routes.ts:340-349`) | Full functional parity; current paths verify the actor and target department/role. |
| `POST /admin/companies/:companyId/cache/invalidate` | No standalone route; every current permission write invalidates company cache (`advance-backend/src/application/permissions/permission-write.service.ts:40-49`) | Intent covered by writes. No committed manual-invalidation caller. |
| `POST /admin/companies/:companyId/departments/:deptId/cache/invalidate` | No standalone route; every current department write invalidates department cache (`advance-backend/src/application/permissions/permission-write.service.ts:57-66`) | Intent covered by writes. No committed manual-invalidation caller. |

## Committed caller search results

At commit `e9dd905ec5ac79d2212faf915181f3261f4c79ca`, exact searches for every legacy route template found only `advance-backend/src/http/admin/permission.routes.ts` and `advance-backend/tests/http/admin-permission.routes.test.ts`; exact searches for `/admin/companies/` and `admin/companies` found no committed caller. The only `/admin` mount is the server mount above.

| Scope searched | Result |
| --- | --- |
| Admin UI | No legacy caller; it calls authenticated `/api/admin/departments/.../role-permissions/...` (`admin/src/lib/api.ts:593-617`). |
| Jan | No legacy caller; it calls the authenticated desktop action routes cited above. |
| Backend | The legacy mount, route implementation, and route-local unit tests only. |
| Tests | `advance-backend/tests/http/admin-permission.routes.test.ts:163-422` directly instantiates the router; it does not test server-level authentication. |
| Scripts, docs, deploy/CI config | No legacy endpoint caller. The committed Nginx host proxies `/api/` and `/webhooks/`, but sends `/admin/...` to the admin SPA; Docker Compose separately publishes the backend port. The migration document names only the current read API (`docs/features/03-backend-migration.md:39`). |

## Deployment boundary

The committed development Nginx configuration does **not** expose this route
through the normal application hostname: `infra/development/nginx/app-dev.conf`
proxies `/api/` and `/webhooks/` to the backend, while its catch-all `/` goes
to the admin SPA. That is routing, not authentication, and it is not an
application-level guarantee.

`docker-compose.yml:28-29` publishes the backend as
`${DIVO_BACKEND_PORT:-3001}:3001` without a loopback-only bind. The repository
contains no Basic Auth or firewall rule protecting that published port.
Therefore the defect is confirmed in Express; whether it is Internet-reachable
in a particular deployment requires checking the host firewall, security
group, load balancer, and actual port binding.

## Concrete risk

Any client that can reach the backend listener directly can read company and
department permission configuration, toggle a company tool, toggle a company
action, grant a department role action, or flush permission caches. A caller
can choose another tenant's IDs and forge audit attribution. The action and
department writes reach the shared persistence writer, so this is an
authorization-policy mutation path, not merely stale documentation.

## Smallest correction

1. Add one authenticated, company-admin-only coarse company-tool setter to the existing desktop tools surface. It must validate a registered configurable tool and live role, persist `ToolPermission.enabled`, invalidate the company cache, and audit the real authenticated actor. Do not reuse request `updatedBy` or a header as authority.
2. Delete `advance-backend/src/http/admin/permission.routes.ts`, its import/mount and per-request `PermissionWriteService` construction in `advance-backend/src/server.ts`, and its route-only test file. Do not delete `ToolPermission` rows or its repository: current runtime reads them.

This is **migrate missing operation then remove**, not retain-and-secure: adding auth to the legacy path would preserve an unscoped duplicate authority and its deprecated contract. It is also not immediate removal because a `ToolPermission.enabled = false` row currently blocks the authenticated action setter, leaving no supported recovery path after deletion.

### Production-row inventory / approval

Deleting the HTTP router does not delete or transform permission data, so a row inventory is **not mechanically required for data preservation**. It is required before treating the missing coarse writer as harmless: inventory `ToolPermission` by `companyId`, `toolId`, `role`, and `enabled`, especially `enabled = false`, and identify any operations run against `/admin/companies/*` from access logs/API-gateway telemetry. Existing false rows prove the replacement must support re-enabling before the legacy route is removed; a zero-row inventory does not make the unauthenticated endpoint safe to retain.

Source deletion changes a public route and removes intentional legacy code, so explicit deletion/deprecation approval is required under `AGENTS.md`. No schema/data migration approval is needed unless the inventory proposes changing or deleting existing rows.

## Tests for the correction

- Server-level regression: unauthenticated requests to every removed `/admin/companies/...` endpoint return 404 (or are absent from routing), including writes.
- New coarse setter: 401 without member auth; 403 for a non-company-admin; 400 for fixed, unknown, unregistered tool or invalid company role; successful disable and re-enable persist the row, invalidate cache, and audit `res.locals.userId`.
- Existing `enabled = false` row: the new setter can re-enable it and the current global action setter succeeds afterwards.
- Preserve the existing authenticated global and department action tests, including cross-company/department target rejection.

## Inspection commands actually run

```sh
sed -n '1,240p' AGENTS.md
git status --short
git rev-parse HEAD
git grep -n "createAdminPermissionRoutes" e9dd905ec5ac79d2212faf915181f3261f4c79ca
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/http/admin/permission.routes.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/server.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:docker-compose.yml | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:infra/development/nginx/app-dev.conf | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/http/middleware/admin-auth.middleware.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/http/admin/company.routes.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/http/admin/departments.routes.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/http/desktop/desktop-tools.routes.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/application/desktop/desktop-tool-access.service.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/application/permissions/permission-write.service.ts | nl -ba
git show e9dd905ec5ac79d2212faf915181f3261f4c79ca:advance-backend/src/application/departments/department-admin.service.ts | nl -ba
git grep -n -E '(/admin/companies|/api/admin/company/tool-permissions|/api/admin/departments|/tools/.+/(global|departments).+/actions)' e9dd905ec5ac79d2212faf915181f3261f4c79ca -- admin jan advance-backend pi pi-bridge scripts docs .github docker-compose.yml Dockerfile
for p in 'companies/:companyId/matrix' 'companies/:companyId/tools/:toolId' 'companies/:companyId/departments/:deptId/matrix' 'companies/:companyId/departments/:deptId/tools/:toolId/actions/:actionGroup' 'companies/:companyId/cache/invalidate' 'companies/:companyId/departments/:deptId/cache/invalidate'; do git grep -nF "$p" e9dd905ec5ac79d2212faf915181f3261f4c79ca -- .; done
```

Validation: source tests not run (analysis-only issue report; no source change
requested). Markdown diff checks passed.
