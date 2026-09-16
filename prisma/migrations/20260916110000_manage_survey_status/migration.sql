-- Managing a survey means one thing here: taking it out of circulation, and
-- putting it back. That is a change of status and nothing else, so the privilege
-- is granted on the status column alone.
--
-- A plain GRANT UPDATE ON "surveys" would also hand the API the ability to
-- retitle a survey that already has responses filed under it, or to rewrite
-- created_by, or to move the row to another organization. The application has no
-- reason to do any of those, and a column-level grant means it cannot — enforced
-- by PostgreSQL on every statement, rather than by a service that chooses not to
-- write one. The surveys_update policy from the initial migration already
-- confines the row to the caller's organization, with USING and WITH CHECK.
GRANT UPDATE ("status") ON "surveys" TO pulse_app;

-- The legal destinations are 'active' and 'archived'. 'draft' is an insert-time
-- state only: once a survey has been published, members may have answered it,
-- and unpublishing would leave those responses filed under a survey that claims
-- never to have run.
--
-- This cannot be a CHECK. A CHECK sees only the row being written, never the row
-- being replaced, so it cannot express a rule about a transition. A BEFORE
-- UPDATE trigger is the schema-level form of that rule, and it holds for a psql
-- session that never goes near the API.
--
-- SECURITY INVOKER, which is the default and is deliberate: the function reads
-- OLD and NEW and touches no table, so there is nothing here for row-level
-- security to filter, and nothing gained by running it as the owner.
CREATE FUNCTION app_forbid_return_to_draft() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
BEGIN
  IF NEW."status" = 'draft' AND OLD."status" <> 'draft' THEN
    RAISE EXCEPTION
      'survey %: a published survey cannot return to draft (% -> %)',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

-- OF "status": the trigger fires only for statements that actually assign the
-- column, so nothing else pays for it.
CREATE TRIGGER "surveys_status_transition"
  BEFORE UPDATE OF "status" ON "surveys"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_return_to_draft();
