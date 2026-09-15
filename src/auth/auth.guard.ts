import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tenantContext } from '../tenancy/tenant-context.js';
import { IS_PUBLIC } from './public.decorator.js';

/** Registered globally, so a route is protected unless it opts out with @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!tenantContext.peek()) {
      throw new UnauthorizedException('Missing or invalid bearer token');
    }
    return true;
  }
}
