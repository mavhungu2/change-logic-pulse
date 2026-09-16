> **What this is.** The execution plan for this assignment, written on
> 2026-09-13 — two days before the first commit — and followed from there. It is
> included because Task 4 asks how the task was set up for the AI, and this is
> the answer: a phase per commit, the prompt for each, a checklist to review the
> output against before approving it, and templates in Appendix A for rejecting
> it.
>
> **It is also wrong in one important place, and that is the point of keeping
> it.** Section 1 locks tenant isolation to application-layer scoping, with
> row-level security named as "a documented next step, not in scope". That was
> overruled during the build for the reason set out in SOLUTION.md §2: a
> `where: { orgId }` is only as good as the last developer who remembered to
> write it, and the whole guarantee rests on nobody ever forgetting. Three
> smaller decisions went the same way — pnpm workspaces became a single npm
> project, PostgreSQL 16 became 18, and the partial unique index pinning one
> active survey per organization was removed once it turned out to forbid
> something the brief permits.
>
> The plan was worth writing and was not worth obeying. What survived it is
> `CLAUDE.md`, which is the same instinct — decide once, write it down, hold the
> work to it — corrected by contact with the database.
>
> Phase 0 says this runbook stays outside the repository. That was reversed: a
> plan nobody can read is not evidence of planning.
>
> Lightly redacted: a client project is referred to generically, and home paths
> and the local username are rewritten. Nothing else is changed.

---

# Pulse Surveys take-home: execution runbook

Prepared 2026-09-13 for the Change Logic / OfferZen "Multi-Tenant Pulse Surveys" assignment.
All build work happens in a **new Claude Code session** whose working directory is `~/Documents/pulse-surveys`.
This runbook and the assignment PDF stay **outside** the repo.

---

## 1. Locked decisions (every prompt below assumes these)

| Area | Decision |
|---|---|
| Layout | pnpm workspaces. `apps/api` = NestJS + Prisma. `apps/web` = Vite + React + TS. Docker Compose Postgres 16 on host port **5433** (5432 is already taken on this Mac). |
| Week | ISO calendar week, Monday 00:00 UTC to Sunday. Each response stores `week_start`. Unique index on (survey, user, week_start). |
| Isolation | Application-layer scoping. `org_id` comes only from the JWT. Composite FKs `(id, org_id)` on every child table. Cross-org lookups return 404. Row-level security is a documented next step. |
| Auth | Pick a seeded user → `POST /api/auth/login` → HS256 JWT. `GET /api/auth/dev-users` exists only outside production. |
| Roles | MANAGER creates/manages surveys and views summaries. MEMBER submits. Completion rate divides by MEMBER-role users. |
| Repo | `~/Documents/pulse-surveys`, public GitHub repo under your personal account `mavhungu2`. |

## 2. Time budget

| Phase | What | Minutes |
|---|---|---|
| 0 | Prep | 10 |
| 1 | Spec + CLAUDE.md, first commit, create repo | 15 |
| 2 | Scaffold | 20 |
| 3 | Schema, migration, seed | 30 |
| 4 | Auth + tenancy | 25 |
| 5 | Surveys + responses | 35 |
| 6 | Weekly summary | 20 |
| 7 | E2E isolation tests | 25 |
| 8 | React app | 45 |
| 9 | README + SOLUTION.md | 30 |
| 10 | ai-logs export, final push, fresh-clone check | 15 |
| 11 | Video | 30 |

Roughly five hours including the video. The brief says ±4 h but allows longer.

## 3. The loop you run for every step

1. Paste the step's prompt. Every prompt ends with **"Do not commit"** so you always get a review checkpoint.
2. Open the diff pane and review against the step's checklist. Read everything before approving.
3. Either **approve** or **correct** using the templates in Appendix A. Corrections are the evidence the assignment asks for. Phrase them explicitly ("Rejected: X because Y") so they're easy to find in the logs and to show in the video. Do not manufacture one. The checklists list the places where AI output usually slips.
4. On approval Claude commits with the message given, then pushes.

Keep the whole build in one session if you can. If you have to start another, the export script in Phase 10 handles multiple session files.

---

## Phase 0. Prep (you, in a terminal)

Copy the assignment out of Downloads and make a plain-text version so the new session can read it reliably:

