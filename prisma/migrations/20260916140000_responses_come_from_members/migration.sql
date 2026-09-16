-- ############################################################################
-- The last invariant still enforced by the service layer alone.
--
-- The completion rate divides by the number of users in the organization with
-- role 'member'. Nothing constrained the numerator to the same population: a
-- response written for a manager would count toward a total it was excluded
-- from, and a survey could report more completions than the org has members.
--
-- The only thing preventing it was @Roles('member') on the controller — an
-- application rule guarding a number the database computes, reachable by
-- anything that issues SQL. That is the same argument that moved every other
-- invariant in this schema down here.
-- ############################################################################

-- ---------------------------------------------------------------------------
-- Nothing already stored may violate the rule being added.
--
-- FORCE applies to the owner too, and a migration runs with no tenant set, so an
-- unscoped count here reads zero rows and proves nothing — the same trap the S9
-- migration documents for ADD FOREIGN KEY. Lifted for the length of the check,
-- on both tables, because an invisible user looks exactly like an absent one.
-- ---------------------------------------------------------------------------

ALTER TABLE "responses" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "users"     NO FORCE ROW LEVEL SECURITY;

DO $check$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
  FROM "responses" r JOIN "users" u ON u."id" = r."user_id"
  WHERE u."role" <> 'member';

  IF offending > 0 THEN
    RAISE EXCEPTION
      '% response(s) were written for a user who is not a member. These predate the '
      'trigger below and must be reviewed before it can be trusted.', offending
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$check$;

ALTER TABLE "responses" FORCE ROW LEVEL SECURITY;
ALTER TABLE "users"     FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- And nothing written from here on.
--
-- This cannot be a CHECK: the responder's role lives in another table and a
-- CHECK cannot contain a subquery. The pattern used for answers — denormalise
-- the parent's column, pin it with a composite foreign key — would express it,
-- at the cost of a column, a backfill, and a validation scan subject to the
-- trap above. It would also make ON UPDATE CASCADE carry a later role change
-- into responses already filed. A trigger reads the role where it already is.
--
-- SECURITY INVOKER, as with the other assertions here: the lookup runs under the
-- caller's row-level security, so it sees only users in the caller's own
-- organization. It does not need to see further. responses_user_id_org_id_fkey
-- already requires the responder to be in the response's organization — but that
-- foreign key has not run yet at BEFORE INSERT time, so a user from another
-- tenant arrives here as NULL rather than as a role, and is refused on that
-- footing rather than passed along.
--
-- BEFORE, not a deferred constraint trigger: unlike "a response answers every
-- question on its survey", nothing here waits on rows written later in the
-- transaction, so it should fail at the statement that is wrong rather than at
-- COMMIT.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_assert_responder_is_member() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
DECLARE
  responder "role";
BEGIN
  SELECT u."role" INTO responder FROM "users" u WHERE u."id" = NEW."user_id";

  IF responder IS DISTINCT FROM 'member' THEN
    RAISE EXCEPTION
      'user % may not answer a survey: responses come from members, and this one is %',
      NEW."user_id",
      coalesce(responder::text, 'not visible from this organization')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$;

-- OF "user_id": an UPDATE that does not reassign the responder does not pay for
-- this. The API holds no UPDATE grant on responses at all; the owner does, and
-- the rule should hold for a psql session that never goes near the API.
CREATE TRIGGER "responses_come_from_members"
  BEFORE INSERT OR UPDATE OF "user_id" ON "responses"
  FOR EACH ROW EXECUTE FUNCTION app_assert_responder_is_member();
