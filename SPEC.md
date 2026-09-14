# SPEC — Multi-Tenant Pulse Surveys

Implementation plan. Rationale lives in [CLAUDE.md](./CLAUDE.md); this exists so the
code can be checked against it. Deviations from CLAUDE.md §3 are marked **[dev]** and
justified in §5.

---

## 1. Data model

`id` is `uuid` everywhere. Enums are Postgres enums: `role('manager'|'member')`,
`survey_status('draft'|'active'|'archived')`, `question_type('rating'|'yes_no')`.

| Table | Columns | Constraints in the schema |
|---|---|---|
| `organizations` | `id`, `name`, `logo_url?` | — |
| `users` | `id`, `org_id→organizations`, `email`, `name`, `role` | `UNIQUE(email)`, `UNIQUE(id, org_id)` |
| `surveys` | `id`, `org_id→organizations`, `title`, `status`, `created_by→users` | `UNIQUE(id, org_id)` |
| `questions` | `id`, `survey_id`, **`org_id` [dev]**, `text`, `type`, `position` | `CHECK(position BETWEEN 1 AND 3)`, `UNIQUE(survey_id, position)`, `UNIQUE(id, type)`, `FK(survey_id, org_id)→surveys(id, org_id)` |
| `responses` | `id`, `survey_id`, `user_id`, `org_id`, `week_start DATE`, `submitted_at` | `UNIQUE(survey_id, user_id, week_start)`, `UNIQUE(id, org_id)`, `FK(survey_id, org_id)→surveys(id, org_id)`, `FK(user_id, org_id)→users(id, org_id)` |
| `answers` | `id`, `response_id`, `question_id`, **`org_id` [dev]**, **`question_type` [dev]**, `rating_value?`, `bool_value?` | `UNIQUE(response_id, question_id)`, `FK(response_id, org_id)→responses(id, org_id)`, `FK(question_id, question_type)→questions(id, type)`, `CHECK(num_nonnulls(rating_value, bool_value) = 1)`, `CHECK(rating_value BETWEEN 1 AND 5)`, `CHECK(question_type='rating' AND rating_value IS NOT NULL OR question_type='yes_no' AND bool_value IS NOT NULL)` |

### Why these belong in the schema, not in a service

- **`UNIQUE(survey_id, user_id, week_start)`** — the one-response-per-week rule. An
  application check is read-then-write and races: two concurrent submits both see
  "not yet answered". The constraint is the only version that holds. The 409 is a
  caught unique violation, not a pre-flight `SELECT`.
- **`position BETWEEN 1 AND 3` + `UNIQUE(survey_id, position)`** — enforces "max 3
  questions" structurally. Counting rows before insert races the same way. *Verified:
  the fourth insert is rejected by the CHECK.*
- **Composite FKs carrying `org_id`** — makes a child row in a different org from its
  parent **unrepresentable**. RLS stops you reading across tenants; it does not stop a
  buggy service writing a question into another org's survey while correctly scoped.
  These need `UNIQUE(id, org_id)` on the parent. *Verified: the FK is rejected without it.*
- **`FK(question_id, question_type)→questions(id, type)` + the type CHECK** — CLAUDE.md
  §3 asks for "CHECK: exactly one value set, matching the question's type". The second
  half is **impossible** as a CHECK — Postgres rejects subqueries in check constraints
  (*verified: `cannot use subquery in check constraint`*). Denormalising the type onto
  `answers` and pinning it with a composite FK turns it back into a constraint.
- **Deliberately no uniqueness on `status='active'`** — an org may run several active
  surveys at once and `GET /surveys/active` returns all of them. Do not "fix" this
  with a partial unique index. The cadence rule is unaffected: the per-week unique is
  keyed by `survey_id`, so it already counts one response per member per survey.

---

## 2. Endpoints

```
POST /auth/login                    dev-only; seeded email → JWT {sub, orgId, role}
GET  /me                            current user + org + role

GET  /surveys/active                Member: ALL of org's active surveys + questions
POST /surveys/:id/responses         Member: submit; 409 if already answered this week

POST /surveys                       Manager: create (≤3 questions)
GET  /surveys                       Manager: own org's surveys
GET  /surveys/:id/summary?week=YYYY-MM-DD   Manager: weekly rollup
```

