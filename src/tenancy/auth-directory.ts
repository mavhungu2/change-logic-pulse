import { Injectable } from '@nestjs/common';
import type { AuthDirectory, Role, TenantContext } from './contract.js';
import { TenantDb } from './tenant-db.js';

interface AuthRow {
  readonly user_id: string;
  readonly org_id: string;
  readonly user_role: Role;
}

@Injectable()
export class PostgresAuthDirectory implements AuthDirectory {
  constructor(private readonly db: TenantDb) {}

  async findContextByEmail(email: string): Promise<TenantContext | null> {
    // app_auth_lookup is SECURITY DEFINER and returns claim fields only. A plain
    // SELECT on users from this connection returns nothing: the table has FORCE
    // ROW LEVEL SECURITY and there is no tenant yet.
    const rows = await this.db.runAuthLookup(
      (tx) => tx.$queryRaw<AuthRow[]>`SELECT * FROM app_auth_lookup(${email})`,
    );

    const row = rows[0];
    return row ? { userId: row.user_id, orgId: row.org_id, role: row.user_role } : null;
  }
}
