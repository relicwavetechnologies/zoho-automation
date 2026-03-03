# Enterprise Express Backend Template

Layered, class-based Express + TypeScript starter that enforces DTO validation, Prisma/Postgres persistence, and clean module boundaries. This template is optimized for Cursor auto-generation and follows strict architectural rules so every new feature remains consistent.

## Stack
- Node.js 20+, TypeScript
- Express 4 with modular routing
- Prisma ORM targeting PostgreSQL
- Zod for DTO validation
- JWT auth middleware + bcrypt password hashing
- ESLint + Prettier

## Project Structure
```
src/
 ├── app.ts                 # Express factory
 ├── server.ts              # Entry point
 ├── config/                # env loading + config object
 ├── loaders/               # DB + Express bootstrapping
 ├── core/                  # Base classes, ApiResponse, HttpException
 ├── middlewares/           # Auth + error handling
 ├── modules/               # Feature modules (example, user, etc.)
 ├── utils/                 # Logger, bcrypt, prisma client
 └── types/express.d.ts     # Request augmentation
prisma/schema.prisma        # Prisma schema
```

## Getting Started
1. **Install dependencies**
   ```bash
   pnpm install
   ```
2. **Configure environment**
   - Create `.env` (blocked in repo) with:
     ```
     PORT=4000
     NODE_ENV=development
     DATABASE_URL=postgresql://user:pass@host:port/db
     JWT_SECRET=changeme
     ```
3. **Setup database**
   ```bash
   pnpm prisma:generate
   pnpm prisma:push    # or pnpm prisma:migrate dev
   ```
4. **Run the API**
   ```bash
   pnpm dev
   ```

## Module Pattern
For every feature `foo`, create `modules/foo/` containing:
- `foo.controller.ts` – class with validated handlers returning `ApiResponse.success`
- `foo.service.ts` – class with business logic, no Express imports
- `foo.repository.ts` – persistence only
- `foo.routes.ts` – Router that binds controller methods
- `foo.model.ts` – entity typings
- `dto/create-foo.dto.ts` (+ any other DTOs) – Zod schemas for controller validation

## Auth Example
- `POST /api/users/register`: validates via `createUserSchema`, hashes password, stores user.
- `POST /api/users/login`: validates via `loginUserSchema`, compares hash, returns JWT.
- `auth.middleware.ts`: verifies Bearer token and attaches `req.user`.

## Error & Response Conventions
- Success responses: `ApiResponse.success(data, message?)`
- Errors: throw `HttpException(status, message)`; `error.middleware.ts` formats as `{ success: false, message }`

## Scripts
| Command | Description |
| --- | --- |
| `pnpm dev` | Run development server with ts-node-dev |
| `pnpm build` | Compile TypeScript to `dist` |
| `pnpm start` | Run compiled server |
| `pnpm lint` | ESLint over `src` |
| `pnpm prisma:generate` | Generate Prisma client |
| `pnpm prisma:push` | Push schema to DB |
| `pnpm prisma:migrate` | Run Prisma migrate dev |

## Extending
Ask Cursor to “create a module: xyz” to scaffold a new feature automatically. For additional enhancements (CLI generators, advanced Prisma setups, RBAC, etc.) request the specific add-on and follow the established architecture rules.


