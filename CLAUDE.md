# Multi-Tenant Pulse Surveys — Agent Instructions

Take-home assignment: a minimal, production-quality vertical slice of a multi-tenant
SaaS for weekly pulse surveys. **Timeboxed to ~4 hours.** Depth over breadth.

> This file is itself a graded deliverable — the assignment requires the agent
> instructions file to be committed and to reflect this project's constraints.
> Keep it accurate as decisions change.

---

## 1. Hard Constraints

These are not negotiable. Do not "improve" past them.

| Constraint | Rule |
|---|---|
| Stack | TypeScript, NestJS, PostgreSQL, React. No substitutions. |
| Runs locally | No external identity providers. No paid cloud services. `docker compose up` + one command to seed. |
| Tenancy | A user belongs to **exactly one** organization. No multi-org membership. |
| Roles | Exactly two: `Manager`, `Member`. No admin tier, no custom permissions. |
| Isolation | Enforced by **PostgreSQL RLS**. Data from one org must not be reachable from another. Single most important property in the build. |
| Survey size | Maximum **3 questions** per survey. Enforce it. |
| Question types | `rating` (1–5) and `yes_no`. Nothing else. |
| Response cadence | One response per member, per survey, per active week. |
| Scope | Smallest end-to-end happy path first. Ship a complete thin slice, not a wide unfinished one. |

### Explicitly out of scope

Password reset, email, real SSO/OIDC, org self-signup, survey scheduling, charting
libraries, notifications, pagination, i18n, dark mode, Kubernetes, CI/CD pipelines,
role management UI, soft deletes, audit logs.

If something feels missing, it goes in **SOLUTION.md → Known gaps**, not into the code.

---

## 2. Decisions Already Made

The brief offers flexibility "to reduce decision churn". These are settled — implement
them, don't relitigate them. Each must be restated with its rationale in SOLUTION.md.

### "This week" = ISO calendar week (Monday start, UTC)

Chosen over a rolling 7-day window because it makes the one-response-per-week rule a
**database constraint** rather than application logic:

```sql
UNIQUE (survey_id, user_id, week_start)
```

A rolling window has no stable key, so "already responded this week" would depend on
read time and could not be enforced by the database. Store `week_start` as a `DATE`.

### Tenant isolation = PostgreSQL Row-Level Security

Isolation is enforced by the **database**, not by application `where` clauses.

Rationale to record in SOLUTION.md: an app-layer filter is only as good as the last
developer who remembered to write it. RLS makes the guarantee structural — a forgotten
scope, a raw query, an ORM `findMany` with no filter, or future code that knows nothing
about tenancy still cannot read across tenants. The isolation survives the code.

This is the highest-risk part of the build. The failure modes below are not theoretical;
each one produces a system that *looks* isolated and is not.

#### Non-negotiable RLS rules

1. **The app's database role must not own the tables and must not have `BYPASSRLS`.**
   Owners bypass RLS silently. Two roles: a migration/owner role, and a restricted
   `app_user` role the API connects as. Additionally set `FORCE ROW LEVEL SECURITY` on
   every tenant table — **except `users`**, which carries `ENABLE` without `FORCE`.
   The reason is login: `POST /auth/login` arrives with an email and no tenant context,
   because the lookup is what *establishes* the context, so it cannot be scoped. The
   usual remedy — a narrow `SECURITY DEFINER` function — does **not** survive `FORCE`:
   a definer function is still subject to the policy and returns zero rows. So `users`
   keeps `ENABLE` only, and the sole unscoped path is `auth_lookup(email)`, a
   `SECURITY DEFINER` function owned by the migration role that returns nothing but
   `{ userId, orgId, role }`. `app_user` is granted `EXECUTE` on that function and
   still reads zero rows from `users` directly. One hole, narrow, and named.
2. **Transaction-scoped, never session-scoped.** A bare `SET` persists on the pooled
   connection and leaks the previous request's tenant to the next one — a cross-tenant
   data breach that no test catches unless it is looked for.
   Set it with **`set_config('app.current_org_id', $1, true)`**, where the third
   argument is `is_local`. Not `SET LOCAL`: that is the same semantics but cannot take
   a bind parameter (`PREPARE … AS SET LOCAL …` is a syntax error), so following it
   literally means interpolating a string into SQL — on the one value that decides
   tenancy. `set_config` is transaction-local *and* parameterised.
3. **Every tenant-scoped query runs inside a transaction** that has already applied
   `app.current_org_id`. No exceptions, no "just this one read".
4. **Policies must cover `SELECT`, `INSERT`, `UPDATE` and `DELETE`.** An `INSERT` policy
   without `WITH CHECK` lets a tenant write rows into another tenant's org.
