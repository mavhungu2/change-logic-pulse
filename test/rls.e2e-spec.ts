/**
 * The RLS proof.
 *
 * This test connects to PostgreSQL directly as the application's database role
 * and issues bare SQL. It does not import the Nest app, a service, a repository
 * or Prisma, and it must never be changed to — the whole value of it is that it
 * proves the *policies* enforce isolation, rather than proving that some service
 * layer remembered to add a WHERE clause. If this suite ever needs application
 * code to pass, it has stopped testing what it claims to test.
 *
 * Run with: npm run test:e2e   (requires `npm run db:up` and a migrated database)
 */

import 'dotenv/config';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { Client } = pg;

const ORG_A = '0a000000-0000-4000-8000-00000000000a';
const ORG_B = '0b000000-0000-4000-8000-00000000000b';

const MGR_A = '0a000000-0000-4000-8000-00000000aa01';
const MGR_B = '0b000000-0000-4000-8000-00000000bb01';

/** Every table that carries tenant data. A new one belongs here and in the migration. */
const TENANT_TABLES = [
  'answers',
  'organizations',
  'questions',
  'responses',
  'surveys',
  'users',
] as const;

/** Org A has two surveys and org B has one, so a leak is visible as a count. */
const SURVEYS_A = ['A — alpha', 'A — beta'];
const SURVEYS_B = ['B — only'];

/** Runs `work` in a transaction scoped to `orgId`, exactly as the API will. */
async function withOrg<T>(
  client: pg.Client,
  orgId: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    // set_config(_, _, true) is transaction-local and takes a bind parameter.
    // `SET LOCAL` cannot, and would mean interpolating the tenant into SQL.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function connect(url: string | undefined, label: string): Promise<pg.Client> {
  if (!url) throw new Error(`${label} is not set — copy .env.example to .env`);
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Owner connection: used ONLY to build and tear down fixtures, never to assert. */
let owner: pg.Client;
/** The role the API connects as. Every assertion below runs on this. */
let appUser: pg.Client;

async function seedOrg(
  orgId: string,
  managerId: string,
  name: string,
  titles: readonly string[],
): Promise<void> {
  await withOrg(owner, orgId, async () => {
    await owner.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, name]);
    await owner.query(
      `INSERT INTO users (id, org_id, email, name, role)
       VALUES ($1, $2, $3, $4, 'manager')`,
      [managerId, orgId, `mgr@${name.toLowerCase()}.test`, `Manager ${name}`],
    );
    for (const title of titles) {
      await owner.query(
        `INSERT INTO surveys (org_id, title, status, created_by)
         VALUES ($1, $2, 'active', $3)`,
        [orgId, title, managerId],
      );
    }
  });
}

async function dropOrg(orgId: string): Promise<void> {
  await withOrg(owner, orgId, async () => {
    await owner.query('DELETE FROM surveys WHERE org_id = $1', [orgId]);
    await owner.query('DELETE FROM users WHERE org_id = $1', [orgId]);
    await owner.query('DELETE FROM organizations WHERE id = $1', [orgId]);
  });
}

beforeAll(async () => {
  owner = await connect(process.env['MIGRATION_DATABASE_URL'], 'MIGRATION_DATABASE_URL');
  await dropOrg(ORG_A);
  await dropOrg(ORG_B);
  await seedOrg(ORG_A, MGR_A, 'OrgA', SURVEYS_A);
  await seedOrg(ORG_B, MGR_B, 'OrgB', SURVEYS_B);

  appUser = await connect(process.env['DATABASE_URL'], 'DATABASE_URL');
});

afterAll(async () => {
  await appUser?.end();
  await dropOrg(ORG_A);
  await dropOrg(ORG_B);
  await owner?.end();
});

