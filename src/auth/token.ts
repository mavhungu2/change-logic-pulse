import type { Role } from '../tenancy/contract.js';

/** The claims the API signs and trusts. Nothing else may decide the tenant. */
export interface TokenClaims {
  readonly sub: string;
  readonly orgId: string;
  readonly role: Role;
}