5. **Fail closed — and guard the cast.** Use
   **`NULLIF(current_setting('app.current_org_id', true), '')::uuid`**. The `true`
   suppresses the error when the setting is absent, but it yields `NULL` only until the
   GUC is first set: once a transaction that set it commits, the setting reverts to the
   **empty string**, not to `NULL`, for the remaining life of that pooled connection.
   Unguarded, `''::uuid` then raises `invalid input syntax for type uuid` instead of
   matching no rows — so the second request on a reused connection 500s, and the
   fail-closed test passes or fails depending on connection reuse. `NULLIF` is
   load-bearing, not defensive. Never write a policy that is permissive when the
   setting is absent.
6. The GUC value comes from the **verified token only** — never from a request body,
   query string, header, or route param.

#### Plumbing

`AsyncLocalStorage` holds the request's `TenantContext { userId, orgId, role }`, set by
the auth guard. A single database wrapper (a Prisma client extension, or a TypeORM
`QueryRunner` helper) opens the transaction and applies the GUC for every operation.
Application code must not be able to reach the database without going through it.

Application-layer scoping is still written where it is natural — RLS is the backstop
that makes a mistake there non-fatal, not a licence to skip it.

### Local auth = dev-only JWT over seeded users

`POST /auth/login` accepts a seeded user's email, returns a signed JWT carrying
`{ sub, orgId, role }`. A guard verifies it. No password, no IdP.

This keeps the real shape of authorization (claims → guard → context) without an IdP.
Mark the endpoint clearly as development-only in code and in SOLUTION.md.

### Completion-rate denominator

"Completion rate relative to the number of members in that organization" is ambiguous.
**Default: count users in that org with role `Member`** — Managers author surveys, they
are not the responding population. Flag this reading explicitly in SOLUTION.md.

---

## 3. Data Model

Keep it this shape unless there is a concrete reason to deviate — and record the reason.

```
organizations  id, name, logo_url?
users          id, org_id→organizations, email UNIQUE, name, role('manager'|'member')
surveys        id, org_id→organizations, title, status('draft'|'active'|'archived'), created_by→users
questions      id, survey_id→surveys, text, type('rating'|'yes_no'), position   -- max 3 per survey
responses      id, survey_id, user_id, org_id, week_start DATE, submitted_at
               UNIQUE (survey_id, user_id, week_start)
answers        id, response_id→responses, question_id→questions,
               question_type,                  -- denormalised; see below
               rating_value SMALLINT NULL, bool_value BOOLEAN NULL
               CHECK (num_nonnulls(rating_value, bool_value) = 1)
               CHECK: the populated column matches question_type
               FK (question_id, question_type) → questions (id, type)
```

`answers.question_type` is denormalised deliberately. "The value matches the
question's type" cannot be a plain `CHECK`, because Postgres rejects subqueries in check
constraints, so a constraint on `answers` cannot consult `questions`. Copying the type
down and pinning it with the composite FK above makes the invariant a constraint again
rather than a service-layer convention — the copy cannot drift, because the FK requires
it to match the question's own row.

Push invariants into the schema wherever possible — unique constraints, `NOT NULL`,
`CHECK`, FKs. Application validation is the second line of defence, not the first.

---

## 4. Required Endpoints

Minimum surface to satisfy both UI flows:

```
POST /auth/login                      dev-only, seeded email → JWT
GET  /me                              current user + org + role

GET  /surveys/active                  Member: their org's active survey + questions
POST /surveys/:id/responses           Member: submit; 409 if already responded this week

POST /surveys                         Manager: create (≤3 questions)
GET  /surveys                         Manager: own org's surveys
GET  /surveys/:id/summary?week=YYYY-MM-DD    Manager: weekly rollup
```

Summary response shape:

```jsonc
{
  "weekStart": "2026-09-14",
  "completedCount": 4,
  "eligibleCount": 6,
  "completionRate": 0.667,
  "questions": [
    { "id": "...", "type": "rating", "average": 3.75, "count": 4 },
    { "id": "...", "type": "yes_no", "counts": { "yes": 3, "no": 1 } }
  ]
}
```

A request for a survey in another org returns **404, not 403** — do not confirm the
existence of another tenant's resources.

---

## 5. React App — Minimal

Two flows only. Plain components and `fetch`; no component library, no state-management
library, no charts.

- **Member** — view org's active survey, submit a response, see a confirmation and the
  already-responded state on return
- **Manager** — view the weekly summary for a survey
- **Login** — pick a seeded user from a dropdown. That is sufficient.

Loading and error states are required on every async call — including the 409
already-responded case, which is a normal outcome and not a crash.

---

## 6. Seed Data — Proves Isolation

Seeding is a correctness feature here, not a convenience. It must make the isolation
claim demonstrable in the video:

