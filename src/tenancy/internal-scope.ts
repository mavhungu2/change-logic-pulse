import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks that execution is inside a database unit of work opened by this module.
 *
 * Module-private on purpose: it is not re-exported from tenancy.module.ts, so
 * no code outside `src/tenancy/` can enter the scope and satisfy the guard in
 * prisma.ts. Opening a scope is the privilege of the wrapper, not of whoever
 * happens to want a query to run.
 */
export const databaseScope = new AsyncLocalStorage<{
  /** 'auth' is the login lookup, which legitimately has no tenant yet. */
  readonly reason: 'tenant' | 'auth';
  /**
   * Statements issued so far in an 'auth' scope. Maintained by the guard in
   * prisma.ts, which allows that scope exactly one raw statement — the lookup
   * — so the one path with no tenant set cannot be widened into a second query.
   */
  statements?: number;
}>();
