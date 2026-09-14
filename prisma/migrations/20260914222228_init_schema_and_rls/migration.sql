-- CreateEnum
CREATE TYPE "role" AS ENUM ('manager', 'member');

-- CreateEnum
CREATE TYPE "survey_status" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "question_type" AS ENUM ('rating', 'yes_no');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "logo_url" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "role" NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "survey_status" NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "survey_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "type" "question_type" NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "survey_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "response_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "question_type" "question_type" NOT NULL,
    "rating_value" SMALLINT,
    "bool_value" BOOLEAN,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_org_id_key" ON "users"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "surveys_id_org_id_key" ON "surveys"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "questions_survey_id_position_key" ON "questions"("survey_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "questions_id_type_key" ON "questions"("id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "responses_survey_id_user_id_week_start_key" ON "responses"("survey_id", "user_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "responses_id_org_id_key" ON "responses"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "answers_response_id_question_id_key" ON "answers"("response_id", "question_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_created_by_org_id_fkey" FOREIGN KEY ("created_by", "org_id") REFERENCES "users"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_survey_id_org_id_fkey" FOREIGN KEY ("survey_id", "org_id") REFERENCES "surveys"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responses" ADD CONSTRAINT "responses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responses" ADD CONSTRAINT "responses_survey_id_org_id_fkey" FOREIGN KEY ("survey_id", "org_id") REFERENCES "surveys"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responses" ADD CONSTRAINT "responses_user_id_org_id_fkey" FOREIGN KEY ("user_id", "org_id") REFERENCES "users"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_response_id_org_id_fkey" FOREIGN KEY ("response_id", "org_id") REFERENCES "responses"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_question_type_fkey" FOREIGN KEY ("question_id", "question_type") REFERENCES "questions"("id", "type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ############################################################################
-- Everything below this line is hand-written. Prisma does not model CHECK
-- constraints, row-level security, grants or functions, so it neither creates
-- them nor notices if they go missing — which is exactly why they live here, in
-- the versioned migration, rather than in a setup script someone has to
-- remember to run. `prisma migrate deploy` against an empty database produces a
-- secured one; there is no second step.
--
-- Consequence for future migrations: a new tenant table is not finished until
-- it has ENABLE + FORCE, four policies, and its own GRANT. There is no default
-- privilege to fall back on, by design.
-- ############################################################################

-- ---------------------------------------------------------------------------
-- Invariants the service layer must not be trusted with
-- ---------------------------------------------------------------------------

-- Caps a survey at three questions structurally: positions are 1..3 and
-- UNIQUE(survey_id, position) already forbids reuse. A service that counted
-- rows first would race a concurrent insert; this cannot.
ALTER TABLE "questions" ADD CONSTRAINT "questions_position_range"
  CHECK ("position" BETWEEN 1 AND 3);

-- The answer's populated column must match its question's type. This is only
-- expressible because question_type is denormalised onto answers and pinned to
-- the question by answers_question_id_question_type_fkey above: a CHECK cannot
-- contain a subquery, so it cannot consult "questions" directly.
ALTER TABLE "answers" ADD CONSTRAINT "answers_value_matches_question_type" CHECK (
  ("question_type" = 'rating' AND "rating_value" IS NOT NULL AND "bool_value"   IS NULL)
  OR
  ("question_type" = 'yes_no' AND "bool_value"   IS NOT NULL AND "rating_value" IS NULL)
);

ALTER TABLE "answers" ADD CONSTRAINT "answers_rating_range"
  CHECK ("rating_value" IS NULL OR "rating_value" BETWEEN 1 AND 5);

-- ---------------------------------------------------------------------------
-- The current tenant, defined once
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_current_org_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $fn$ SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid $fn$;

COMMENT ON FUNCTION app_current_org_id() IS $c$
Resolves the current tenant from the request-scoped GUC, and is the only place
that reads it. Returns NULL when unset; since NULL = anything is NULL and never
true, every policy denies every row by default.

The NULLIF is load-bearing. current_setting(_, true) yields NULL only until the
GUC is first set: once a transaction that set it commits, the setting reverts to
the empty string for the rest of that pooled connection's life. Without NULLIF,
''::uuid raises invalid input syntax instead of matching nothing, so the second
request on a reused connection fails with a 500 rather than an empty result.
$c$;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Policies are permissive and carry no TO clause, so they bind every role
-- including pulse_owner, which is what FORCE ROW LEVEL SECURITY makes possible.
-- Four separate policies per table rather than one FOR ALL: INSERT and UPDATE
-- need WITH CHECK to constrain the row being written, and a single FOR ALL
-- policy makes it easy to supply USING and believe writes are covered.
--
-- Policies decide WHICH ROWS. Grants decide WHICH VERBS, and are narrower than
-- the policies on purpose: the policy set is complete so that a later GRANT
-- cannot outrun it.
-- ---------------------------------------------------------------------------

-- organizations is the tenant, so it is keyed on its own id rather than org_id.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "organizations_select" ON "organizations" FOR SELECT
  USING ("id" = app_current_org_id());
CREATE POLICY "organizations_insert" ON "organizations" FOR INSERT
  WITH CHECK ("id" = app_current_org_id());
CREATE POLICY "organizations_update" ON "organizations" FOR UPDATE
  USING      ("id" = app_current_org_id())
  WITH CHECK ("id" = app_current_org_id());
CREATE POLICY "organizations_delete" ON "organizations" FOR DELETE
  USING ("id" = app_current_org_id());

-- The remaining tenant tables are identical apart from their name, so they are
-- generated from one list. A hand-written block of twenty policies invites the
-- one failure this design cannot tolerate: a table that quietly has none.
DO $rls$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['users', 'surveys', 'questions', 'responses', 'answers']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tenant_table);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (org_id = app_current_org_id())',
      tenant_table || '_select', tenant_table);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (org_id = app_current_org_id())',
      tenant_table || '_insert', tenant_table);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (org_id = app_current_org_id()) '
      'WITH CHECK (org_id = app_current_org_id())',
      tenant_table || '_update', tenant_table);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (org_id = app_current_org_id())',
      tenant_table || '_delete', tenant_table);
  END LOOP;
