import pg from 'pg';

interface RoleRow {
  readonly role: string;
  readonly is_superuser: boolean;
  readonly bypasses_rls: boolean;
  readonly tables_owned: number;
}

/**
 * Refuses to serve if the API's database role is privileged.
 *
 * Every isolation guarantee in this system assumes the application connects as
 * a role that owns nothing and cannot bypass row-level security. That is a
 * property of a connection string in an environment variable, which is to say
 * it is one careless edit from being false — and if it becomes false, nothing
 * fails loudly: queries simply start returning more than they should.
 *
 * So it is asserted at startup, against the actual connection, rather than
 * trusted.
 */
export async function assertRuntimeRoleIsLeastPrivileged(
  connectionString: string,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const { rows } = await client.query<RoleRow>(`
      SELECT current_user                                            AS role,
             r.rolsuper                                              AS is_superuser,
             r.rolbypassrls                                          AS bypasses_rls,
             (SELECT count(*)::int FROM pg_class c
               WHERE c.relowner = r.oid AND c.relkind = 'r')         AS tables_owned
      FROM pg_roles r
      WHERE r.rolname = current_user
    `);

    const row = rows[0];
    if (!row) throw new Error('Could not determine the database role the API connects as.');

    const problems: string[] = [];
    if (row.is_superuser) problems.push('is a superuser');
    if (row.bypasses_rls) problems.push('has BYPASSRLS');
    if (row.tables_owned > 0) {
      problems.push(
        `owns ${row.tables_owned} tables — an owner bypasses its own policies on any table ` +
          'that is not FORCEd, so ownership must not be the application’s',
      );
    }

    if (problems.length > 0) {
      throw new Error(
        `The API is connecting as "${row.role}", which ${problems.join(' and ')}. ` +
          'Point DATABASE_URL at the restricted application role.',
      );
    }
  } finally {
    await client.end();
  }
}
