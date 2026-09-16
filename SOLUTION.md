# SOLUTION

Multi-tenant weekly pulse surveys. ~2,900 lines of first-party TypeScript, four
migrations, 25 row-level security policies, 78 tests.

---

## 1. What is built, and what was deliberately cut

**Built.** NestJS 12 API on PostgreSQL 18 via Prisma 7, React 19 / Vite 8 client,
`docker compose up` to a secured database with one command.

```
POST /auth/login                           dev-only, opt-in, seeded email -> JWT
GET  /me                                   current user, org and role
GET  /surveys/active                       Member: all active surveys + questions
POST /surveys/:id/responses                Member: submit; 409 if already answered
POST /surveys                              Manager: create (1-3 questions)
GET  /surveys                              Manager: own org's surveys
PATCH /surveys/:id                         Manager: close or reopen a survey
GET  /surveys/:id/summary?week=YYYY-MM-DD  Manager: weekly rollup
```

Isolation is enforced by the database. Every tenant table carries `ENABLE` and
`FORCE ROW LEVEL SECURITY` and four policies — separate `SELECT`/`INSERT`/
`UPDATE`/`DELETE`, with `WITH CHECK` on the two that write. The API connects as a
role that owns nothing and cannot bypass RLS; migrations run as a separate owner
role. The application issues no `WHERE org_id = …` anywhere, which is the point:
a filter you never write is a filter you cannot forget.

Two React flows: a Member answers their org's active surveys and sees the
already-answered state on return; a Manager reads the weekly rollup. Loading and
error states are a discriminated union in a hook, so a screen renders all three
cases or does not compile.

Managing a survey means opening and closing it, and that is the whole of what is
editable after creation. The privilege is granted on one column — `GRANT UPDATE
("status") ON "surveys"` — so the API cannot retitle a survey that already has
responses filed under it, or move one between organizations, whatever a service
decides to attempt. Returning a published survey to `draft` is refused by a
`BEFORE UPDATE` trigger, because a rule about a transition cannot be a `CHECK`:
a `CHECK` never sees the row being replaced. Closing is not deleting — an
archived survey keeps its responses and its summary stays readable.

**Cut, deliberately.** Survey creation and management *screens* — both endpoints
exist and are tested, surveys come from the seed, and a manager closes one over
the API. A router — three screens, one state variable. A week picker — the API
takes `?week=`, the UI shows the current week. Token persistence — it lives in
memory, so a refresh returns to the picker. Charts, component library, state
library. UI tests: the tests that matter here are API and database tests, and
standing up React Testing Library bought less than it cost. Rate limiting on
login — see §3.

Each of these is a screen or a dependency not built so that the two flows that
were asked for are finished rather than three being half-finished.

---

## 2. Decisions and trade-offs

### "This week" is the ISO calendar week, not a rolling window

Monday start, UTC, stored as a `DATE`. The reason is not calendar preference — it
is that **a rolling window cannot be a database constraint**.

The rule is "one response per member, per survey, per week". Under ISO weeks that
is one line:

```sql
UNIQUE (survey_id, user_id, week_start)
```

Under a rolling 7-day window there is no stable key to be unique on. "Has this
member responded in the last seven days?" depends on when you ask, so the rule
can only be a `SELECT` followed by an `INSERT` — which two concurrent submissions
both pass. The duplicate that results is not a rare race; it is the behaviour the
design chose. The 409 here is a caught unique violation, never a pre-flight check.

The cost: a member who answers Sunday evening and again Monday morning has
answered twice, hours apart, legitimately. That is a real edge and we accepted it
to keep the rule in the schema.

The calculation lives in exactly one function, used by response submission, the
summary and the seed. Three copies would be three opinions about what week it is,
and one of them would disagree with the constraint. Its unit tests are about
boundaries: `getUTCDay()` returns 0 for Sunday, so the obvious subtraction leaves
Sunday in the week that is starting rather than the one that is ending — wrong one
day in seven, and wrong specifically at the boundary the constraint keys on.

### RLS over application-layer scoping, and the risk that buys

An application-layer `where: { orgId }` is only as good as the last developer who
remembered to write it. A raw query, a new repository, a `findMany` written by
someone who has never heard of tenancy — each is a leak. RLS makes the guarantee
structural: the code that knows nothing about tenancy still cannot read across
tenants.

It also produces the 404-vs-403 behaviour for free. `findById` runs with no org
filter; another tenant's row is invisible, so the lookup returns `null` exactly as
it would for an id that never existed. The handler cannot distinguish them, so it
cannot leak the difference.

**The risk we took on is connection pooling.** RLS needs to know who is asking,
which means a per-request variable on a connection that is shared between
requests. Get the scope wrong and the failure mode is silent:

