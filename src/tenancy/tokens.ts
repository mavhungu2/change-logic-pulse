/**
 * Injection tokens for the contract's interfaces.
 *
 * They live here rather than in contract.ts so that contract.ts stays free of
 * runtime values — it describes the boundary, it does not participate in it.
 */
export const AUTH_DIRECTORY = Symbol('AuthDirectory');
export const IDENTITY_READER = Symbol('IdentityReader');
