import { Injectable, type NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import type { Role, TenantContext } from '../tenancy/contract.js';
import { runWithTenantContext } from '../tenancy/tenant-context.js';

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: ReadonlySet<string> = new Set<Role>(['manager', 'member']);

/**
 * A verified signature proves the token came from us. It proves nothing about
 * the shape of what is inside it, and every field here decides something: orgId
 * becomes the tenant the database is scoped to, role decides authorisation, sub
 * becomes the author of anything written.
 *
 * An orgId that is not a uuid reaches set_config and makes the policy's ::uuid
 * cast raise, turning a malformed token into a 500 instead of a 401. An absent
 * exp makes the token immortal, because verification only checks an expiry that
 * is present. Both are refusals, not surprises.
 */
function toTenantContext(claims: unknown): TenantContext | null {
  const candidate = claims as Record<string, unknown> | null;
  if (!candidate) return null;

  const { sub, orgId, role, exp } = candidate;
  if (typeof sub !== 'string' || !UUID.test(sub)) return null;
  if (typeof orgId !== 'string' || !UUID.test(orgId)) return null;
  if (typeof role !== 'string' || !ROLES.has(role)) return null;
  if (typeof exp !== 'number') return null;

  return { userId: sub, orgId, role: role as Role };
}

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

    let claims: unknown;
    try {
      claims = this.jwt.verify(token);
    } catch {
      next();
      return;
    }

    const context = toTenantContext(claims);
    if (!context) {
      // Signed, but not usable. No context is established, so AuthGuard answers
      // 401 — the same as no token at all.
      next();
      return;
    }

    // The tenant comes from the verified token and from nowhere else — never a
    // body, query string, header or route parameter.
    runWithTenantContext(context, next);
  }
}
