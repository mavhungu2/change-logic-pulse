import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthDirectory } from '../tenancy/contract.js';
import { AUTH_DIRECTORY } from '../tenancy/tokens.js';
import type { TokenClaims } from './token.js';

/**
 * Development-only sign-in. There is no password and no identity provider: a
 * seeded email is exchanged for a signed token. It exists to produce the real
 * shape of authorisation — claims, guard, tenant context — without an IdP, and
 * must not survive into anything resembling production.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_DIRECTORY) private readonly directory: AuthDirectory,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string): Promise<{ accessToken: string }> {
    const context = await this.directory.findContextByEmail(email);
    if (!context) {
      // Same response for "no such user" as for any other failure: a login
      // endpoint that distinguishes them enumerates users across tenants.
      throw new UnauthorizedException('Unknown user');
    }

    const claims: TokenClaims = {
      sub: context.userId,
      orgId: context.orgId,
      role: context.role,
    };
    return { accessToken: await this.jwt.signAsync(claims) };
  }
}
