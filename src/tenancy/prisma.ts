import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { databaseScope } from './internal-scope.js';
import { TenancyViolation } from './tenancy.errors.js';

/**
 * The database client, and the guard that makes it useless outside a unit of
 * work opened by TenantDb.
 *
 * Nothing here is exported to the application. The client is constructed by
 * TenantDb, held privately, and never registered as a Nest provider — see
 * tenancy.module.ts. A service that asks for a PrismaClient does not receive an
 * unscoped one; it fails to construct, and the process refuses to boot.
 *
 * The extension below is the second line of defence, for the case where someone
 * gets hold of a client anyway. Every operation — model queries and raw queries
 * alike — is refused unless it is running inside databaseScope, which only this
 * module can enter.
 */
export function createGuardedClient(connectionString: string): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  return client.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        if (databaseScope.getStore() === undefined) {
          throw new TenancyViolation(
            'TENANT_CONTEXT_MISSING',
            `${model ?? 'raw'}.${operation} was issued outside TenantDb.run(). ` +
              'Every query must go through the tenant wrapper so that ' +
              'app.current_org_id is set for the transaction it runs in. ' +
              'Inject a repository, not a database client.',
          );
        }
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
}

export type { PrismaClient };