END
$rls$;

-- ---------------------------------------------------------------------------
-- Login: the one read that cannot be tenant-scoped
--
-- POST /auth/login arrives with an email and no context, because the lookup is
-- what establishes the context. FORCE means a SECURITY DEFINER function is
-- still subject to the policies above, so the exception has to be explicit.
--
-- It is granted to pulse_owner only. pulse_app can set app.auth_lookup itself —
-- any role can set a custom GUC — and it gains nothing, because this policy
-- never applies to it. The function is the only way through, and it returns
-- three columns.
-- ---------------------------------------------------------------------------

CREATE POLICY "users_auth_lookup" ON "users" FOR SELECT TO pulse_owner
  USING (current_setting('app.auth_lookup', true) = 'on');

CREATE FUNCTION app_auth_lookup(p_email text)
  RETURNS TABLE (user_id uuid, org_id uuid, user_role "role")
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  SET app.auth_lookup = 'on'
  AS $fn$ SELECT u."id", u."org_id", u."role" FROM "users" u WHERE u."email" = p_email $fn$;

COMMENT ON FUNCTION app_auth_lookup(text) IS
  'Development-only login lookup. The single deliberate hole in tenant isolation; returns claim fields only, never a row.';

-- ---------------------------------------------------------------------------
-- Exactly what pulse_app may do
--
-- No UPDATE and no DELETE anywhere: nothing in the product changes or removes a
-- row. No grant at all on _prisma_migrations. The UPDATE and DELETE policies
-- above still exist, so adding a verb later is one GRANT and not a new think
-- about isolation.
-- ---------------------------------------------------------------------------

GRANT SELECT                 ON "organizations" TO pulse_app;
GRANT SELECT                 ON "users"         TO pulse_app;
GRANT SELECT, INSERT         ON "surveys"       TO pulse_app;
GRANT SELECT, INSERT         ON "questions"     TO pulse_app;
GRANT SELECT, INSERT         ON "responses"     TO pulse_app;
GRANT SELECT, INSERT         ON "answers"       TO pulse_app;

GRANT EXECUTE ON FUNCTION app_current_org_id()    TO pulse_app;
GRANT EXECUTE ON FUNCTION app_auth_lookup(text)   TO pulse_app;
