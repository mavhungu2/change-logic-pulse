import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../tenancy/contract.js';
import { tenantContext } from '../tenancy/tenant-context.js';
import { ROLES } from './roles.decorator.js';

/**
 * 403 here, unlike the 404 used for another tenant's resources. The distinction
 * is deliberate: refusing a Member the manager endpoints tells them nothing they
 * do not already know about their own organization, whereas a 403 on another
 * org's survey would confirm that it exists.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly Role[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const tenant = tenantContext.peek();
    if (!tenant) throw new UnauthorizedException('Missing or invalid bearer token');

    if (!required.includes(tenant.role)) {
      throw new ForbiddenException(
        `This endpoint requires the ${required.join(' or ')} role; you are a ${tenant.role}.`,
      );
    }
    return true;
  }
}
