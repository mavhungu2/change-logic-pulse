import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';

@Module({
  imports: [
    TenancyModule,
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'dev-only-insecure-secret',
      signOptions: { expiresIn: '12h' },
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
