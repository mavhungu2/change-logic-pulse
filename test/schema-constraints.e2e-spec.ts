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