```sql
SET app.current_org_id = '<org A>'   -- session-scoped: survives COMMIT
```

That value stays on the pooled connection. The next request to borrow it starts
already scoped to org A, and if that request belongs to org B and its code throws
before setting the GUC, it reads and writes org A's rows — with every policy in
the database agreeing, because as far as PostgreSQL is concerned the caller *is*
org A. No error, no log line, and no failing test unless someone writes one for
it: single-request tests pass, because a fresh connection carries no leftover
value. It appears only under concurrency, in production, as one customer seeing
another's data.

So the GUC is transaction-scoped, set as the first statement inside `BEGIN` by a
single wrapper, and at `COMMIT` the connection returns to the pool carrying
nothing. Two details cost real debugging:

- It is written `set_config(name, value, true)`, not `SET LOCAL`. Identical scope,
  but `SET LOCAL` cannot take a bind parameter — `PREPARE … AS SET LOCAL …` is a
  syntax error — so using it literally means interpolating the organization id
  into SQL text, on the one value that decides which tenant is visible.
- Policies read `NULLIF(current_setting('app.current_org_id', true), '')::uuid`.
  The `NULLIF` is load-bearing, not defensive: `current_setting(_, true)` returns
  `NULL` only until the GUC is first set. After that transaction commits it
  reverts to the **empty string** for the rest of that connection's life, and
  `''::uuid` *raises* rather than matching nothing. Without the guard, the second
  request on a reused connection 500s, and the fail-closed test passes or fails
  depending on connection reuse.

Bypass is answered in three independent layers: the Prisma client is never a DI
provider, so a service that injects one fails to resolve and the process refuses
to boot; a client obtained anyway is wrapped in an extension that refuses every
operation outside the wrapper's scope; and a hand-rolled client still reads zero
rows, because the database is the backstop. The answer is never "it works, but
unscoped".

### Completion-rate denominator

"Relative to the number of members in that organization" is ambiguous: it could
mean every user in the org, or only those with the Member role.

**We count users with role `member`.** Managers author surveys; they are not the
responding population, and including them would make a small team's rate look
worse for having a manager. The alternative reading is defensible — if you think
of it as "everyone who could have answered", and managers can't answer at all,
then they are not eligible either, which lands in the same place.

The consequence to know: the denominator is counted *now*, not as of that week.
A member who joins on Friday makes Monday's completion rate drop retroactively.
Fixing that properly means an eligibility snapshot per survey-week, which is more
machinery than this slice justifies.

---

## 3. Known gaps, and what I would do next

**Security, in order.**

- **No rate limiting on login.** Deliberately not addressed: the endpoint is now
  absent unless `ENABLE_DEV_LOGIN=true` and refuses to run under
  `NODE_ENV=production`, and an in-memory throttle that resets on restart and
  does not span instances is closer to decoration than defence. It belongs at the
  edge, with the real IdP that replaces the dev login.
- **The dev login is the whole authentication story.** It exchanges an email for
  a token with no credential. It is gated, but gating is not authentication.

**Correctness.**

- **`ADD FOREIGN KEY` validation is subject to RLS.** Under `FORCE`, a migration
  runs with no tenant set, sees zero rows, validates against nothing, and records
  the constraint as `convalidated = true` regardless of what is underneath. `ADD
  CHECK` does not behave this way, which makes the asymmetry easy to miss. Every
  constraint added to a populated tenant table must lift `FORCE` for the duration
  — one migration here does, and the rule needs to be a lint rather than a
  convention.
- **Eligibility is not snapshotted** (above).
- **An answer can reference a question on a different survey within the same
  organization.** The foreign key binds type and org, not survey. Not a tenancy
  issue; the service prevents it; the schema should too.

**Operations.**

- **No index on `org_id`.** RLS adds that predicate to every query on every
  tenant table, so it is the hottest column in the schema and currently has no
  index of its own. First thing I would add under real data.
- **No CI.** The mutation check — break each policy in turn, require the suite to
  fail — is the single most valuable thing to run on every commit, and it runs
  only when someone types it.
- **No UI tests**, and the summary payload is the only shared type between API
  and client. Both are fine at this size and will not stay fine.

---

## 4. AWS production design

**API** — ECS Fargate behind an ALB. Fargate rather than EC2 for no node
management, and rather than Lambda because the tenancy design depends on
long-lived pooled connections and transaction scope; Lambda's connection model
fights that. The task role holds the *application* database credential from
Secrets Manager. Migrations run as a separate one-off task with the owner
credential, which the service's task role cannot read — the two-role split from
local development maps directly onto two IAM principals.