```bash
cp "$HOME/Downloads/Change Logic _ Senior Full Stack Engineer (AI Native) Assignment (1).pdf" "$HOME/Documents/pulse-assignment.pdf" && pdftotext -layout "$HOME/Documents/pulse-assignment.pdf" "$HOME/Documents/pulse-assignment.txt" && wc -l "$HOME/Documents/pulse-assignment.txt"
```

Create the repo folder:

```bash
mkdir -p ~/Documents/pulse-surveys && cd ~/Documents/pulse-surveys && git init -b main && git config user.email
```

The email printed must be your personal one, not a client address.

Start Docker Desktop (needed from Phase 2):

```bash
open -a Docker
```

Then in the Claude desktop app start a **new session** with working directory `~/Documents/pulse-surveys`. Do not build from a client project's session: its project instructions and memory would pollute the transcript and fight the NestJS conventions.

---

## Phase 1. Spec before code

### Prompt 1

```text
I'm doing a timeboxed take-home assignment. Read these two files first, then write exactly two files and nothing else. No code, no scaffolding, no package.json yet.

- ~/Documents/pulse-assignment.txt  (text export of the assignment PDF; the PDF is at ~/Documents/pulse-assignment.pdf if you need it)
- ~/Documents/CLAUDE_STANDARD.md  (my CLAUDE.md template)

Decisions I have already made. Use them, don't relitigate them:
- Monorepo with pnpm workspaces: apps/api (NestJS latest stable, TypeScript strict, Prisma ORM) and apps/web (Vite + React + TypeScript latest stable). Docker Compose runs PostgreSQL 16, mapped to host port 5433 because I already have a Postgres on 5432.
- "This week" = ISO calendar week, Monday 00:00 UTC to Sunday. Each response stores week_start (a date). A unique index on (survey_id, user_id, week_start) enforces one response per member per week at the database.
- Tenant isolation = application-layer scoping. org_id is taken only from the authenticated user's JWT, never from the request body, query or URL. Every tenant-owned table carries org_id, and child tables reference parents with composite foreign keys (id, org_id) so a cross-org reference fails at the database even if a query filter is missed. Cross-org lookups return 404, not 403. Postgres row-level security is a documented next step, not in scope.
- Local auth: POST /api/auth/login with a seeded user's email returns an HS256 JWT (secret from env) with claims sub (userId), orgId, role. GET /api/auth/dev-users lists seeded users grouped by org for the login screen and is not registered when NODE_ENV=production.
- Roles: MANAGER and MEMBER. Managers create and manage surveys and view summaries. Only members submit responses. Completion rate = distinct responders ÷ users with role MEMBER in the org.
- Surveys: DRAFT | ACTIVE | CLOSED, at most one ACTIVE survey per org (partial unique index). 1 to 3 questions, types RATING_1_5 and YES_NO. Answers have a CHECK that exactly one of rating_value / yes_no_value is set, and rating_value is between 1 and 5.
- Summary: GET /api/surveys/:id/summary?week=YYYY-MM-DD, week must be a Monday, defaults to the current ISO week. Returns completion count, completion rate, and per-question rollups (rating: average + count; yes/no: yes count + no count).
- Current time comes from an injectable Clock provider so week logic is testable.
- Seed: two orgs, each with 1 manager, 3 members, one ACTIVE 3-question survey, and some current-week responses so summaries are non-empty.
- Status codes: 401 unauthenticated, 403 wrong role, 404 not found or not in the caller's org, 409 duplicate response this week or second active survey, 400 validation.

Write:
1. SPEC.md, under 150 lines: goals, non-goals, data model (tables, key columns, constraints), API endpoints with request/response shapes and status codes, the week and isolation rules above with a one-line trade-off note each, the three frontend screens (login, member, manager), the test plan (unit tests for week and rollup math, e2e tests for isolation, roles and duplicate-week), and the commit plan: one commit per step in this order: spec, scaffold, schema+seed, auth, surveys+responses, summary, e2e tests, web, docs, ai-logs.
2. CLAUDE.md, following my template's structure and adapted to this project: stack, commands, folder layout, and these rules: org comes only from the JWT and every query filters by orgId; composite FKs on tenant tables; TypeScript strict with no `any`; every async UI state has loading and error handling; no dead code or commented-out code; run build, lint and tests before reporting done and paste the real output; never commit unless I explicitly say so; stay inside the step I asked for and list anything out of scope instead of doing it; use latest stable package versions.

Before writing, list any requirement in the assignment that my decisions don't cover and ask me instead of guessing. Then write the two files and stop.
```

