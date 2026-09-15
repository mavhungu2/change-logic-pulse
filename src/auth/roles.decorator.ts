import { SetMetadata } from '@nestjs/common';
import type { Role } from '../tenancy/contract.js';

export const ROLES = 'auth:roles';

/** Restricts a route to the listed roles. Absent means any authenticated user. */
export const Roles = (...roles: readonly Role[]) => SetMetadata(ROLES, roles);
