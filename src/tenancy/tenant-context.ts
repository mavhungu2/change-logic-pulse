import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantContext, TenantContextAccessor } from './contract.js';
import { TenancyViolation } from './tenancy.errors.js';

const contextStore = new AsyncLocalStorage<TenantContext>();

/**
 * Establishes the request's tenant. Called by the authentication middleware and
 * by tests; never by domain code, which only ever reads.
 *
 * `run` rather than `enterWith`: run() confines the context to this callback and
 * everything it awaits, so it cannot outlive the request. enterWith() writes
 * into the surrounding async context and would leak a tenant to whatever else
 * happens to share it.
 */
export function runWithTenantContext<T>(context: TenantContext, work: () => T): T {
  return contextStore.run(context, work);
}

export const tenantContext: TenantContextAccessor = {
  require(): TenantContext {
    const context = contextStore.getStore();
    if (!context) {
      throw new TenancyViolation(
        'TENANT_CONTEXT_MISSING',
        'No tenant context. Either the request bypassed the authentication ' +
          'middleware, or this ran outside a request without runWithTenantContext().',
      );
    }
    return context;
  },
  peek: () => contextStore.getStore(),
};