**Database** — RDS (or Aurora) PostgreSQL, private subnets, no public endpoint,
with **RDS Proxy** in front. The proxy matters more than usual here: it
multiplexes client connections onto fewer server sessions, which is precisely the
hazard §2 describes. Transaction-scoped `set_config` is safe under it, and it
also avoids session pinning — a session-level `SET` would both leak tenants *and*
force the proxy to pin, losing the multiplexing you paid for. The design that was
required for correctness is the one that performs.

**React build** — S3 behind CloudFront. Hashed asset filenames with a long
immutable TTL; `index.html` with a short one.

### Organisation logos

Store them in S3 under a key prefixed by organisation — `logos/{orgId}/{hash}` —
so the object layout matches the tenancy boundary and an IAM policy or a signed
path can be scoped to a prefix rather than enumerated per object. Serve through
CloudFront with the bucket private and origin access locked to the distribution.

**Bytes never traverse the API, in either direction.** Reads go from CloudFront to
the browser. Uploads go browser-to-S3 with a presigned POST whose policy pins
content type and maximum size; the API only ever issues the signature and records
the resulting key.

For access control I would use **CloudFront signed cookies scoped to
`/logos/{orgId}/*`**, issued by the API after it has authenticated the request,
rather than a signed URL per object. Per-object signed URLs are unique per
request, which makes every request a distinct CDN cache key and collapses the hit
rate — you pay for a CDN and get an origin. A cookie covers the prefix, so object
URLs stay stable and cacheable.

**The trade-off.** A signed cookie is a bearer credential for its lifetime. You
cannot revoke it: a user removed from an organisation keeps access to that
prefix's bytes until it expires. Short expiry means frequent re-signing round
trips; long expiry means a wider window. You have also introduced a second
authorisation system — CloudFront signatures alongside the API's own tokens — and
two systems can disagree. There is a real argument that an organisation logo is
not sensitive enough to justify any of this, and that an unguessable key served
publicly is the better trade for perfect cacheability and no second mechanism.
The signed path earns its cost when the same bucket will hold things that *are*
sensitive, and you would rather not run two schemes side by side.

### What I would address first

**Tenancy.** Make the RLS invariant a pipeline gate, not a practice: the mutation
check on every commit, plus a migration lint that fails when a new tenant table
lacks `ENABLE`, `FORCE`, four policies and its own `GRANT`. There is deliberately
no default privilege to fall back on, so a forgotten grant fails loudly — but a
forgotten *policy* fails silently, and only the mutation check catches it. Add the
`ADD FOREIGN KEY` validation rule to the same lint.

**Security.** Replace the dev login with OIDC, with `orgId` minted as a claim by
the identity layer rather than asserted by the caller; short-lived access tokens;
WAF and rate limiting at the edge; secrets rotation; and audit logging on anything
that crosses an organisation boundary, including administrative access.

**Scaling.** Index `org_id` on every tenant table before anything else — RLS
guarantees that predicate is in every query. Then watch the summary query:
`answers` grows as members × questions × weeks, and the rollup is the read-heavy
path. It is a single aggregate today and should stay one; if it stops being
enough, a per-survey-week rollup table is the next step, not loading rows into the
application. Read replicas are straightforward here — the GUC is per-connection,
so replicas inherit the isolation without special handling.

---

## 5. AI workflow

**Tools.** Claude Code (Opus 5) as the sole implementation tool, driven
interactively turn by turn. Alongside it: a live PostgreSQL in Docker used as an
oracle rather than a deployment target, and browser automation to drive the React
flows and read the accessibility tree.

**The transcript.** `ai-logs/01-build-session.md` is that session, exported from
the tool's own session file: 26 prompts over two days, with every tool call and
its result. A false start preceded it — the same opening prompt, interrupted
after about thirty seconds — which produced nothing and is not included.

It is redacted, and visibly so. The tool injects a memory index and reads local
config at startup, which pulled in unrelated client and personal work, and two
early directory listings enumerated a home folder. Those, absolute paths, the
local username and the injected reminders are stripped, each replaced in place
with a marker so that no omission is silent. Prompts and tool *inputs* — where
the code under review actually appears — are complete and unedited; tool
*output* over 2,000 characters is truncated with the omitted length recorded.
The local development credentials stay in, because they are already published in
`.env.example` and only ever reach a container on localhost. `ai-logs/README.md`
says all of this in the folder itself.

**How the work was broken down.** `CLAUDE.md` fixes constraints and settles the
decisions the brief left open. `SPEC.md` is the checkable plan — schema,
endpoints, build order, cut list. Both were committed *before* any implementation
commit, and the history is incremental and unsquashed, so the order of reasoning
is legible: constraints, plan, roles, schema and policies, proof, request path,
endpoints, seed, UI, adversarial review, fixes.

