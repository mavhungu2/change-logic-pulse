import { Injectable } from '@nestjs/common';
import type { AuthDirectory, TenantContext } from './contract.js';
import { TenantDb } from './tenant-db.js';

@Injectable()
export class PostgresAuthDirectory implements AuthDirectory {
  constructor(private readonly db: TenantDb) {}

  async findContextByEmail(email: string): Promise<TenantContext | null> {
    // app_auth_lookup is SECURITY DEFINER and returns claim fields only. A plain
    // SELECT on users from this connection returns nothing: the table has FORCE
    // ROW LEVEL SECURITY and there is no tenant yet.
    const row = await this.db.lookupAuthContext(email);
    return row ? { userId: row.user_id, orgId: row.org_id, role: row.user_role } : null;
  }
}