### Checklist

- SPEC.md **states** the week choice and the isolation choice. The brief explicitly asks for both.
- Three questions max, two question types, completion rate relative to members, one response per active week, seed for two orgs.
- Read every line. Change anything you disagree with **yourself** in the editor. Your own edits to the spec are good evidence of direction.
- CLAUDE.md contains the rules listed in the prompt and nothing client-specific.

### Approve, commit, create the repo

Approval message: `Approved. Commit exactly these two files with message: "docs: spec and agent instructions before implementation"`

Then, in a terminal:

```bash
cd ~/Documents/pulse-surveys && gh repo create pulse-surveys --public --source=. --remote=origin --push
```

Confirm the transcript folder for the new session exists (you'll need the path in Phase 10):

```bash
ls ~/.claude-work/projects/ ~/.claude/projects/ 2>/dev/null | grep -i pulse
```

---

## Phase 2. Scaffold

### Prompt 2

```text
Step 2 of the commit plan in SPEC.md: scaffold the monorepo. Read SPEC.md and CLAUDE.md first.

Create:
- pnpm workspace root: package.json (private, engines node >=22, scripts dev / build / lint / test / test:e2e that fan out to both apps), pnpm-workspace.yaml, .gitignore (node_modules, dist, .env, coverage), .nvmrc, .editorconfig, and a root .env.example with DATABASE_URL (port 5433), DATABASE_URL_TEST, JWT_SECRET (a clearly-labelled local dev value) and PORT=3000.
- apps/api: a fresh NestJS project (latest stable) with TypeScript strict, global prefix /api, a global ValidationPipe (whitelist, forbidNonWhitelisted, transform), a ConfigModule that validates the env vars above at startup, and GET /api/health. Add Prisma (latest stable) with an empty schema reading DATABASE_URL. Delete the Nest hello-world controller/service; no dead code.
- apps/web: Vite + React + TypeScript (latest stable), a Vite dev proxy from /api to http://localhost:3000, and a placeholder App that calls /api/health and renders loading, error and success states.
- docker-compose.yml: postgres:16-alpine, host port 5433 → container 5432, database pulse, user pulse, password pulse, named volume, healthcheck, and an init script that also creates the pulse_test database for e2e tests later.
- One shared ESLint + Prettier config. Only plugins that are actually used.

No domain code yet. Then run, in order: pnpm install; docker compose up -d and wait for healthy; pnpm --filter api exec prisma generate; pnpm build; pnpm lint; start the API and curl http://localhost:3000/api/health. Paste the real output of each command. If anything fails, fix it and rerun. Do not commit. Finish with the list of files created and any deviation from SPEC.md.
```

### Checklist

- `.env` is ignored and `.env.example` exists. DATABASE_URL uses **5433**.
- The Nest hello-world controller and service are gone.
- `strict: true` in both tsconfigs.
- The health check output is actually pasted. Don't accept "it works" without output.

Commit message: `chore: scaffold pnpm workspace with NestJS api, React web and Postgres compose`

---

## Phase 3. Schema, migration, seed

### Prompt 3

```text
Step 3: database schema, migration and seed, exactly as in SPEC.md's data model. Read SPEC.md first.

- Prisma models with UUID ids: Organization; User (orgId, email unique, name, role enum MANAGER|MEMBER); Survey (orgId, title, status enum DRAFT|ACTIVE|CLOSED, createdById); SurveyQuestion (surveyId, orgId, position, type enum RATING_1_5|YES_NO, text); Response (surveyId, orgId, userId, weekStart @db.Date, submittedAt); Answer (responseId, questionId, orgId, ratingValue Int?, yesNoValue Boolean?).
- Composite foreign keys: each child references (parentId, orgId) against @@unique([id, orgId]) on the parent, so a response can never point at another org's survey and an answer can never point at another org's question or response.
- @@unique([surveyId, userId, weekStart]) on Response. @@unique([surveyId, position]) on SurveyQuestion. @@unique([responseId, questionId]) on Answer.
- Constraints Prisma can't express go into the migration SQL: create the migration with prisma migrate dev --create-only, edit it, then apply. Add: a partial unique index for one ACTIVE survey per org; CHECK position BETWEEN 1 AND 3; CHECK ratingValue BETWEEN 1 AND 5; CHECK that exactly one of ratingValue / yesNoValue is non-null. List these hand-written constraints in SPEC.md's data model section.
- Week helper: a pure function weekStartUtc(date: Date): string returning the ISO Monday as YYYY-MM-DD, in apps/api/src/common/week.ts, using UTC getters only. Unit tests: a Monday, a Sunday, a Wednesday, a year boundary and a leap day.
- Seed (apps/api/prisma/seed.ts via prisma db seed): two orgs with distinct memorable names; each with 1 manager and 3 members using obviously fake emails on a .test domain; each with one ACTIVE 3-question survey (two RATING_1_5, one YES_NO). Org 1 has current-week responses from 2 of its 3 members and one response from last week; org 2 has a current-week response from 1 of 3. Use weekStartUtc for weekStart. The seed must be idempotent: rerunning it must not duplicate rows.

Run: prisma migrate dev, prisma db seed twice, the unit tests, pnpm lint, pnpm build. Then prove the composite FK with psql: try to insert a Response whose surveyId belongs to org 1 but whose orgId is org 2, and paste the error. Do not commit.
```

### Checklist

- `\d responses` in psql shows the FK on **(survey_id, org_id)**, not on survey_id alone.
- The migration SQL contains the partial unique index and the three CHECKs.
- `week.ts` uses `getUTCDay` / `setUTCDate`, never `getDay` / `setDate`. A local-time helper is a real bug and a legitimate rejection.
- Second seed run creates no duplicates. Seed emails are fake.
- Per CLAUDE.md, no `any` in the seed.

Commit message: `feat(db): tenant-scoped schema with composite FKs, constraints and seed data`

---

## Phase 4. Auth and tenancy

### Prompt 4

```text
Step 4: local authentication and tenant context, per SPEC.md.

- AuthModule. POST /api/auth/login { email } → { accessToken, user: { id, name, role, organization: { id, name } } }. Sign an HS256 JWT with JWT_SECRET from config, 8h expiry, claims sub (userId), orgId, role. Unknown email → 401 with a generic message that doesn't reveal whether the email exists.
- GET /api/auth/dev-users → seeded users grouped by organization with roles, for the login screen. Register this route only when NODE_ENV !== 'production', and add a unit test proving it is absent in production.
- A global JwtAuthGuard (APP_GUARD) with a @Public() decorator used only by login, dev-users and health. A RolesGuard with @Roles(Role.MANAGER). A @CurrentUser() parameter decorator returning AuthenticatedUser { userId, orgId, role }. No `any` anywhere, including the request typing.
- GET /api/me returns the current user and organization, to smoke-test the guards.
- Keep tenancy explicit: services take orgId from AuthenticatedUser and every Prisma query includes it in the where clause. No request-scoped providers or Prisma middleware for this. Add one line to SPEC.md explaining the choice: explicit over implicit for a slice this size, RLS as the next step.

Unit-test both guards and the login service. Run tests, lint, build. Then demonstrate with curl: log in as an org 1 member, call /api/me; call /api/me with no token (expect 401) and with a token signed with a different secret (expect 401). Paste real output. Do not commit.
```

### Checklist

- JWT_SECRET only from config, never a literal in source.
- Unknown email yields a generic 401.
- The dev-users-absent-in-production test exists and passes.
- No service method accepts orgId from a DTO. They all take it from the user.

Commit message: `feat(auth): local JWT login, role guard and tenant-scoped user context`

---

## Phase 5. Surveys and responses

### Prompt 5

```text
Step 5: surveys and responses, per SPEC.md.

Manager endpoints (MANAGER role):
- POST /api/surveys { title, questions: [{ text, type }] }. 1 to 3 questions, positions assigned in order, created as DRAFT. 201.
- GET /api/surveys. Caller's org only, newest first, with status and question count.
- GET /api/surveys/:id with questions. 404 if not in the caller's org.
- POST /api/surveys/:id/activate. 409 if the org already has an ACTIVE survey. Rely on the partial unique index and map the Prisma unique-violation error; do not check-then-insert.
- POST /api/surveys/:id/close.

Member endpoints:
- GET /api/surveys/active. The caller's org's ACTIVE survey with questions, plus weekStart and hasRespondedThisWeek for the caller. 404 if none.
- POST /api/surveys/:id/responses { answers: [{ questionId, ratingValue?, yesNoValue? }] }. MEMBER only. Rules: survey must be in the caller's org and ACTIVE (else 404); every question answered exactly once, value type matching the question type (else 400); weekStart computed server-side as weekStartUtc(clock.now()) and never accepted from the client; a second submission in the same week → 409 mapped from the unique-constraint error. Returns 201 { id, weekStart }.

Add a Clock provider: interface Clock { now(): Date }, SystemClock as default, injected wherever the current time is used.

class-validator DTOs, thin controllers, logic in services, no `any`. Unit-test response validation: wrong value type, missing question, duplicate question, extra unknown question. Run tests, lint, build, then curl the member happy path against the seed and paste the output, including the 409 on the second submit. Do not commit.
```

### Checklist

- Cross-org survey id → **404**, not 403.
- weekStart is never read from the request.
- Activate maps the DB unique violation to 409 rather than pre-checking.
- Controllers contain no business logic.
- Curl output pasted, including the 409.

Commit message: `feat(surveys): manager survey lifecycle and member weekly responses`

---

## Phase 6. Weekly summary

### Prompt 6

```text
Step 6: weekly summary, per SPEC.md.

GET /api/surveys/:id/summary?week=YYYY-MM-DD, MANAGER only. week must be a Monday (400 otherwise) and defaults to weekStartUtc(clock.now()). 404 if the survey is not in the caller's org. Response shape:
{ surveyId, title, weekStart, weekEnd, memberCount, completionCount, completionRate, questions: [ { questionId, position, text, type, rating?: { average, count }, yesNo?: { yes, no } } ] }
memberCount = users in the org with role MEMBER. completionCount = distinct responses for that survey and week. completionRate is 0 to 1 rounded to 4 decimals, and 0 when memberCount is 0. rating.average is null when count is 0.

Put the rollup math in a pure function in apps/api/src/surveys/summary.ts that takes the aggregated rows and returns the DTO, and unit-test it: empty week, all members responded, average rounding, yes/no with zero responses. Do the aggregation in the database (Prisma groupBy or a single raw SQL query), not by loading every answer into memory; say which you chose and why in a one-line comment.

Run tests, lint, build. Then curl the summary for both orgs' surveys as their own managers and paste the output. Finally, as org 1's manager, request org 2's survey summary and confirm 404. Do not commit.
```

### Checklist

- completionRate is 0 with no members, average is null with no ratings.
- Aggregation happens in SQL, not in a JS loop over all answers.
- The two orgs' summaries differ and match the seed (org 1: 2 of 3, org 2: 1 of 3).
- Cross-org 404 demonstrated.

Commit message: `feat(summary): weekly completion and per-question rollups`

---

## Phase 7. End-to-end isolation tests

### Prompt 7

```text
Step 7: end-to-end tests with supertest against the pulse_test database, per SPEC.md's test plan.

Set up apps/api/test with a jest e2e config. Before all: point Prisma at DATABASE_URL_TEST, run prisma migrate deploy, run the seed. Reset data between test files as needed. Provide a FixedClock that replaces SystemClock in the test module so tests control the week.

Tests, each named for the rule it proves:
1. Org 1 manager: GET org 2's survey → 404; GET org 2's summary → 404.
2. Org 1 member: POST a response to org 2's active survey → 404.
3. Org 1 member: GET /api/surveys → 403; POST /api/surveys → 403.
4. Member submits once → 201; again in the same week → 409; advance FixedClock by 7 days → 201.
5. Manager summary after those submissions reports the expected completionCount, completionRate and rollups.
6. No token → 401; token signed with a different secret → 401.
7. GET /api/surveys returns only the caller's org's surveys: assert the count and that every row's orgId matches.
8. Manager activating a second survey while one is ACTIVE → 409.

Wire pnpm test:e2e at the root. Run the whole suite and paste the real output. Do not commit.
```

### Checklist

- Tests use `pulse_test`, not `pulse`.
- Each test asserts status **and** body.
- The 7-day advance goes through FixedClock, not by sleeping or editing rows.
- Suite output pasted and green.

Commit message: `test: e2e coverage for tenant isolation, roles and weekly submission rules`

---

## Phase 8. React app

### Prompt 8

```text
Step 8: the React app, per SPEC.md's three screens. Minimal, typed, no UI kit; one small CSS file is fine.

- API client: one typed fetch wrapper that attaches the JWT from localStorage, throws a typed ApiError carrying the status, and clears the session on 401. TypeScript types for every response shape used, mirroring the API DTOs.
- Login screen: loads GET /api/auth/dev-users, shows users grouped by organization with a role badge; clicking one calls POST /api/auth/login and stores the token and user. Loading and error states.
- Member screen: loads GET /api/surveys/active. Shows title and week range, then a form with 1 to 5 radio buttons per rating question and Yes/No per yes/no question. Submit stays disabled until everything is answered. On success show a confirmation with the week. If hasRespondedThisWeek, show an "already submitted this week" state instead of the form. Show visible messages for 404 (no active survey), 409 and network errors.
- Manager screen: list of the org's surveys; selecting one loads the summary for the current week, with previous and next week buttons that step by 7 days in UTC and always land on a Monday. Show completion count, completion rate as a percentage with a simple bar, and per-question rollups.
- Header with the signed-in user, org and role, and a sign-out button. Route by role after login.
- Data fetching with explicit loading, error and success states. TanStack Query is fine if the hooks live in one file; otherwise a small hook of our own. No `any`.

Run pnpm lint and pnpm build for web. Then start api and web, open the app in the browser and walk the flow yourself: log in as the org 1 member who has not responded, submit, confirm the already-submitted state; log in as org 1's manager and confirm the summary changed; log in as org 2's manager and confirm different data. Paste what you observed. Do not commit.
```

### Checklist

- No `any`. Every fetch has loading and error UI.
- A 401 clears the session and returns to login.
- Week picker steps in UTC and stays on Mondays.
- **Open the app yourself** and repeat the walkthrough. Do not rely on Claude's report alone.

Commit message: `feat(web): login, member survey submission and manager weekly summary`

---

## Phase 9. README and SOLUTION.md

### Prompt 9

```text
Step 9: documentation. Read SPEC.md, CLAUDE.md and the git log first.

README.md: prerequisites (Node 22+, pnpm, Docker), the exact commands from a clean clone (install, compose up, migrate, seed, start api, start web), the URLs, the seeded logins grouped by org, how to run unit and e2e tests, and a five-line curl walkthrough that ends with a cross-org 404. Run every command as written and fix anything that doesn't work.

SOLUTION.md with these sections:
1. Design overview: architecture, data model, the isolation approach and why, the week choice and why, status code conventions.
2. Trade-offs and known gaps, specific to this code: shared-secret JWT with no refresh, the dev-users endpoint, no pagination, no editing a survey after activation, managers excluded from the completion denominator, no RLS, no rate limiting, and anything else you know is missing.
3. Next steps with more time, prioritised.
4. Production readiness on AWS, design only: ECS Fargate behind an ALB for the API, RDS PostgreSQL Multi-AZ, Secrets Manager for JWT_SECRET and the DB credentials, migrations as a one-off ECS task, the SPA on S3 behind CloudFront, CloudWatch logs and alarms. Organization logo: the API issues a presigned S3 PUT (validated content type and size, key namespaced by org) so the browser uploads directly; images are served through CloudFront with origin access control and signed URLs or signed cookies scoped to the org, long cache TTLs with versioned keys, so the API never proxies image bytes. Then the top three tenancy, security and scaling considerations you would tackle first.
5. AI-assisted delivery: leave this as a structured outline with TODO markers for me to fill in my own words: tools used, how the task was set up (spec and CLAUDE.md first), how work was broken down into commits, what was delegated versus kept, how output was reviewed and validated, what was rejected or rewritten, what I would change next time. Below it add one factual sub-section you can fill: a table of each commit and the checks that were run for it (unit tests, e2e, lint, curl, browser walkthrough).

Do not commit.
```

Then **you** fill section 5 in your own words, 15 minutes. Use Appendix B for the honest list of what you kept.

### Checklist

- README commands were actually executed, not just written.
- Trade-offs are specific to this code, not generic.
- AWS section covers all three asks: deployment, logo, priorities.

Commit message: `docs: README, solution design, AWS note and AI workflow`

---

## Phase 10. ai-logs export, final push, fresh-clone check

### Prompt 10

```text
Step 10: export my Claude Code session transcripts into ai-logs/.

Claude Code stores this project's sessions as JSONL under ~/.claude-work/projects/<project folder>/ (also check ~/.claude/projects/ for the same folder name). Write scripts/export-ai-logs.ts, run with pnpm export:logs, that for every session file:
- renders a readable Markdown transcript: timestamp, role, the text of user and assistant messages, each tool call as "▶ ToolName: <one-line summary of its key input, such as the command or file path>", and tool results truncated to 400 characters;
- redacts: my home directory (replace /Users/<name> with ~), any email address, anything that looks like a JWT or an API token, and every string listed in scripts/redactions.txt (one per line, gitignored, I will fill it);
- writes ai-logs/<date>-<short-session-id>.md, plus a redacted copy of the raw JSONL with any base64 document or image blocks replaced by a placeholder;
- writes ai-logs/README.md explaining the format, the redaction, and that the log necessarily ends just before the commit that adds it.

Create scripts/redactions.txt with a placeholder line and gitignore it. Run the export, then grep ai-logs/ for '@', 'Users/', 'eyJ' and each line of redactions.txt and paste the results, which should be empty. Do not commit.
```

Before running it, put your work email, full name variants you don't want public, and anything else sensitive into `scripts/redactions.txt`.

### Checklist

- Grep results are empty. Open one `.md` and skim it yourself for anything personal.
- The raw JSONL copy contains no base64 blobs.
- `scripts/redactions.txt` is **not** staged.

Commit message: `docs: redacted AI session logs`

Then push and do a fresh-clone check in a temp folder, following README.md literally:

```bash
rm -rf /tmp/pulse-check && git clone https://github.com/mavhungu2/pulse-surveys /tmp/pulse-check && cd /tmp/pulse-check && sed -n '1,80p' README.md
```

If anything fails, fix it in a new commit. Extra fix-up commits are fine; the history is supposed to show progress. Finally check on github.com that `.env` is absent and the commit list reads in order.

Optional: add a short `ai-logs/00-planning-session.md` describing the separate planning conversation in which the design defaults were chosen, with the redacted plan text pasted in. Do not export that session's raw JSONL; it contains unrelated work context.

---

## Phase 11. Video (5 to 10 minutes, Loom or QuickTime)

### Prompt 11, optional

```text
Write a 7-minute demo shot list for a Loom video of this project, with timings: (1) start from a clean clone in about 60 seconds; (2) member flow in org 1 then the manager summary; (3) switch to org 2's manager to show different data, then a curl cross-org 404; (4) architecture walkthrough, naming the files to open in order; (5) design decisions and trade-offs from SOLUTION.md; (6) AI workflow: show that SPEC.md and CLAUDE.md are the first commit, open ai-logs, and point at the moment I rejected [I'll tell you which]; (7) next steps. Notes I can glance at, not a word-for-word script.
```

Record with the browser, a terminal and your editor visible. The rejection moment must be a real one from your logs.

---

## Appendix A. Approval and correction templates

Approve:

```text
Approved. Commit exactly these changes with message: "<message from this runbook>". Then git push. Do nothing else.
```

Correct:

```text
Rejected: <what is wrong, with file and line>. <Why: the rule or requirement it breaks>. Change it to <what you want>, rerun the checks, and show me only the diff for that fix. Do not commit.
```

Scope creep or unrequested commit:

```text
You went beyond the step: <what>. Revert that part, keep the rest, and list anything you think is still needed so I can decide. Do not commit.
```

Unverified claim:

```text
You said <X> works but I don't see the output. Run it now and paste the actual result.
```

## Appendix B. What you kept for yourself (material for SOLUTION.md section 5)

- Every design decision in the table at the top, made before the first prompt, plus your own edits to SPEC.md.
- Reviewing every diff against a checklist before anything was committed. Nothing landed unread.
- Independently re-verifying claims: rerunning the psql FK check, the curl flows, the browser walkthrough and the fresh-clone test.
- The correction moments you actually hit, quoted from ai-logs.
- Redaction review of the logs, SOLUTION.md section 5 in your words, and the video.
- What you would change next time. Candidates: writing the e2e tests before the endpoints, tighter prompts where you had to correct, or running in default permission mode to see every command.

## Appendix C. Pitfalls

- Port 5432 is already in use on this Mac. Everything uses 5433.
- Docker Desktop must be running before Phase 2.
- Node 25 is installed here. If Prisma or Nest complain, install Node 22 LTS with `brew install node@22`, use it, and keep `.nvmrc` at 22.
- If Claude commits without being asked, does more than the step, or reports success without pasted output, treat it as a correction moment and say so explicitly.
- Never put a real secret anywhere. JWT_SECRET in `.env.example` is a labelled local dev value.
- Do not commit the PDF, the text export, or this runbook.
- Claude Code adds a `Co-Authored-By: Claude` trailer to commits by default. Keep it or remove it, but be consistent. For an AI-native role keeping it is fine.
