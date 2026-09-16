/**
 * Invariants that must live in the schema rather than in a service.
 *
 * Every test here talks to PostgreSQL directly, because the point is what the
 * database refuses — a rule the service enforces is a rule the next caller can
 * forget, and these are reached through raw SQL precisely to go around it.
 */
import 'dotenv/config';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { Client } = pg;

let owner: pg.Client;
/** The role the API actually connects as — what it may write is the point. */
let appUser: pg.Client;
let orgA = '';
let orgB = '';
let surveyA = '';
let managerA = '';
let memberA = '';
let responseA = '';
let questionB = '';

async function scoped<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  await owner.query('BEGIN');
  try {
    await owner.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    const result = await work();
    await owner.query('COMMIT');
    return result;
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

/**
 * Runs one statement as the given role and always rolls back, returning the
 * error if any.
 *
 * Rolling back rather than committing matters while the rule being tested does
 * not exist yet: a test that watches a write succeed must not leave that write
 * in the seeded data the demo reads.
 */
async function probe(
  client: pg.Client,
  orgId: string,
  sql: string,
  params: unknown[] = [],
): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await client.query(sql, params);
    return null;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Runs one statement in its own transaction and returns the error, if any. */
async function attempt(orgId: string, sql: string, params: unknown[] = []): Promise<string | null> {
  await owner.query('BEGIN');
  try {
    await owner.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await owner.query(sql, params);
    // Deferred constraints fire here, not at the statement.
    await owner.query('COMMIT');
    return null;
  } catch (error) {
    await owner.query('ROLLBACK');
    return (error as Error).message;
  }
}

beforeAll(async () => {
  owner = new Client({ connectionString: process.env['MIGRATION_DATABASE_URL']! });
  await owner.connect();

  appUser = new Client({ connectionString: process.env['DATABASE_URL']! });
  await appUser.connect();

  // organizations is FORCE-protected against the owner too, so an unscoped
  // SELECT here returns nothing. app_auth_lookup is the one path that resolves
  // an org without already being inside one — which is exactly why it exists.
  const lookup = async (email: string): Promise<string> =>
    (await owner.query<{ org_id: string }>(`SELECT org_id FROM app_auth_lookup($1)`, [email]))
      .rows[0]?.org_id ?? '';

  orgA = await lookup('manager@northwind.test');
  orgB = await lookup('manager@seabird.test');

  if (!orgA || !orgB) throw new Error('Seed the database first: npm run db:seed');

  await scoped(orgA, async () => {
    surveyA = (await owner.query<{ id: string }>(`SELECT id FROM surveys LIMIT 1`)).rows[0]!.id;
    managerA = (
      await owner.query<{ id: string }>(`SELECT id FROM users WHERE role = 'manager' LIMIT 1`)
    ).rows[0]!.id;
    memberA = (
      await owner.query<{ id: string }>(`SELECT id FROM users WHERE role = 'member' LIMIT 1`)
    ).rows[0]!.id;
    responseA = (await owner.query<{ id: string }>(`SELECT id FROM responses LIMIT 1`)).rows[0]!.id;
  });

  await scoped(orgB, async () => {
    questionB = (
      await owner.query<{ id: string }>(`SELECT id FROM questions WHERE type = 'rating' LIMIT 1`)
    ).rows[0]!.id;
  });
});

afterAll(async () => {
  await owner?.end();
  await appUser?.end();
});

describe('S4 — an answer cannot reference another tenant’s question', () => {
  it('is rejected by the schema, not merely by the service', async () => {
    const error = await attempt(
      orgA,
      `INSERT INTO answers (response_id, question_id, org_id, question_type, rating_value)
       VALUES ($1, $2, $3, 'rating', 5)`,
      [responseA, questionB, orgA],
    );
    expect(error, 'an answer in org A accepted org B’s question').not.toBeNull();
    expect(error).toMatch(/foreign key|violates/i);
  });

  it('still accepts a complete, correctly-scoped response', async () => {
    // The happy path, in the natural write order: parent then children, one
    // transaction. Proves the new foreign key and both triggers permit what the
    // application actually does.
    const error = await attempt(
      orgA,
      `WITH r AS (
         INSERT INTO responses (survey_id, user_id, org_id, week_start)
         VALUES ($1, $2, $3, DATE '2025-02-03') RETURNING id
       )
       INSERT INTO answers (response_id, question_id, org_id, question_type, rating_value, bool_value)
       SELECT r.id, q.id, $3, q.type,
              CASE WHEN q.type = 'rating' THEN 3 END,
              CASE WHEN q.type = 'yes_no' THEN false END
       FROM r CROSS JOIN questions q WHERE q.survey_id = $1`,
      [surveyA, memberA, orgA],
    );
    expect(error).toBeNull();

    await attempt(
      orgA,
      `DELETE FROM answers WHERE response_id IN
         (SELECT id FROM responses WHERE survey_id = $1 AND week_start = DATE '2025-02-03')`,
      [surveyA],
    );
    await attempt(orgA, `DELETE FROM responses WHERE survey_id = $1 AND week_start = DATE '2025-02-03'`, [
      surveyA,
    ]);
  });
});

describe('S9 — no answer already references another tenant’s question', () => {
  it('holds for the data actually in the database', async () => {
    // Adding the foreign key was not enough. FOREIGN KEY validation is subject
    // to row-level security, so under FORCE the migration role scanning for
    // violations sees no rows, validates against nothing, and marks the
    // constraint validated anyway. (ADD CHECK is not subject to it — that scans
    // the heap and does catch violations.) So the constraint governs new rows
    // only, and anything already wrong survives it.
    //
    // This check must run INSIDE each tenant, not across them: an unscoped
    // query here sees nothing and passes vacuously, which is the same blindness
    // that let the bad row through in the first place. Scoped to one
    // organization, an answer whose question is not visible is an answer whose
    // question belongs to somebody else.
    for (const org of [orgA, orgB]) {
      const orphans = await scoped(org, async () =>
        Number(
          (
            await owner.query<{ count: string }>(`
              SELECT count(*)::text AS count FROM answers a
              WHERE NOT EXISTS (SELECT 1 FROM questions q WHERE q.id = a.question_id)`)
          ).rows[0]!.count,
        ),
      );
      expect(orphans, `org ${org} holds answers pointing outside it`).toBe(0);
    }
  });
});

describe('S7 — a survey must have at least one question', () => {
  it('rejects a survey committed with no questions', async () => {
    const error = await attempt(
      orgA,
      `INSERT INTO surveys (org_id, title, status, created_by) VALUES ($1, 'empty', 'draft', $2)`,
      [orgA, managerA],
    );
    expect(error, 'a survey with no questions was committed').not.toBeNull();
    expect(error).toMatch(/question/i);
  });
});

describe('S7 — a response must answer every question on its survey', () => {
  it('rejects a response committed with no answers', async () => {
    const error = await attempt(
      orgA,
      `INSERT INTO responses (survey_id, user_id, org_id, week_start)
       VALUES ($1, $2, $3, DATE '2025-01-06')`,
      [surveyA, memberA, orgA],
    );
    expect(error, 'a response with no answers was committed').not.toBeNull();
    expect(error).toMatch(/answer/i);
  });
});

describe('managing a survey is a privilege the schema grants narrowly', () => {
  it('lets the application role change a status', async () => {
    const error = await probe(appUser, orgA, `UPDATE surveys SET status = 'archived' WHERE id = $1`, [
      surveyA,
    ]);
    expect(error, 'the API cannot close a survey at all').toBeNull();
  });

  it('refuses to let the application role rewrite a title', async () => {
    // The column-level grant is the control, not a service that declines to
    // build the statement. Retitling a survey that already has responses
    // relabels history, so the API is not given the ability in the first place.
    const error = await probe(appUser, orgA, `UPDATE surveys SET title = 'renamed' WHERE id = $1`, [
      surveyA,
    ]);
    expect(error, 'the API rewrote a survey title').not.toBeNull();
    expect(error).toMatch(/permission denied/i);
  });

  it('refuses to let it move a survey to another organization', async () => {
    const refused = await probe(appUser, orgA, `UPDATE surveys SET org_id = $2 WHERE id = $1`, [
      surveyA,
      orgB,
    ]);
    expect(refused, 'a survey was reassigned to another tenant').not.toBeNull();
    expect(refused).toMatch(/permission denied/i);

    // Two independent controls, and this asserts the second one rather than
    // trusting it: the owner has full UPDATE on surveys, so the grant is not
    // what stops it here. The surveys_update policy's WITH CHECK is — a row
    // cannot be written into an organization the caller is not inside, whatever
    // privileges the writer holds. Widening the grant above would not open this.
    const stillRefused = await probe(owner, orgA, `UPDATE surveys SET org_id = $2 WHERE id = $1`, [
      surveyA,
      orgB,
    ]);
    expect(stillRefused, 'the owner moved a survey between tenants').not.toBeNull();
    expect(stillRefused).toMatch(/row-level security/i);
  });

  it('refuses to return a published survey to draft, even as the owner', async () => {
    // A CHECK cannot express this: it never sees the previous value. So it is a
    // BEFORE UPDATE trigger — still the schema, still applied by the migration,
    // and still true for a psql session that never goes near the API.
    const error = await probe(owner, orgA, `UPDATE surveys SET status = 'draft' WHERE id = $1`, [
      surveyA,
    ]);
    expect(error, 'an active survey was quietly unpublished').not.toBeNull();
    expect(error).toMatch(/draft/i);
  });
});
