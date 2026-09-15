import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ResponsesController } from './responses.controller.js';

@Module({ imports: [TenancyModule], controllers: [ResponsesController] })
export class ResponsesModule {}
