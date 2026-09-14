# SPEC — Multi-Tenant Pulse Surveys

The execution plan. Constraints and the reasoning behind them live in
[CLAUDE.md](./CLAUDE.md); this file is the order of work and the bar for calling
it done. Written before implementation, and kept honest as work lands.

---

## 1. Goal

One complete vertical slice:

- a **Member** answers their organization's active weekly survey, once per week
- a **Manager** reads that survey's weekly rollup for their organization

Cross-tenant reads and writes are impossible because the **database** refuses
them, not because the application remembered to filter. Everything else is
secondary to that property.

---

## 2. Milestones

Ordered by dependency. Each one ends in a commit and is demonstrable on its own.

| # | Milestone | Owner | Done when |
|---|---|---|---|
| M0 | Skeleton — Nest, Vite, Compose, Prisma, two DB roles | main | ✅ `db:up` + both apps build and boot |
| M1 | Schema, constraints, RLS policies | Dev 2 | migration applies; `app_user` sees only its org's rows |
| M2 | Auth + tenant context + DB wrapper | Dev 2 | every query runs in a tx with `SET LOCAL` applied |
| M3 | Member flow — active survey, submit response | Dev | member submits; second submit in the same week is 409 |
| M4 | Manager flow — create survey, weekly summary | Dev | summary returns the shape in §4 with correct maths |
| M5 | Seed — two orgs, distinct numbers | Dev | idempotent; re-running changes no row counts |
| M6 | Test suite | Lana | the seven tests in §6 pass, and fail when RLS is broken |
| M7 | README, SOLUTION.md, ai-logs, video | main | deliverables checklist in CLAUDE.md §9 complete |

M1 blocks everything. M6's RLS proof can be written against the migration while
M2 is still in progress — that is the only real parallelism available.

---

## 3. Tenancy interface contract

Agreed up front so domain work can be written against it before it exists.
Everything below `src/tenancy/` is Dev 2's; everyone else consumes this and only
this.

```ts
type Role = 'manager' | 'member';

interface TenantContext {
  userId: string;
  orgId: string;
  role: Role;
}

/**
 * Opens a transaction, applies SET LOCAL app.current_org_id from the verified
 * token, and runs the callback inside it. The only route to the database.
 */
interface TenantDb {
  run<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
}
```

Two rules that make this structural rather than advisory:

1. Domain services receive **narrow repository interfaces**, never `PrismaClient`
   and never `TenantDb` directly. A service that can reach the raw client is a
   service that can forget the GUC.
2. The org id comes from the **verified JWT only**. Never a body, query, header
   or route param.

---

## 4. Surface

Endpoints and the summary payload are fixed by CLAUDE.md §4. The two shapes worth
restating, because both the API and the React app depend on them:

- `GET /surveys/:id/summary?week=YYYY-MM-DD` returns `weekStart`, `completedCount`,
  `eligibleCount`, `completionRate`, and a per-question rollup — `average`/`count`
  for `rating`, `counts.yes`/`counts.no` for `yes_no`.
- A survey belonging to another org returns **404, not 403**. A 403 confirms the
  resource exists.

Shared types live in one place and are imported by both sides, so a rename cannot
silently break the UI.

---

## 5. The four things that exist exactly once

Called out here because each one is a place where a second copy causes a real
defect, not a style complaint:

1. **ISO week calculation** — needed by submission, summary and seed. Three
   copies means three opinions about what week it is.
2. **The tenant-scoped DB wrapper** — every duplicate is a path that can skip the
   GUC.
3. **The summary response type** — one definition, both sides.
4. **Question-type behaviour** — `rating` and `yes_no` differ in validation,
   storage column and rollup maths. One type-keyed registry, so a third type is
   a new entry rather than an edit in five files.

---

## 6. Test plan

Thin but pointed. Full coverage is not the goal; proving isolation is.

1. **Cross-tenant isolation (API)** — org B cannot read or mutate org A's survey,
   responses or summary. The headline test.
2. **RLS proof (database)** — connect directly as `app_user`, set the GUC to org
   A, assert a bare `SELECT * FROM surveys` returns only org A's rows. Bypasses
   the application entirely; the only test that proves the *policies* work.
3. **Fails closed** — no GUC set, zero rows.
4. **No pool leakage** — two sequential requests as different orgs over one pool;
   the second sees only its own data. Catches `SET` where `SET LOCAL` was meant.
5. **Write containment** — an insert aimed at another org's `org_id` is rejected
   by `WITH CHECK`.
6. **Duplicate response** — second submission in the same week is rejected.
7. **Summary maths** — averages and yes/no counts against a known fixture.

**Gate:** before trusting any of these, disable one policy and confirm test 2
fails. A suite that passes against broken RLS is worse than no suite.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| App role silently bypasses RLS | App role owns nothing; `FORCE ROW LEVEL SECURITY` on every tenant table; verified in M0 |
| `SET` instead of `SET LOCAL` leaks tenant across pooled requests | One wrapper; test 4 |
| `INSERT` policy without `WITH CHECK` lets a tenant write into another org | Policies cover all four verbs; test 5 |
| Timebox overrun | Milestones ship in order; anything unfinished is a **Known gap** in SOLUTION.md, not half-built code |

---

## 8. Out of scope

Per CLAUDE.md: no password reset, email, real SSO, self-signup, scheduling,
charting libraries, notifications, pagination, i18n, dark mode, role management
UI, soft deletes, audit logs. Gaps are documented, not coded around.
