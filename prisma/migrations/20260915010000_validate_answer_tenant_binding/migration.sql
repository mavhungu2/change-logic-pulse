-- ############################################################################
-- S9: adding the foreign key did not check the data already in the table.
--
-- ALTER TABLE ... ADD FOREIGN KEY validates existing rows with a scan that IS
-- subject to row-level security. Under FORCE ROW LEVEL SECURITY, and with no
-- tenant set — which is every migration — the migration role sees zero rows, so
-- the scan finds nothing to complain about and the constraint is recorded as
-- convalidated = true while violating rows sit underneath it.
--
-- (ADD CHECK behaves differently: that one scans the heap and does catch
-- violations. The asymmetry is easy to miss and there is no warning.)
--
-- Consequence for this schema: every composite foreign key that binds a child
-- to its parent's organization — the mechanism the whole tenancy design rests
-- on — governs new rows only if it was added to a populated table. This
-- migration re-adds the answers key with FORCE lifted for the duration, so the
-- validation scan actually sees the data.
--
-- Any future migration adding a constraint to a tenant table must do the same.
-- ############################################################################

-- Both sides: the validation scan reads the referencing table AND the
-- referenced one, and an invisible parent looks exactly like a missing parent.
ALTER TABLE "answers"   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "questions" NO FORCE ROW LEVEL SECURITY;

-- Fail loudly rather than delete somebody's data. On a clean install there is
-- nothing to find and this is a no-op.
DO $check$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
  FROM answers a JOIN questions q ON q.id = a.question_id
  WHERE q.org_id <> a.org_id;

  IF offending > 0 THEN
    RAISE EXCEPTION
      '% answer(s) reference a question in another organization. These predate the '
      'foreign key and must be reviewed and removed before it can be validated.', offending
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$check$;

-- Re-add it so validation runs for real this time.
ALTER TABLE "answers" DROP CONSTRAINT "answers_question_id_question_type_org_id_fkey";
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_question_type_org_id_fkey"
  FOREIGN KEY ("question_id", "question_type", "org_id")
  REFERENCES "questions"("id", "type", "org_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "answers"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "questions" FORCE ROW LEVEL SECURITY;