- **At least 2 organizations** with visibly distinct names
- Per org: 1 Manager, 3+ Members
- Per org: 1 active survey using **both** question types
- Enough submitted responses in the current week that summaries show non-trivial numbers
- The two orgs' numbers must differ, so a swap between users is obviously a different
  dataset and not a cached screen

Idempotent: re-running the seed must not duplicate rows.

The seed runs on the **migration/owner connection**, not as `app_user`. It writes across
both organizations, which is exactly what RLS exists to forbid, and creating an
organization has nowhere to take a tenant context from — the row being inserted *is* the
tenant. This is why the seed belongs to Dev 2 alongside the rest of the data layer (§8),
and why it is not evidence that the wrapper can be bypassed: the seed is not the
application.

---

## 7. Workflow

### Plan before code — and commit the plan

Write a short spec/plan file and **commit it before the implementation commits**. The
assignment grades that the plan exists and that the code follows it. Keep it brief.

### Read the installed docs, not memory

Check the actual installed versions before writing framework code. NestJS, Prisma/TypeORM
and React have all moved; assumptions from memory cause silent breakage. Use latest
stable versions for new dependencies.

### Code standards

Generic principles are worth nothing here; these are the specific applications that
matter in this codebase.

#### DRY — the four things that must exist exactly once

1. **The week calculation.** Converting "now" to an ISO `week_start` is needed by
   response submission, the summary query, and the seed. Three copies means three ways
   to disagree about what week it is. One utility, used everywhere, unit-tested.
2. **The tenant-scoped database wrapper.** Every duplicate of this logic is a path that
   can forget the GUC. One wrapper, and nothing reaches the database around it.
3. **The summary response shape.** Defined once as a shared type consumed by both the
   API and the React app, so a field rename cannot silently break the UI.
4. **Question-type behaviour.** `rating` and `yes_no` differ in validation, storage
   column, and rollup maths. Express that as one type-keyed registry — not as
   `if (type === 'rating')` scattered across three layers. Adding a third type later
   should touch one table, not five files.

#### SOLID — as it applies here

- **Single responsibility.** Controllers do HTTP. Services do domain logic. The tenancy
  layer does tenancy. A controller reaching for Prisma directly is a bug, not a shortcut.
- **Open/closed.** The question-type registry above is the concrete case: new types are
  new entries, not edits threaded through existing branches.
- **Interface segregation.** Domain services do not receive the whole `PrismaClient`.
  They receive narrow repository interfaces exposing only what they need.
- **Dependency inversion.** Domain code depends on a data-access interface, never on
  Prisma concretely. This is not academic — it is what makes the RLS wrapper structurally
  impossible to bypass, and what makes the summary maths testable without a database.

#### Everything else

- **No dead code** — no commented-out blocks, no unused imports, no speculative
  abstractions, no "might need this later"
- **Declarative** — expressions over statements, data-driven over imperative
- **Loading and error states** on every async operation, including the 409
  already-responded case
- **Errors carry meaning** — a rejected response tells the caller why; never a bare 500

#### When removing or changing something, check every layer

A change is not done until all five have been checked:
migration and schema → RLS policy → service → shared types → React.
Dropping a column without dropping its policy leaves a policy referencing nothing.

### Validation — this is assessed

Do not trust generated output. For each change: run it, exercise the actual flow, read
the SQL the ORM emits for tenant-scoped queries. Record in SOLUTION.md what was checked,
what was **rejected or rewritten**, and how correctness was established. At least one
concrete correction must be shown in the video, so keep a note when one happens.

### Tests — thin but pointed

Full coverage is not the goal in 4 hours. These must exist:

1. **Cross-tenant isolation (API)** — a user from org B cannot read or mutate org A's
   survey, responses, or summary. This is the headline test.
2. **RLS proof (database)** — connect directly as `app_user`, set the GUC to org A, and
   assert a plain `SELECT * FROM surveys` returns **only** org A's rows. This test must
   bypass the application entirely; it is the only thing that proves the policies, rather
   than the service layer, are doing the work.
3. **RLS fails closed** — with no GUC set, the same query returns zero rows. Assert it
   in *both* unset states: a connection that has never set the GUC (`NULL`) and one that
   set it in an earlier, committed transaction (empty string). Only the second catches a
   missing `NULLIF`, and only the second resembles production.
4. **No connection-pool leakage** — run two sequential requests as different orgs over
   the same pool and assert the second sees only its own data. This is the test that
   catches a session-scoped `SET` where `is_local` was meant.
5. **Write containment** — an `INSERT`/`UPDATE` attempting to place a row in another
   org's `org_id` is rejected by the `WITH CHECK` policy.
6. **Duplicate response** — second submission in the same week is rejected.
7. **Summary maths** — rating average/count and yes/no counts against a known fixture.