Another org's survey returns **404, not 403** — and under RLS this is free: the row is
not visible, the lookup returns null, the handler 404s. No special-casing.

`GET /surveys/active` returns an array, empty when the org has none:

```jsonc
[
  {
    "id": "...",
    "title": "Weekly check-in",
    "weekStart": "2026-09-14",
    "alreadyRespondedThisWeek": false,
    "questions": [
      { "id": "...", "text": "How was your week?", "type": "rating", "position": 1 }
    ]
  }
]
```

`alreadyRespondedThisWeek` is per survey and resolved server-side, so the member screen
is one fetch rather than one call per survey. `weekStart` is returned rather than
computed in the browser — the week calculation exists once, on the server.

Summary shape, defined once as a shared type and imported by both sides:

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

`eligibleCount` counts users in the org with role `member`. `completionRate` is
`completedCount / eligibleCount`, `0` when the denominator is `0`.

---

## 3. What RLS does to the data-access layer

Every tenant table carries `org_id` and gets the **same** policy — no per-table logic:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;   -- or pulse_owner bypasses it
CREATE POLICY tenant_isolation ON <t>
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

`NULLIF(..., '')` is **load-bearing, not defensive**. After a transaction that set the
GUC commits, the setting reverts to `''` and not to `NULL` on that pooled connection
(*verified*). Unguarded, `''::uuid` raises `invalid input syntax for type uuid` — so the
next request on a reused connection 500s instead of returning zero rows, and the
fail-closed test passes or fails depending on connection reuse.

Three consequences for the layer's shape:

1. **Nothing reaches the database outside a transaction.** The GUC is transaction-scoped,
   so the unit of work is the transaction, not the query. `TenantDb.run(fn)` opens it,
   applies the GUC, and runs `fn`. There is no non-transactional read path to forget.
2. **The GUC is set with `set_config(name, value, true)`, not `SET LOCAL`.** `SET LOCAL`
   cannot take a bind parameter (*verified: syntax error*), so it would mean string
   interpolation into SQL — an injection vector on the value that decides tenancy.
   `set_config(..., true)` is transaction-local and parameterised. Same semantics, bound.
3. **Domain services receive narrow repository interfaces, never `PrismaClient`.** A
   service holding the raw client is a service that can query outside the wrapper. This
   is what makes the bypass structurally unavailable rather than merely discouraged.

Prisma does not model policies, so they live in hand-written SQL inside
`migrate dev --create-only` migrations. Every new tenant table needs enable + force +
policy in the same migration that creates it.

---

## 4. Build order, and what gets cut

1. **Schema + RLS policies + migration** — blocks everything.
2. **RLS proof test** — written against the migration, before the app can reach the DB.
3. **Auth guard + `AsyncLocalStorage` context + `TenantDb`** — the contract others code to.
4. **Week utility** — one function, unit-tested; used by submit, summary and seed.
5. **Member flow**: `GET /surveys/active` (list; excludes `draft` and `archived`),
   `POST /responses` including the 409 path. The screen renders a list even at length 1.
6. **Seed** — 2 orgs, distinct numbers, idempotent. Stays at CLAUDE.md §6's one active
   survey per org; a test covers the multi-element list, so the seed need not.
7. **Manager flow**: summary query + React screen.
8. **Remaining tests**, then README/SOLUTION.md.

Cut in this order if the timebox bites:

1. **Manager create-survey UI** — seed provides surveys; keep `POST /surveys` for the test.
2. **`GET /surveys` list** — reach the summary by seeded id.
3. **`?week=` parameter** — current week only.
4. **Styling** beyond legibility.

Never cut: the RLS proof and cross-tenant tests, the two-org seed, the 409 path, and
summary maths. Anything dropped is a **Known gap** in SOLUTION.md, not half-built code.

---

## 5. Deviations from CLAUDE.md §3

`org_id` is added to `questions` and `answers`, and `question_type` to `answers`.

§3 gives `org_id` to `users`, `surveys` and `responses` only. Without it, policies on
`questions` and `answers` must reach their parent via `EXISTS (SELECT 1 FROM surveys …)`
— a correlated subquery per row, evaluated under the parent's own RLS, on the hottest
path in the app. Carrying `org_id` keeps one identical policy on all five tables and
makes the composite FKs above possible. The column is not free-floating: the FK to
`(id, org_id)` makes a mismatch with the parent impossible.
