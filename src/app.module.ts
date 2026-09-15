import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { RolesGuard } from './auth/roles.guard.js';
import { ResponsesModule } from './responses/responses.module.js';
import { SummaryModule } from './summary/summary.module.js';
import { SurveysModule } from './surveys/surveys.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';

@Module({
  imports: [TenancyModule, AuthModule, SurveysModule, ResponsesModule, SummaryModule],
  providers: [
    // Order matters: authentication decides who you are, then the role check
    // decides whether that is enough.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
