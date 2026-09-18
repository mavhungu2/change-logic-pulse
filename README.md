# Multi-Tenant Pulse Surveys

Weekly pulse surveys for multiple organizations, isolated by PostgreSQL row-level
security. [CLAUDE.md](./CLAUDE.md) holds the constraints this was built under;
[SOLUTION.md](./SOLUTION.md) has the design, the trade-offs and the known gaps.

## Prerequisites

- Node.js — tested on 25.1.0. Nothing older has been exercised.
- Docker Desktop

## Run locally from a clean clone

```bash
npm run env:init       # writes .env with a generated JWT_SECRET
npm install
npm --prefix web install
npx prisma generate    # writes src/generated/ — not in git, and not created by npm install
npm run db:up          # PostgreSQL 18 on host port 5433
npx prisma migrate deploy
npm run db:seed        # two organizations, safe to re-run
```

`env:init` generates the signing key rather than copying one. `.env.example`
carries `JWT_SECRET=""` on purpose: a working key in a committed file is a
published key, and [`src/config.ts`](./src/config.ts) refuses every key that has
ever been published here — including the one this file used to ship.

`prisma generate` is a real step, not a formality: the client is generated into
`src/generated/` which is gitignored, `npm install` does not create it, and
`migrate deploy` does not either. Skip it and the seed fails with
`ERR_MODULE_NOT_FOUND`.

The seed prints what it wrote and the addresses to sign in with — there are no
passwords:

```
seeding week starting 2026-09-14

  Northwind Logistics    2 managers, 4 members, 4 responded this week (100%)
  Seabird Studios        2 managers, 5 members, 2 responded this week (40%)

sign in with any of these (no password):
  manager@northwind.test       manager
  manager2@northwind.test      manager
  member1@northwind.test       member
  manager@seabird.test         manager
  manager2@seabird.test        manager
  member1@seabird.test         member
```

The login picker offers a few more than this — the members who have not answered
yet are the interesting ones to sign in as.

Then, in two terminals:

```bash
npm run start:dev      # API on http://localhost:3000
npm run web:dev        # React app on http://localhost:5173
```

Open http://localhost:5173 and sign in as any seeded user — no password. Managers
land on the weekly summary, members on the surveys they can answer. Switching
between the two organizations is the quickest way to see the isolation: 100%
completion and an average of 4.75 against 40% and 1.5.

Two query parameters make that linkable, so both organizations can be open in two
tabs at once:

```
?as=manager@seabird.test                     sign in as a seeded user
?survey=<uuid>                               which summary a manager is reading
```

**Neither names an organization, and neither can.** The tenant is a claim in the
token the server signed, so the address bar has nothing to edit: point a Seabird
manager at a Northwind survey id and the API answers **404, not 403** — it will
not confirm the id belongs to anybody.

```
http://localhost:5173/?as=manager@seabird.test&survey=11111111-1111-4111-8111-5000000000a1
```

`?as=` carries an email, never a token — the app exchanges it through the ordinary
`POST /auth/login`, so it grants nothing the picker does not and disappears with
`ENABLE_DEV_LOGIN`. See [`web/src/url.ts`](./web/src/url.ts).

Creating and closing surveys are API-only on purpose — the two screens in the
brief were finished instead. `POST /surveys` creates one — active by default, or
`{"status":"draft"}` to hold it back until you publish it — and `PATCH
/surveys/:id` with `{"status":"archived"}` closes it, after which members are no
longer offered it and the summary stays readable. Both are covered in `test/endpoints.e2e-spec.ts`
if you would rather read the behaviour than curl it.

> **`.env.example` carries no signing key.** Copying it by hand leaves
> `JWT_SECRET=""`, and the API refuses to start on an empty one — `npm run
> env:init` is the step that fills it in, or `openssl rand -base64 48` if you
> would rather do it yourself. `src/config.ts` also rejects every key that has
> been published in this repository, including the one `.env.example` shipped
> until [`d82c9d4`](../../commit/d82c9d4). What it cannot know is that a value
> you copied from somewhere else is shared, so generate your own.

> **Host port 5433, not 5432.** A natively installed PostgreSQL commonly holds 5432.
> Override with `POSTGRES_HOST_PORT` in `.env` if 5433 is taken as well.

## Layout

```
src/            NestJS API (ESM, TypeScript strict)
web/            React app (Vite)
prisma/         schema; migrations land here
docker/initdb/  database role setup, run once on first boot
test/           test suite
scripts/        verify-rls-proof.sh — breaks each policy and requires the tests to fail
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

`npm test` is pure unit tests and needs nothing running. `npm run test:e2e` and
`npm run test:rls-mutation` both need the database **up, migrated and seeded** —
they sign in as seeded users, so against an empty database three of the five
suites fail, and only one of them says why.
