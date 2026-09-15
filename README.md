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
npx prisma migrate deploy
npm run db:seed        # two organizations, safe to re-run
```

The seed prints the addresses to sign in with — there are no passwords:

```
manager@northwind.test   member1@northwind.test    Northwind Logistics — 4 members, 100% responded
manager@seabird.test     member1@seabird.test      Seabird Studios     — 5 members,  40% responded
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

There is deliberately **no** `ALTER DEFAULT PRIVILEGES`: a blanket default would grant
the app role DML on every table a migration ever creates, including Prisma's own
`_prisma_migrations` and any future table whose policies nobody has written yet. Each
table is granted explicitly in the migration that creates it, so what the app can do is
answerable by reading one file. Today that is `SELECT` on `organizations` and `users`,
`SELECT, INSERT` on the rest, and no `UPDATE` or `DELETE` anywhere.

`pulse_owner` has `CREATEDB` because `prisma migrate dev` builds a shadow database.

### Verifying the isolation guarantee

```bash
npm run db:psql:app      # psql as the restricted role
npm run db:psql:owner    # psql as the owner
```

Every tenant table carries `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, so the policies
bind the owner role too — without `FORCE`, a table's owner silently bypasses its own
policies. Scoped to nothing, the app role sees nothing:

```sql
-- as pulse_app, no tenant context
SELECT count(*) FROM surveys;                                  -- 0

BEGIN;
SELECT set_config('app.current_org_id', '<an org id>', true);
SELECT count(*) FROM surveys;                                  -- that org's surveys
COMMIT;

SELECT count(*) FROM surveys;                                  -- 0 again
```

The GUC is transaction-local, so the last query is the important one: a pooled
connection carries nothing into the next request.

A new tenant table is not finished until it has `ENABLE`, `FORCE`, four policies and its
own `GRANT`, all in the migration that creates it. There is no default privilege to fall
back on.

## Commands

```bash
npm run build            # compile the API
npm run lint             # oxlint
npm test                 # vitest
npm run db:up            # start PostgreSQL
npm run db:down          # stop it, keeping data
npm run db:nuke          # stop it and delete the volume (re-runs the role setup)
npm run prisma:migrate   # create/apply a migration as pulse_owner
npm run db:seed          # idempotent; re-running converges rather than duplicating
npm run test:e2e         # RLS proof, bypass attempts, endpoint behaviour
npm run test:rls-mutation  # breaks each policy in turn and requires the suite to fail
```
