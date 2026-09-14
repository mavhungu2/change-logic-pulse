# Multi-Tenant Pulse Surveys

Skeleton only — no domain logic yet. See [CLAUDE.md](./CLAUDE.md) for the constraints
this project is built under.

## Prerequisites

- Node.js 20+ (developed on 25.1.0)
- Docker Desktop

## Run locally from a clean clone

```bash
cp .env.example .env
npm install
npm --prefix web install
npm run db:up          # PostgreSQL 18 on host port 5433
```

Then, in two terminals:

```bash
npm run start:dev      # API on http://localhost:3000
npm run web:dev        # React app on http://localhost:5173
```

The API currently exposes no routes, so `/` returns 404. That is expected.

> **Host port 5433, not 5432.** A natively installed PostgreSQL commonly holds 5432.
> Override with `POSTGRES_HOST_PORT` in `.env` if 5433 is taken as well.

## Layout

```
src/            NestJS API (ESM, TypeScript strict)
web/            React app (Vite)
prisma/         schema; migrations land here
docker/initdb/  database role setup, run once on first boot
test/           test suite
```

## Database roles

Two roles, created by `docker/initdb/01-roles.sh` on first boot:

| Role | Used by | Owns tables | BYPASSRLS |
|---|---|---|---|
| `pulse_owner` | Prisma CLI — `migrate`, `db push` | yes | no |
| `pulse_app` | the API at runtime | **no** | no |

The split is what makes Row-Level Security trustworthy: a table's owner silently
bypasses its own RLS policies, so the application must never connect as the owner.
Neither role is a superuser.

This maps onto two connection strings that never meet:

- `MIGRATION_DATABASE_URL` — read by `prisma.config.ts`, used by the Prisma CLI only
- `DATABASE_URL` — used by the API at runtime

Tables created by future migrations are granted to `pulse_app` automatically via
`ALTER DEFAULT PRIVILEGES`, so no follow-up `GRANT` is needed per migration.

`pulse_owner` has `CREATEDB` because `prisma migrate dev` builds a shadow database.

### Verifying the isolation guarantee

```bash
npm run db:psql:app      # psql as the restricted role
npm run db:psql:owner    # psql as the owner
```

Once tenant tables exist they must also be set to `FORCE ROW LEVEL SECURITY`, or the
owner role will still bypass their policies during migrations and maintenance.

## Commands

```bash
npm run build            # compile the API
npm run lint             # oxlint
npm test                 # vitest
npm run db:up            # start PostgreSQL
npm run db:down          # stop it, keeping data
npm run db:nuke          # stop it and delete the volume (re-runs the role setup)
npm run prisma:migrate   # create/apply a migration as pulse_owner
```