Before trusting any of these: temporarily disable one policy and confirm the isolation
test **fails**. A test that passes against a broken policy is proving nothing, and RLS
misconfiguration usually presents as everything looking fine.

---

## 8. Multi-Agent Workflow

Operate as a team. The partition below is by **file ownership**, so agents can run
concurrently without colliding.

This structure is also material for SOLUTION.md: Task 4 asks how the work was broken
down and what was delegated versus kept. A deliberate partition answers that directly.

### Main thread — context and orchestration

Does not write production code. Responsibilities:

- Owns `CLAUDE.md`, `SPEC.md`, and every decision in §2
- **Defines the tenancy interface contract before delegating**, so domain work can be
  written against it while it is still being implemented
- Partitions work, resolves cross-boundary questions, prevents file conflicts
- Final synthesis: acceptance criteria, SOLUTION.md, release readiness

### Dev 2 (principal / tech lead) — tenancy and data layer

Takes the highest-risk work, because it is the part where a subtle mistake is invisible.

| Owns | `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/seed.ts`, RLS policy SQL, `src/tenancy/**`, `src/auth/**` |
|---|---|

Delivers the schema with constraints pushed into it, the RLS policies, the role
separation, the `AsyncLocalStorage` + transaction wrapper, and the seed — which needs the
owner connection for the reason given in §6.

Standards are non-negotiable: no dead code, no unnecessary complexity, declarative and
data-driven over imperative, DRY enforced before the second copy exists. Dev 2 is an
opinionated reviewer and should challenge any approach that trades long-term
maintainability for short-term convenience — including decisions in this file.

Reports: what was implemented, patterns applied, **what was rejected and why**, risks.

### Dev — domain and UI

| Owns | `src/surveys/**`, `src/responses/**`, `src/summary/**`, `web/**` |
|---|---|

Builds the endpoints, summary query, and the two React flows. Codes against the
tenancy interface and **must not edit Dev 2's files** — if the interface is wrong, raise
it to the main thread rather than reaching across the boundary.

Reports: what changed, why, trade-offs, risks and follow-ups.

### Lana — testing

| Owns | `test/**`, exclusively |
|---|---|

Writes the suite in §7, with the RLS proof harness as the priority — it must connect as
`app_user` and bypass the application entirely. Lana also performs the
disable-a-policy-and-confirm-the-test-fails check; a test that passes against broken RLS
is the single most dangerous artifact this project can produce.

Lana tests behaviour, not implementation detail. If production code is hard to test,
Lana proposes the minimal refactor and hands it to whoever owns those files.

### Sequencing

True parallelism is limited — Dev 2's schema blocks everyone, so order matters:

1. Main thread agrees the tenancy interface contract and the week utility
2. Dev 2 builds schema + policies *(blocking)*
3. Dev 2 seeds immediately after the migration — it runs on the owner connection, so it
   does not wait for the wrapper, and it is what gives Dev and Lana real data to work
   against while the plumbing is still being written
4. Lana writes the RLS proof against the migration **while** Dev 2 builds the plumbing
5. Dev builds domain and UI once the wrapper interface is stable
6. All three report back; main thread synthesises and runs the adversarial review

Dev 2 now holds schema, policies, wrapper, auth *and* seed. That is a deliberate
concentration of the risky work in one place, but it makes Dev 2 the critical path for
longer — if the timebox tightens, the seed is the piece to hand back, since it needs
only the schema.

### Conflict rule

No agent edits a file it does not own. Cross-boundary needs go to the main thread. If two
agents believe they own the same file, the partition is wrong — stop and fix it rather
than merging by hand.

---

## 9. Deliverables Checklist

- [ ] Single GitHub repository
- [ ] `README.md` — run locally from a clean clone: prerequisites, env, db, seed, start
- [ ] `SOLUTION.md` — design and trade-offs; every decision in §2 with rationale; known
      gaps; next steps; **AWS design note** (Task 3); **AI workflow** (Task 4)
- [ ] `ai-logs/` — exported session transcripts, personal details redacted
- [ ] This file, committed
- [ ] Spec/plan committed *before* implementation commits
- [ ] Incremental commit history — **do not squash**
- [ ] Video demo, 5–10 min: working product, architecture walkthrough, key decisions,
      AI workflow including one correction or rejection

### SOLUTION.md → AWS design note (design only, no code)

Cover: container service for the API, managed PostgreSQL, static hosting for the React
build — **and specifically** how an organization logo is stored and served so that
backend bandwidth and cost are minimised while access stays controlled. The expected
shape of that answer: object storage behind a CDN, with time-limited signed URLs issued
by the API, so bytes never flow through the application tier. Close with the tenancy,
security and scaling concerns you would address first.

---

## 10. Git

- Commit messages explain **why**, not what
- Small, sequential commits that show the work progressing
- Never commit `.env`, real credentials, or unredacted transcripts
