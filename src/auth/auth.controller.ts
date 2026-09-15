import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Post } from '@nestjs/common';
import { isDevLoginEnabled } from '../config.js';
import type { IdentityReader, MeView } from '../tenancy/contract.js';
import { IDENTITY_READER } from '../tenancy/tokens.js';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(IDENTITY_READER) private readonly identity: IdentityReader,
  ) {}

  /** DEVELOPMENT ONLY — see AuthService. Off unless ENABLE_DEV_LOGIN=true. */
  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown): Promise<{ accessToken: string }> {
    if (!isDevLoginEnabled()) {
      // 404, not 403: an endpoint that issues tokens without a password should
      // not advertise that it exists and is merely switched off.
      throw new NotFoundException();
    }

    const email = (body as { email?: unknown } | null)?.email;
    if (typeof email !== 'string' || email.trim() === '') {
      throw new BadRequestException('email is required');
    }
    return this.auth.login(email.trim());
  }

  @Get('me')
  async me(): Promise<MeView> {
    const view = await this.identity.findMe();
    if (!view) throw new NotFoundException();
    return view;
  }
}