**Delegated versus kept.** `CLAUDE.md` §8 partitions the work four ways by file
ownership. In practice this ran on a single thread, and the partition earned its
place as a *design* device rather than a scheduling one: because the tenancy
contract and the week calculation were owned by no single domain, they had to be
defined as shared boundaries before anything depended on them. That constraint
surfaced two real problems on paper that would otherwise have surfaced in code —
the seed was assigned to the agent who owns domain files but requires the owner
database connection, which belongs to the data layer; and the week utility had no
owner at all despite three consumers. Both were reassigned before a line was
written. Claiming parallel agents here would be a nicer story and a false one.

**How output was validated.** Four practices, in rough order of value:

1. **Check, do not recall.** Installed versions were verified before any framework
   code was written, which caught that `prisma@latest` was a release candidate
   while `@prisma/client@latest` was stable, and that NestJS 12's starter is ESM
   with Vitest rather than CommonJS with Jest. Writing from memory would have
   produced a plausible, broken project.
2. **Test the claim against the database.** Every assertion about PostgreSQL
   behaviour in this document was run before it was written. That is how the
   `NULLIF` requirement was found — the GUC reverts to `''`, not `NULL` — and how
   `SET LOCAL`'s inability to take a bind parameter was established rather than
   assumed.
3. **Write the regression test first and watch it fail.** Every fix in the
   security pass has one. Eleven failed before the auth work, three before the
   schema work, two before the login-scope work.
4. **Break it on purpose.** `npm run test:rls-mutation` drops each tenant table's
   `SELECT` policy in turn, requires the suite to fail every time, and exits
   non-zero on any mutation that survives.

**Corrections and rejections that changed the work.** The first `SPEC.md` was
rejected outright — I produced an orchestration document describing the shape of
the work, and was told to produce an implementation plan the code could be checked
against; it was rewritten. `GET /surveys/active` was specced as returning a single
survey, backed by a partial unique index; that was overruled in favour of a list
and the constraint removed. A summary rollup that identified questions by position
was judged out of scope by me and asked for anyway.

Three corrections came from the tooling rather than from review. The bypass guard
rejected the auth lookup I had just written, because Prisma promises are lazy and
the query dispatched after the AsyncLocalStorage scope had closed — the control
caught its author. The mutation script found that dropping `users_select` failed
nothing, because my policy test aggregated distinct commands and `users` carries a
second `SELECT` policy for login; it was blind on the one table where that
matters. And the accessibility tree read `radio "on"` for every rating input,
which would have shipped.

The review phase found seven issues in code I had written that same session,
including a hardcoded fallback signing secret — verified to forge a cross-tenant
read and a role escalation before it was removed. Fixing one of them exposed an
eighth: `ADD FOREIGN KEY` validates against an RLS-filtered scan, so the
cross-tenant row written by the *failing* regression test survived the migration
that forbade it, under a constraint reporting itself as validated.

**What would change next time.** The two most valuable findings — the
`users_select` blind spot and the foreign-key validation asymmetry — both came
from deliberately breaking something and watching what *failed to fail*. Neither
would have been found by reading the code, and both arrived late because the
adversarial pass was a phase at the end rather than a habit throughout. Next time
that pass runs continuously from the first migration.

The second lesson is narrower and sharper: **a test that reads through RLS can
pass vacuously.** Five of my own fixtures were wrong in exactly the way the
production code was — one created surveys the new constraint forbade, one queried
unscoped and so could not see the row it was asserting about, and one read a table
the owner is also locked out of. Any data-integrity check in a system like this
has to state which tenant it is looking from, or it is asserting about an empty
set and reporting success.

The last two are the sharpest, and they came from adding survey management at the
end. The cross-tenant tests named the other organization's survey by a written-down
uuid that the seed does not produce — so "another org's survey returns 404" was
really "a uuid nobody has ever used returns 404", which is true of every uuid.
That surfaced only because the new test asserted its own precondition (*this
survey should be active before I try to archive it*) and got `undefined`.

The replacement read the id from the database instead, and was wrong in a subtler
way: it picked the row with an unqualified `findFirst` inside an org-B scope —
trusting the very policy under test to choose which row the test would then write
to. Under the mutation that replaces `surveys_select` with `USING (true)` it
selected org A's survey, and the test that exists to prove a manager cannot touch
another tenant's survey archived the seeded one. The suite still went red, so the
mutation was "caught"; nothing said the test had done damage on its way past. I
found it by checking the seed after a mutation run rather than by reading output.
A fixture must not resolve its target through the control it is testing.
