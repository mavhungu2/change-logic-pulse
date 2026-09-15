-- ############################################################################
-- Two invariants that were being enforced by the service layer alone, found by
-- a security review. Both are reachable by any caller that issues SQL, which
-- includes the seed, a future repository, and anyone with the app's credentials.
-- ############################################################################

-- ---------------------------------------------------------------------------
-- S4: an answer could reference another tenant's question.
--
-- The old foreign key bound an answer to its question's TYPE but not to its
-- ORGANIZATION, so an answer in org A could name a question in org B and the
-- database accepted it — foreign key checks are not filtered by row-level
-- security. Only a lookup in the response repository stood in the way.
--
-- Beyond the cross-tenant reference itself, ON DELETE RESTRICT meant org A's
-- row would then prevent org B from deleting its own question.
--
-- Three columns rather than two: type AND organization.
-- ---------------------------------------------------------------------------

ALTER TABLE "answers" DROP CONSTRAINT "answers_question_id_question_type_fkey";

DROP INDEX "questions_id_type_key";

CREATE UNIQUE INDEX "questions_id_type_org_id_key" ON "questions"("id", "type", "org_id");

ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_question_type_org_id_fkey"
  FOREIGN KEY ("question_id", "question_type", "org_id")
  REFERENCES "questions"("id", "type", "org_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- S7: "a survey has at least one question" and "a response answers every
-- question on its survey" existed only in the repositories.
--
-- Neither can be a CHECK — both count rows in another table. They are DEFERRED
-- constraint triggers, so they are evaluated at COMMIT: the natural write order
-- (insert the parent, then its children, in one transaction) satisfies them,
-- and a transaction that ends without the children is rejected.
--
-- SECURITY INVOKER, deliberately: the counts are then subject to the caller's
-- row-level security, so the trigger sees exactly the rows the caller does and
-- cannot be used to probe another tenant.
-- ---------------------------------------------------------------------------

CREATE FUNCTION assert_survey_has_questions() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM questions q WHERE q.survey_id = NEW.id) THEN
    RAISE EXCEPTION 'survey % was committed with no questions; a survey must have between 1 and 3', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER surveys_require_questions
  AFTER INSERT ON surveys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_survey_has_questions();

CREATE FUNCTION assert_response_is_complete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
DECLARE
  expected integer;
  actual   integer;
BEGIN
  SELECT count(*) INTO expected FROM questions q WHERE q.survey_id = NEW.survey_id;
  SELECT count(*) INTO actual   FROM answers   a WHERE a.response_id = NEW.id;

  IF actual <> expected THEN
    RAISE EXCEPTION
      'response % carries % answers but its survey has % questions; every question must be answered',
      NEW.id, actual, expected
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER responses_require_answers
  AFTER INSERT ON responses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_response_is_complete();
