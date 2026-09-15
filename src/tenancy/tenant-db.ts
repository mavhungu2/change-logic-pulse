import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { databaseScope } from './internal-scope.js';
import { createGuardedClient, type PrismaClient } from './prisma.js';
import { tenantContext } from './tenant-context.js';

export type TenantTransaction = Prisma.TransactionClient;

@Injectable()
export class TenantDb implements OnModuleDestroy {
  readonly #client: PrismaClient;

  constructor() {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not set');
    this.#client = createGuardedClient(url);
  }

  /**
   * Runs `work` in a transaction already scoped to the caller's organization.
   * This is the only route to the database.
   *
   * ── Where the transaction boundary is ──────────────────────────────────────
   *
   * It is this method. `$transaction` issues BEGIN before the callback runs and
   * COMMIT — or ROLLBACK, if `work` throws — after it settles. The GUC is
   * applied as the first statement inside that transaction, so the tenant is
   * set for exactly the statements in `work` and for nothing before or after.
   *
   * ── Why SET LOCAL and never SET ────────────────────────────────────────────
   *
   * This is the single mistake that would silently break tenancy, so it is
   * worth being precise about the mechanism.
   *
   * The API reaches PostgreSQL through a connection pool. The physical
   * connection serving this request is handed back afterwards and will serve
   * other requests, belonging to other organizations. A bare
   *
   *     SET app.current_org_id = '<org A>'
   *
   * is SESSION scoped. It survives COMMIT and stays on that pooled connection.
   * The next request to borrow that connection begins already scoped to org A.
   * If that request belongs to org B and its code forgets — or throws before —
   * setting the GUC, its queries read and write org A's rows, and every policy
   * in the database agrees, because as far as PostgreSQL can tell the caller
   * *is* org A. Row-level security is working perfectly and answering the wrong
   * question.
   *
   * There is no error, no log line, and no failing test unless someone writes
   * one for it specifically: any test that issues a single request passes,
   * because a fresh connection carries no leftover value. The bug appears only
   * under concurrency, in production, as one customer seeing another's data.
   *
   * Transaction scope is what makes pooling safe: at COMMIT the setting reverts
   * and the connection returns to the pool carrying nothing. (Nothing, but not
   * NULL — a GUC that has been set once reverts to the empty string, which is
   * why app_current_org_id() in the migration guards with NULLIF before casting
   * to uuid.)
   *
   * We write it as set_config(name, value, is_local => true) rather than the
   * literal `SET LOCAL`. Identical scope, one difference that matters: `SET
   * LOCAL` cannot take a bind parameter — `PREPARE ... AS SET LOCAL ...` is a
   * syntax error — so using it means interpolating the organization id into SQL
   * text, on the one value that decides which tenant's data is visible.
   * set_config takes it as a parameter.
   */
  async run<T>(work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    const { orgId } = tenantContext.require();

    return this.#client.$transaction(async (tx) => {
      return databaseScope.run({ reason: 'tenant' }, async () => {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
        // `return await`, not `return`. Prisma promises are lazy: they dispatch
        // when awaited, not when constructed. Returning one unawaited would hand
        // it back before AsyncLocalStorage.run() exits, so the query would be
        // dispatched outside the scope and the guard above would reject it.
        return await work(tx);
      });
    });
  }

  /**
   * The login lookup, which runs before any tenant exists — the lookup is what
   * establishes it. It reaches the database through app_auth_lookup, a
   * SECURITY DEFINER function that returns claim fields and nothing else; the
   * users table itself stays closed to this connection. See the migration.
   */
  async runAuthLookup<T>(work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.#client.$transaction(async (tx) =>
      databaseScope.run({ reason: 'auth' }, async () => await work(tx)),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.#client.$disconnect();
  }
}
