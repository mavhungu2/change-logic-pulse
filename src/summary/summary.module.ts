import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { SummaryController } from './summary.controller.js';

@Module({ imports: [TenancyModule], controllers: [SummaryController] })
export class SummaryModule {}
