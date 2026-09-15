import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret } from '../config.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';

@Module({
  imports: [
    TenancyModule,
    // registerAsync so the secret is read when the application starts rather
    // than when this file is imported — a missing secret must fail a boot, not
    // an import, and it makes the rule testable.
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: requireJwtSecret(),
        signOptions: { expiresIn: '12h', algorithm: 'HS256' },
        // Pinned: never let the token choose how it is verified.
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TenantContextMiddleware],
})
export class AuthModule implements NestModule {
  // Configured here rather than in AppModule because middleware is instantiated
  // in the module that applies it, and JwtService lives in this one's context.
  configure(consumer: MiddlewareConsumer): void {
    // Every route, login included: the middleware only establishes context, and
    // AuthGuard decides whether a route may proceed without it.
    consumer.apply(TenantContextMiddleware).forRoutes('*splat');
  }
}