describe('row-level security, as app_user, with no application code involved', () => {
  it('the role under test is not privileged', async () => {
    // If this fails, nothing else in this file means anything.
    const { rows } = await appUser.query<{
      current_user: string;
      is_superuser: boolean;
      bypasses_rls: boolean;
      owns_tables: string;
    }>(`
      SELECT current_user,
             rolsuper     AS is_superuser,
             rolbypassrls AS bypasses_rls,
             (SELECT count(*) FROM pg_class
               WHERE relowner = r.oid AND relkind = 'r')::text AS owns_tables
      FROM pg_roles r WHERE rolname = current_user
    `);
    expect(rows[0]).toMatchObject({
      current_user: 'pulse_app',
      is_superuser: false,
      bypasses_rls: false,
      owns_tables: '0',
    });
  });

  it('every tenant table is protected — catches policies that quietly go missing', async () => {
    // Dropping a policy makes a table MORE restrictive, so the fails-closed tests
    // below still pass without it. Only this test notices a table that has lost
    // its policies, or a new table that never got any.
    //
    // It asserts policy *identity*, not just that each command is covered
    // somewhere: users carries a second, deliberately permissive SELECT policy
    // for the login lookup, so counting distinct commands would report SELECT as
    // covered even with users_select gone — on the one table where that matters
    // most. The expected set is exhaustive, so a rogue policy fails it too.
    const { rows: flags } = await appUser.query<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
    }>(`
      SELECT relname AS table_name, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relkind = 'r' AND relname <> '_prisma_migrations'
      ORDER BY relname
    `);

    expect(flags.map((r) => r.table_name)).toEqual([...TENANT_TABLES]);
    for (const row of flags) {
      expect(row.enabled, `${row.table_name}: ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(row.forced, `${row.table_name}: FORCE ROW LEVEL SECURITY`).toBe(true);
    }

    const { rows: policies } = await appUser.query<{
      policyname: string;
      tablename: string;
      expression: string | null;
    }>(`
      SELECT policyname, tablename, coalesce(qual, with_check) AS expression
      FROM pg_policies WHERE schemaname = 'public'
    `);

    const expected = TENANT_TABLES.flatMap((table) =>
      ['select', 'insert', 'update', 'delete'].map((cmd) => `${table}_${cmd}`),
    );
    expect(policies.map((p) => p.policyname).sort()).toEqual(
      [...expected, 'users_auth_lookup'].sort(),
    );

    for (const name of expected) {
      const policy = policies.find((p) => p.policyname === name);
      expect(policy?.expression, `${name}: must scope by tenant`).toContain(
        'app_current_org_id',
      );
    }
  });

  it('1. scoped to org A, a bare SELECT returns only org A rows', async () => {
    const titles = await withOrg(appUser, ORG_A, async () => {
      const { rows } = await appUser.query<{ title: string; org_id: string }>(
        'SELECT * FROM surveys',
      );
      return rows;
    });

    expect(titles.map((r) => r.title).sort()).toEqual([...SURVEYS_A].sort());
    expect(titles.every((r) => r.org_id === ORG_A)).toBe(true);
    expect(titles).toHaveLength(2);
  });

  it('2. scoped to org B, the same query returns only org B rows', async () => {
    const rows = await withOrg(appUser, ORG_B, async () => {
      const result = await appUser.query<{ title: string; org_id: string }>(
        'SELECT * FROM surveys',
      );
      return result.rows;
    });

    expect(rows.map((r) => r.title)).toEqual([...SURVEYS_B]);
    expect(rows.every((r) => r.org_id === ORG_B)).toBe(true);
    // The decisive assertion: org A's rows exist, and are not here.
    expect(rows.some((r) => SURVEYS_A.includes(r.title))).toBe(false);
  });

  it('3a. with nothing set on a connection that has scoped before, zero rows', async () => {
    // This connection has already run scoped transactions above, so the GUC has
    // reverted to '' rather than NULL. This is the state a pooled connection is
    // actually in, and the one an unguarded ::uuid cast turns into a 500.
    const { rows: setting } = await appUser.query<{ guc: string | null }>(
      `SELECT current_setting('app.current_org_id', true) AS guc`,
    );
    expect(setting[0]?.guc).toBe('');

    const { rows } = await appUser.query('SELECT * FROM surveys');
    expect(rows).toHaveLength(0);
  });

  it('3b. with nothing ever set, on a brand-new connection, zero rows', async () => {
    const fresh = await connect(process.env['DATABASE_URL'], 'DATABASE_URL');
    try {
      const { rows: setting } = await fresh.query<{ guc: string | null }>(
        `SELECT current_setting('app.current_org_id', true) AS guc`,
      );
      expect(setting[0]?.guc).toBeNull();

      const { rows } = await fresh.query('SELECT * FROM surveys');
      expect(rows).toHaveLength(0);
    } finally {
      await fresh.end();
    }
  });

  it('4. an INSERT carrying another org’s org_id is rejected by WITH CHECK', async () => {
    const attempt = withOrg(appUser, ORG_A, () =>
      appUser.query(
        `INSERT INTO surveys (org_id, title, status, created_by)
         VALUES ($1, 'trespass', 'active', $2)`,
        [ORG_B, MGR_B],
      ),
    );

    await expect(attempt).rejects.toThrow(/row-level security policy/i);

    // And nothing was written: org B still has exactly its own survey.
    const rows = await withOrg(appUser, ORG_B, async () => {
      const result = await appUser.query('SELECT * FROM surveys');
      return result.rows;
    });
    expect(rows).toHaveLength(1);
  });
});
