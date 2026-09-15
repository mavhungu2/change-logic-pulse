import { Injectable, type NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { runWithTenantContext } from '../tenancy/tenant-context.js';
import type { TokenClaims } from './token.js';

/**
 * Verifies the bearer token and establishes the request's tenant context.
 *
 * This is middleware rather than a guard because of where AsyncLocalStorage has
 * to be entered. A guard's canActivate() returns before the route handler runs,
 * so a context opened there would already be closed by the time the handler
 * needs it; the only way to make it stick from a guard is enterWith(), which
 * writes into the surrounding async context and can leak one request's tenant
 * into another. Express middleware calls next() from inside the callback, so the
 * entire downstream request — handler, services, database work — runs inside the
 * scope, and it closes when the request does.
 *
 * Authentication is therefore here and authorisation is in AuthGuard: this
 * decides who the caller is, the guard decides whether that is good enough.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly jwt: JwtService) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

    if (!token) {
      // No context is established. The guard turns that into a 401, and any
      // query attempted anyway is refused by the wrapper and by RLS.
      next();
      return;
    }

    let claims: TokenClaims;
    try {
      claims = this.jwt.verify<TokenClaims>(token);
    } catch {
      next();
      return;
    }

    // The tenant comes from the verified token and from nowhere else — never a
    // body, query string, header or route parameter.
    runWithTenantContext(
      { userId: claims.sub, orgId: claims.orgId, role: claims.role },
      next,
    );
  }
}
